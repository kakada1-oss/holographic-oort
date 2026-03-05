require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const axios = require("axios");
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;

// --- Configuration ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o";
const MAX_HISTORY = 30;
const KEEP_RECENT = 20;
const CONCURRENCY_LIMIT = 1; // Max concurrent requests per chat

if (!TOKEN || !API_KEY) {
    console.error("❌ TELEGRAM_BOT_TOKEN or OPENAI_API_KEY not set in .env");
    process.exit(1);
}

// --- Initialize Bot & AI ---
const bot = new TelegramBot(TOKEN, { 
    polling: { 
        interval: 300,
        autoStart: true,
        params: {
            timeout: 30
        }
    }
});

const client = new OpenAI({ 
    apiKey: API_KEY,
    maxRetries: 3,
    timeout: 30000
});

console.log("🤖 ChatGPT Bot started.");

// --- State Management ---
const conversations = new Map();
const processing = new Map(); // chatId -> { count, timestamp }
const PROCESSING_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// --- Helper Functions ---

/**
 * Initialize conversation history for a chat
 */
function initConversation(chatId) {
    if (!conversations.has(chatId)) {
        conversations.set(chatId, [{ 
            role: "system", 
            content: "You are a helpful and clear AI assistant. You answer concisely unless requested otherwise. You have access to tools." 
        }]);
    }
}

/**
 * Update conversation history with automatic cleanup
 */
function updateHistory(chatId, role, content, tool_calls = null, tool_call_id = null) {
    initConversation(chatId);
    const history = conversations.get(chatId);

    const msg = { role, content };
    if (tool_calls) msg.tool_calls = tool_calls;
    if (tool_call_id) msg.tool_call_id = tool_call_id;

    history.push(msg);

    // Smart history management: Keep last KEEP_RECENT messages + system prompt
    if (history.length > MAX_HISTORY) {
        const sys = history[0];
        const recent = history.slice(-KEEP_RECENT);
        conversations.set(chatId, [sys, ...recent]);
    }
}

/**
 * Check if chat is currently processing
 */
function isProcessing(chatId) {
    const state = processing.get(chatId);
    if (!state) return false;
    
    // Clear stale processing states
    if (Date.now() - state.timestamp > PROCESSING_TIMEOUT) {
        processing.delete(chatId);
        return false;
    }
    
    return state.count >= CONCURRENCY_LIMIT;
}

/**
 * Set processing state
 */
function setProcessing(chatId, active = true) {
    if (active) {
        const state = processing.get(chatId) || { count: 0, timestamp: Date.now() };
        state.count++;
        state.timestamp = Date.now();
        processing.set(chatId, state);
    } else {
        const state = processing.get(chatId);
        if (state) {
            state.count--;
            if (state.count <= 0) processing.delete(chatId);
        }
    }
}

// --- Command Handlers ---

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        "👋 Hi! I am ChatGPT.\n\n" +
        "📝 Send me any text or a photo, and I will respond.\n" +
        "📊 I can search and send Excel files from your computer.\n" +
        "🔄 Use /clear to reset our conversation."
    );
});

bot.onText(/\/clear/, (msg) => {
    conversations.delete(msg.chat.id);
    processing.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, "✅ Context cleared. Let's start fresh!");
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
        "📖 **Available Commands:**\n\n" +
        "/start - Start the bot\n" +
        "/clear - Clear conversation history\n" +
        "/help - Show this help message\n\n" +
        "💡 **Tips:**\n" +
        "• Send text or photos\n" +
        "• Ask me to find Excel files\n" +
        "• I remember our conversation context"
    );
});

// --- Photo Handler (Vision) ---

bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    
    if (isProcessing(chatId)) {
        bot.sendMessage(chatId, "⏳ Please wait, I'm still working on your previous request...");
        return;
    }

    const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
    const caption = msg.caption || "What is in this image?";

    setProcessing(chatId, true);

    try {
        await bot.sendChatAction(chatId, "typing");

        const file = await bot.getFile(photo.file_id);
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

        const response = await axios.get(url, { 
            responseType: "arraybuffer",
            timeout: 10000,
            maxContentLength: 20 * 1024 * 1024 // 20MB limit
        });
        
        const base64Image = Buffer.from(response.data, "binary").toString("base64");

        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: caption },
                    {
                        type: "image_url",
                        image_url: { 
                            url: `data:image/jpeg;base64,${base64Image}`,
                            detail: "auto"
                        }
                    }
                ]
            }
        ];

        const completion = await client.chat.completions.create({
            model: MODEL,
            messages: messages,
            max_tokens: 1000
        });

        const reply = completion.choices[0].message.content;
        await bot.sendMessage(chatId, reply);

        updateHistory(chatId, "user", `[User sent an image with caption: ${caption}]`);
        updateHistory(chatId, "assistant", reply);

    } catch (err) {
        console.error("Photo Error:", err.message);
        const errorMsg = err.response?.status === 413 
            ? "Sorry, that image is too large. Please try with a smaller image." 
            : "Sorry, I couldn't process that image.";
        await bot.sendMessage(chatId, errorMsg);
    } finally {
        setProcessing(chatId, false);
    }
});

// --- Text Handler ---

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore commands and non-text
    if (!text || text.startsWith("/")) return;

    if (isProcessing(chatId)) {
        await bot.sendMessage(chatId, "⏳ Please wait, I'm still working on your previous request...");
        return;
    }

    setProcessing(chatId, true);

    try {
        await bot.sendChatAction(chatId, "typing");
        initConversation(chatId);
        updateHistory(chatId, "user", text);

        const tools = [
            {
                type: "function",
                function: {
                    name: "find_and_send_excel",
                    description: "Find an Excel file (.xls, .xlsx) by name and optional folder, then send it via Telegram.",
                    parameters: {
                        type: "object",
                        properties: {
                            fileName: { 
                                type: "string", 
                                description: "The name or part of the filename to search for, e.g. 'Price List'" 
                            },
                            folderName: { 
                                type: "string", 
                                description: "Optional folder name where the file might be located, e.g. 'Downloads'" 
                            }
                        },
                        required: []
                    },
                },
            }
        ];

        let completion = await client.chat.completions.create({
            model: MODEL,
            messages: conversations.get(chatId),
            tools: tools,
            tool_choice: "auto",
            temperature: 0.7,
            max_tokens: 1000
        });

        let responseMessage = completion.choices[0].message;

        if (responseMessage.tool_calls) {
            updateHistory(chatId, "assistant", responseMessage.content, responseMessage.tool_calls);

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "find_and_send_excel") {
                    await handleExcelSearch(chatId, toolCall);
                } else {
                    updateHistory(chatId, "tool", "Error: Unknown tool called.", null, toolCall.id);
                }
            }

            // Get final response after tool execution
            completion = await client.chat.completions.create({
                model: MODEL,
                messages: conversations.get(chatId),
                temperature: 0.7,
                max_tokens: 1000
            });
            responseMessage = completion.choices[0].message;
        }

        const reply = responseMessage.content;
        if (reply) {
            updateHistory(chatId, "assistant", reply);
            await bot.sendMessage(chatId, reply);
        }
    } catch (err) {
        console.error("Text Error:", err.message);
        const errorMsg = err.code === "ETIMEDOUT" || err.code === "ECONNRESET"
            ? "I'm experiencing connection issues. Please try again in a moment."
            : "I'm having trouble thinking right now. Please try again later.";
        await bot.sendMessage(chatId, errorMsg);
    } finally {
        setProcessing(chatId, false);
    }
});

/**
 * Handle Excel file search tool
 */
async function handleExcelSearch(chatId, toolCall) {
    const execAsync = util.promisify(exec);
    
    try {
        const args = JSON.parse(toolCall.function.arguments || "{}");
        const fileName = (args.fileName || "").replace(/['"]/g, "").trim();
        const folderName = (args.folderName || "").replace(/['"]/g, "").trim();

        await bot.sendMessage(chatId, 
            `🔍 Searching for ${fileName ? `"${fileName}"` : "an Excel file"}${folderName ? ` in "${folderName}"` : ""}...`
        );

        // Optimized PowerShell command with better error handling
        const psCmd = `
            $ErrorActionPreference = 'SilentlyContinue'
            $filter = if ('${fileName}') { "*${fileName}*.xls*" } else { "*.xls*" }
            $files = Get-ChildItem -Path "$env:USERPROFILE" -Filter $filter -Recurse -File -ErrorAction SilentlyContinue
            if ($files) {
                if ('${folderName}') {
                    $files = $files | Where-Object { $_.DirectoryName -like '*${folderName}*' }
                }
                if ($files.Count -gt 0) {
                    Write-Output $files[0].FullName
                } elseif ($files.Count -eq 1) {
                    Write-Output $files.FullName
                }
            }
        `.trim();

        const b64Script = Buffer.from(psCmd, 'utf16le').toString('base64');
        const cmd = `powershell -ExecutionPolicy Bypass -NoProfile -EncodedCommand ${b64Script}`;

        const { stdout, stderr } = await execAsync(cmd, {
            timeout: 30000, // 30s timeout
            maxBuffer: 5 * 1024 * 1024 // 5MB buffer
        });

        const filePath = stdout.trim();

        if (filePath && filePath !== "" && await fileExists(filePath)) {
            await bot.sendDocument(chatId, filePath);
            updateHistory(chatId, "tool", `Successfully found and sent file: ${filePath}`, null, toolCall.id);
        } else {
            updateHistory(chatId, "tool", "No Excel file matching the search criteria was found.", null, toolCall.id);
            await bot.sendMessage(chatId, 
                "❌ No matching file found.\n\n" +
                "💡 Tips:\n" +
                "• Use more specific filename keywords\n" +
                "• Try without specifying a folder\n" +
                "• Check if the file exists in your user directory"
            );
        }
    } catch (error) {
        console.error("Tool execution error:", error);
        updateHistory(chatId, "tool", "An error occurred while searching for the file.", null, toolCall.id);
        
        let errorMsg = "⚠️ An error occurred while searching for the file.";
        if (error.code === 'ETIMEDOUT') {
            errorMsg = "⏱️ Search timed out. The file search took too long. Please try a more specific filename.";
        }
        await bot.sendMessage(chatId, errorMsg);
    }
}

/**
 * Check if file exists asynchronously
 */
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

console.log("✅ Bot is ready at https://t.me/your_bot_name (use your own token link)");
