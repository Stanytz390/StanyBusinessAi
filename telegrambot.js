import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

// Weka Token ya Telegram Bot kutoka kwa BotFather
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'WEKA_TOKEN_YAKO_HAPA';
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// BADILISHA LINK HAPA CHINI NA YA HEROKU APP YAKO
const API_URL = 'https://herokuapp.com';

// Kuhifadhi hatua za mtumiaji (Session states kwenye RAM)
const userState = new Map();

console.log("🤖 Telegram Linker Bot iko tayari...");

// Mtu akianza na /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "👋 Karibu kwenye *Stany Max AI Linker Bot*!\n\nMfumo huu unakusaidia kupata pairing code ya kuwasha WhatsApp Business AI Bot yako.\n\nKuanza, tafadhali andika *Jina la Biashara* yako au jina lako:");
    userState.set(chatId, { step: 'AWAITING_NAME' });
});

// Kupokea text zote kutoka kwa mtumiaji
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';

    if (text.startsWith('/')) return; // Puuza amri za kuanza na slashi

    const state = userState.get(chatId);
    if (!state) return;

    // STEP 1: Kupokea Jina
    if (state.step === 'AWAITING_NAME') {
        state.name = text;
        state.step = 'AWAITING_NUMBER';
        userState.set(chatId, state);
        
        bot.sendMessage(chatId, `Asante *${text}*.\n\nSasa tafadhali tuma *Namba yako ya WhatsApp* (Mfano: 0712345678):`);
    } 
    // STEP 2: Kupokea Namba na Kuita API ya Heroku
    else if (state.step === 'AWAITING_NUMBER') {
        state.number = text;
        userState.delete(chatId); // Futa state ili asirudie bila kuanza upya

        bot.sendMessage(chatId, "⏳ Tunawasiliana na WhatsApp kuzalisha kodi yako. Tafadhali subiri sekunde chache...");

        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: state.name, number: state.number })
            });

            const data = await response.json();

            if (data.status) {
                const successMsg = `🎉 *KODI IMETENGENEZWA!* 🎉\n\n` +
                                   `🔑 Code: \`${data.code}\`\n\n` +
                                   `*Jinsi ya kutumia:*\n` +
                                   `1. Fungua WhatsApp kwenye simu yako.\n` +
                                   `2. Nenda kwenye *Linked Devices* (Vifaa Vilivyounganishwa).\n` +
                                   `3. Bonyeza *Link a Device* kisha chagua *Link with phone number instead*.\n` +
                                   `4. Ingiza hiyo kodi ya tarakimu 8 hapo juu.\n\n` +
                                   `Bot yako itakuwa hewani saa 24/7! 🚀`;
                
                bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, `❌ Imeshindikana kupata kodi.\nSababu: ${data.error}\n\nAndika /start kujaribu tena.`);
            }
        } catch (error) {
            bot.sendMessage(chatId, "❌ Hitilafu imetokea wakati wa kuwasiliana na server kuu ya Heroku. Hakikisha Heroku ipo hewani.");
        }
    }
});
