require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const axios = require("axios");

// --- Configuration ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o";

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
const client = new OpenAI({ apiKey: API_KEY });

console.log("🤖 ChatGPT Bot started.");

// Store conversation history in memory (chatId -> array of messages)
const conversations = new Map();

// Helper to keep history manageable
function updateHistory(chatId, role, content, tool_calls = null, tool_call_id = null) {
    if (!conversations.has(chatId)) {
        conversations.set(chatId, [{ role: "system", content: "You are a helpful and clear AI assistant. You answer concisely unless requested otherwise. You have access to tools." }]);
    }
    const history = conversations.get(chatId);

    let msg = { role, content };
    if (tool_calls) msg.tool_calls = tool_calls;
    if (tool_call_id) msg.tool_call_id = tool_call_id;

    history.push(msg);

    // Limit memory: Keep last 20 messages to avoid cutting tool call pairs easily
    if (history.length > 30) {
        const sys = history[0];
        const recent = history.slice(-20);
        conversations.set(chatId, [sys, ...recent]);
    }
}

// --- Command Handlers ---

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Hi! I am ChatGPT. Send me any text or a photo, and I will respond.");
});

bot.onText(/\/clear/, (msg) => {
    conversations.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, "Context cleared. Let's start fresh!");
});

// --- Photo Handler (Vision) ---

bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution photo
    const caption = msg.caption || "What is in this image?";

    try {
        bot.sendChatAction(chatId, "typing");

        const file = await bot.getFile(photo.file_id);
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

        const response = await axios.get(url, { responseType: "arraybuffer" });
        const base64Image = Buffer.from(response.data, "binary").toString("base64");

        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: caption },
                    {
                        type: "image_url",
                        image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                    }
                ]
            }
        ];

        const completion = await client.chat.completions.create({
            model: MODEL,
            messages: messages,
        });

        const reply = completion.choices[0].message.content;
        bot.sendMessage(chatId, reply);

        // Update history for subsequent text-only chats
        updateHistory(chatId, "user", `[User sent an image with caption: ${caption}]`);
        updateHistory(chatId, "assistant", reply);

    } catch (err) {
        console.error("Photo Error:", err.message);
        bot.sendMessage(chatId, "Sorry, I couldn't process that image.");
    }
});

// --- Text Handler ---

const processing = new Set();

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore commands and non-text
    if (!text || text.startsWith("/")) return;

    if (processing.has(chatId)) {
        bot.sendMessage(chatId, "⏳ Please wait, I'm still working on your previous request...");
        return;
    }
    processing.add(chatId);

    try {
        bot.sendChatAction(chatId, "typing");
        updateHistory(chatId, "user", text);

        const tools = [
            {
                type: "function",
                function: {
                    name: "find_and_send_excel",
                    description: "Find an Excel file (.xls, .xlsx) on the computer and send it to the user via Telegram.",
                    parameters: {
                        type: "object",
                        properties: {
                            fileName: { type: "string", description: "The name of the file to search for, e.g. 'Stock + Price List'" },
                            folderName: { type: "string", description: "The name of the folder where the file might be located, e.g. 'Telegram'" }
                        },
                    },
                },
            }
        ];

        let completion = await client.chat.completions.create({
            model: MODEL,
            messages: conversations.get(chatId),
            tools: tools,
            tool_choice: "auto",
        });

        let responseMessage = completion.choices[0].message;

        if (responseMessage.tool_calls) {
            updateHistory(chatId, "assistant", responseMessage.content, responseMessage.tool_calls);

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "find_and_send_excel") {
                    try {
                        const args = JSON.parse(toolCall.function.arguments || "{}");
                        const fileName = (args.fileName || "").replace(/['"]/g, "");
                        const folderName = (args.folderName || "").replace(/['"]/g, "");

                        bot.sendMessage(chatId, `🔍 Searching for ${fileName ? `"${fileName}"` : "an Excel file"}${folderName ? ` in "${folderName}"` : ""}...`);

                        const util = require('util');
                        const { exec } = require('child_process');
                        const execAsync = util.promisify(exec);

                        // We use a base64 encoded command because it completely mitigates quotes/special chars issues in the node shell exec layer
                        const psCmd = `
                        $ErrorActionPreference = 'SilentlyContinue'
                        $files = Get-ChildItem -Path "$env:USERPROFILE" -Filter "*${fileName}*.xls*" -Recurse -File
                        if ('${folderName}') {
                            $files = $files | Where-Object { $_.DirectoryName -match '${folderName}' }
                        }
                        if ($files) {
                            if ($files.Count -gt 0) { Write-Output $files[0].FullName }
                            else { Write-Output $files.FullName }
                        }
                        `.trim();

                        const b64Script = Buffer.from(psCmd, 'utf16le').toString('base64');
                        const cmd = `powershell -ExecutionPolicy Bypass -NoProfile -EncodedCommand ${b64Script}`;

                        const { stdout } = await execAsync(cmd);
                        const filePath = stdout.trim();

                        if (filePath && filePath !== "") {
                            await bot.sendDocument(chatId, filePath);
                            updateHistory(chatId, "tool", `Successfully found and sent file: ${filePath}`, null, toolCall.id);
                        } else {
                            updateHistory(chatId, "tool", "No Excel file matching the search criteria was found.", null, toolCall.id);
                            bot.sendMessage(chatId, "❌ I couldn't find any file matching your criteria. Try being more brief with the name.");
                        }
                    } catch (error) {
                        console.error("Tool execution error:", error);
                        updateHistory(chatId, "tool", "An error occurred while searching for the file.", null, toolCall.id);
                        bot.sendMessage(chatId, "⚠️ An error occurred while searching for the file.");
                    }
                } else {
                    // OpenAI requires responding properly to EVERY tool_call_id
                    updateHistory(chatId, "tool", "Error: Unknown tool called.", null, toolCall.id);
                }
            }

            // Get a new completion after the tool call
            completion = await client.chat.completions.create({
                model: MODEL,
                messages: conversations.get(chatId),
            });
            responseMessage = completion.choices[0].message;
        }

        const reply = responseMessage.content;
        if (reply) {
            updateHistory(chatId, "assistant", reply);
            bot.sendMessage(chatId, reply);
        }
    } catch (err) {
        console.error("Text Error:", err.message);
        bot.sendMessage(chatId, "I'm having trouble thinking right now. Please try again later.");
    } finally {
        processing.delete(chatId);
    }
});

console.log("✅ Bot is ready at https://t.me/your_bot_name (use your own token link)");
