import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import mongoose from 'mongoose';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
// ✅ Marekebisho: 'models.js' imebadilishwa kuwa 'model.js' (ulingane na jina halisi)
import { Owner } from './model.js'; 

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// =============================================
// 1. UNGANISHA NA MONGODB (Ikiwa haipo, ita-crash vizuri)
// =============================================
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error("❌ KOSA: MONGO_URI haipo kwenye environment variables!");
    process.exit(1);
}

// Top-level await inaruhusiwa kwa sababu "type": "module"
await mongoose.connect(MONGO_URI);
console.log("✅ MongoDB imeunganishwa salama kwenye Heroku!");

// Ramani ya kushikilia WhatsApp connections
const activeSessions = new Map();

// =============================================
// 2. ANZISHA BOT YA MFANYABIASHARA (24/7)
// =============================================
async function startOwnerBot(ownerData) {
    const { ownerNumber, ownerName } = ownerData;
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${ownerNumber}`);

    // ✅ FIX: remove .default – makeWASocket is already the function
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.0"]
    });

    activeSessions.set(ownerNumber, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            console.log(`🔌 Connection ilifungwa kwa ${ownerName}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startOwnerBot(ownerData);
        } else if (connection === 'open') {
            console.log(`🚀 BOT IKO LIVE 24/7: ${ownerName} [${ownerNumber}]`);
        }
    });

    // 📩 USHUGHULIKIAJI WA MESEJI
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderId = msg.key.remoteJid;
        const clientName = msg.pushName || "Mteja";
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();

        const currentOwner = await Owner.findOne({ ownerNumber });
        if (!currentOwner) return;

        // Amri za Owner
        if (msg.key.remoteJid.includes(ownerNumber)) {
            if (body.startsWith('.set business ')) {
                const bName = body.replace('.set business ', '');
                currentOwner.businessName = bName;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Jina la biashara limebadilishwa kuwa: *${bName}*` });
                return;
            }
            if (body.startsWith('.set welcome ')) {
                const wMsg = body.replace('.set welcome ', '');
                currentOwner.welcomeMessage = wMsg;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Ujumbe wa kukaribisha wateja umesasishwa!` });
                return;
            }
            if (body.startsWith('.add service ')) {
                const parts = body.replace('.add service ', '').split('|');
                if (parts.length >= 4) {
                    currentOwner.services.push({
                        keyword: parts[0].trim(),
                        name: parts[1].trim(),
                        description: parts[2].trim(),
                        price: parts[3].trim(),
                        imageUrl: parts[4] ? parts[4].trim() : ""
                    });
                    await currentOwner.save();
                    await sock.sendMessage(senderId, { text: `✅ Huduma ya *${parts[1].trim()}* imeongezwa!` });
                    return;
                }
            }
        }

        // AUTOMATION KWA MTEJA
        const lowerBody = body.toLowerCase();
        const triggerWords = ['mambo', 'habari', 'hello', 'hi', 'menu', 'mambo vipi', 'habari yako'];

        if (triggerWords.includes(lowerBody)) {
            let servicesList = "";
            currentOwner.services.forEach(srv => {
                servicesList += `👉 Bonyeza *${srv.keyword}* : kupata ${srv.name}\n`;
            });

            const welcomeText = `Habari ya wakati huu ndugu *${clientName}*! 👋\n\n` +
                `Mimi ni AI Msaidizi wa *${currentOwner.businessName}*.\n` +
                `${currentOwner.welcomeMessage}\n\n` +
                `*ANGALIA HUDUMA ZETU HAPA CHINI:* 👇\n\n` +
                `${servicesList}\n` +
                `-----------------------------------\n` +
                `*Ushauri:* Chagua na utume namba ya huduma unayotaka hapo juu. ✨`;

            await sock.sendMessage(senderId, { text: welcomeText });
            return;
        }

        const selectedService = currentOwner.services.find(srv => srv.keyword === body);
        if (selectedService) {
            const serviceMessage = `✨ *HUDUMA: ${selectedService.name}* ✨\n\n` +
                `📝 *Maelezo:* ${selectedService.description}\n\n` +
                `💰 *Bei yetu:* ${selectedService.price}\n\n` +
                `-----------------------------------\n` +
                `💡 *NIFANYE NINI SASA?*\n` +
                `👉 Tuma *W* : Kuwasiliana na Mtoa Huduma (Live Chat)\n` +
                `👉 Tuma *M* : Kurudi Main Menu`;

            if (selectedService.imageUrl) {
                await sock.sendMessage(senderId, { image: { url: selectedService.imageUrl }, caption: serviceMessage });
            } else {
                await sock.sendMessage(senderId, { text: serviceMessage });
            }
            return;
        }

        if (lowerBody === 'w') {
            await sock.sendMessage(senderId, { text: "📞 Ombi lako limepokelewa. Mtoa huduma wetu wa kibinadamu anakwenda kuwasiliana na wewe hivi punde!" });
        } else if (lowerBody === 'm') {
            let servicesList = "";
            currentOwner.services.forEach(srv => {
                servicesList += `👉 Bonyeza *${srv.keyword}* : ${srv.name}\n`;
            });
            await sock.sendMessage(senderId, { text: `📋 *MAIN MENU - ${currentOwner.businessName}*\n\n${servicesList}` });
        }
    });
}

// =============================================
// 3. LOGIKI YA PAIRING CODE (Inatumiwa na Website na Telegram)
// =============================================
async function corePairingLogic(name, number) {
    let formattedNumber = number.replace('+', '').replace(/\s+/g, '');
    if (formattedNumber.startsWith('0')) {
        formattedNumber = '255' + formattedNumber.substring(1);
    }

    let owner = await Owner.findOne({ ownerNumber: formattedNumber });
    if (!owner) {
        owner = new Owner({
            ownerName: name,
            ownerNumber: formattedNumber,
            services: [
                { keyword: "1", name: "Sample Service", description: "Tumia amri ya .add service kubadilisha haya", price: "TSH 10,000" }
            ]
        });
        await owner.save();
    }

    // Anzisha bot kabla ya kuomba code
    await startOwnerBot(owner);

    return new Promise((resolve, reject) => {
        setTimeout(async () => {
            const sock = activeSessions.get(formattedNumber);
            if (sock) {
                try {
                    const pairingCode = await sock.requestPairingCode(formattedNumber);
                    resolve({ status: true, code: pairingCode });
                } catch (err) {
                    reject({ status: false, error: "WhatsApp dynamic code generation failed." });
                }
            } else {
                reject({ status: false, error: "Session init failed." });
            }
        }, 4000);
    });
}

// =============================================
// 4. ROUTES ZA WEBSITE (API)
// =============================================
app.post('/api/pair', async (req, res) => {
    const { name, number } = req.body;
    if (!name || !number) return res.status(400).json({ status: false, error: "Jina na namba yanatakiwa!" });

    try {
        const result = await corePairingLogic(name, number);
        return res.status(200).json(result);
    } catch (err) {
        return res.status(500).json(err);
    }
});

// Route ya kutumikia index.html (muhimu sana!)
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: '.' });
});

// =============================================
// 5. AUTOSTART BOTS ZOTE SERVER IKIZINDUKA
// =============================================
async function bootUpAllRegisteredBots() {
    const allOwners = await Owner.find({});
    console.log(`⚙️ Inapakia na kuwasha bots [${allOwners.length}] kutoka kwenye database...`);
    for (let owner of allOwners) {
        await startOwnerBot(owner);
    }
}
bootUpAllRegisteredBots();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌍 Server API inakimbia kwenye Port: ${PORT}`));

// =============================================
// 6. SEHEMU YA TELEGRAM BOT (IMEKAMILISHWA SASA)
// =============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (TELEGRAM_TOKEN) {
    const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    const userState = new Map();
    console.log("🤖 Telegram Linker Engine imewashwa rasmi!");

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "👋 Karibu kwenye *Stany Max AI Linker Bot*!\n\nTafadhali andika *Jina la Biashara* yako au jina lako ili kuanza:");
        userState.set(chatId, { step: 'AWAITING_NAME' });
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text ? msg.text.trim() : '';
        if (text.startsWith('/')) return;

        const state = userState.get(chatId);
        if (!state) return;

        // HATUA YA 1: Kupata Jina
        if (state.step === 'AWAITING_NAME') {
            state.name = text;
            state.step = 'AWAITING_NUMBER';
            userState.set(chatId, state);
            bot.sendMessage(chatId, `✅ Jina "${text}" limehifadhiwa. Sasa tafadhali andika *namba yako ya WhatsApp* (bila +, mfano: 255712345678):`);
            return;
        }

        // HATUA YA 2: Kupata Namba na kutuma Pairing Code
        if (state.step === 'AWAITING_NUMBER') {
            const number = text;
            const name = state.name;
            userState.delete(chatId); // Safisha hali

            bot.sendMessage(chatId, `⏳ Inachakata ombi lako kwa ${name}... tafadhali subiri sekunde chache.`);

            try {
                const result = await corePairingLogic(name, number);
                if (result.status) {
                    bot.sendMessage(chatId, `✅ *PAIRING CODE YAKO:* \`${result.code}\`\n\nTumia namba hii kuunganisha WhatsApp yako.`);
                } else {
                    bot.sendMessage(chatId, `❌ Imeshindwa: ${result.error || 'Tatizo la mtandao au server.'}`);
                }
            } catch (err) {
                bot.sendMessage(chatId, `❌ Kosa: ${err.error || err.message || 'Jaribu tena baadae.'}`);
            }
        }
    });
} else {
    console.log("⚠️ TELEGRAM_TOKEN haijapatikana, Telegram Bot haitawashwa.");
}