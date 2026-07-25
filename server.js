import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import mongoose from 'mongoose';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Owner } from './models.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Unganisha na MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI;
await mongoose.connect(MONGO_URI);
console.log("✅ MongoDB imeunganishwa salama kwenye Heroku!");

// Ramani ya kushikilia WhatsApp connections zote zilizo hai kwenye RAM
const activeSessions = new Map();

/**
 * 🔄 ANZISHA BOT YA MFANYABIASHARA BINAFSI SAA 24/7
 */
async function startOwnerBot(ownerData) {
    const { ownerNumber, ownerName } = ownerData;

    // Kumbuka: Heroku inafuta ma-file ya ndani (Ephemeral File System) ikijizima/Iki-restart (Dyno Sleep).
    // Ili session isipotee kabisa, inapendekezwa kuhifadhi Auth data kwenye MongoDB.
    // Lakini kwa sasa, tunahifadhi kwenye folda la './sessions/' ambalo linatosha kwa matumizi ya sasa.
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${ownerNumber}`);

    const sock = makeWASocket.default({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, // Tunatumia Pairing Code pekee!
        browser: ["Ubuntu", "Chrome", "20.0.0"]
    });

    // Hifadhi session kwenye memory (RAM)
    activeSessions.set(ownerNumber, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            console.log(`🔌 Connection ilifungwa kwa ${ownerName} (${ownerNumber}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startOwnerBot(ownerData); // Fufua bot kiotomatiki isizime
            }
        } else if (connection === 'open') {
            console.log(`🚀 BOT IKO LIVE 24/7 kwa ajili ya: ${ownerName} [${ownerNumber}]`);
        }
    });

    // 📩 USHUGHULIKIAJI WA MESEJI ZA WATEJA WA MFANYABIASHARA HUYU
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderId = msg.key.remoteJid; // Namba ya mteja anayeandika
        const clientName = msg.pushName || "Mteja"; // Jina halisi la WhatsApp la mteja
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();

        // Tafuta mipangilio mipya ya huyu Owner kutoka MongoDB kila wakati
        const currentOwner = await Owner.findOne({ ownerNumber });
        if (!currentOwner) return;

        // Amri za kuseti Biashara (Zinatumiwa na Owner Mwenyewe kwenye WhatsApp Yake)
        if (msg.key.remoteJid.includes(ownerNumber)) {
            // 1. .set business [Jina]
            if (body.startsWith('.set business ')) {
                const bName = body.replace('.set business ', '');
                currentOwner.businessName = bName;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Jina la biashara limebadilishwa kuwa: *${bName}*` });
                return;
            }
            // 2. .set welcome [Ujumbe]
            if (body.startsWith('.set welcome ')) {
                const wMsg = body.replace('.set welcome ', '');
                currentOwner.welcomeMessage = wMsg;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Ujumbe wa kukaribisha wateja umesasishwa!` });
                return;
            }
            // 3. .add service Namba|Jina|Maelezo|Bei|PichaURL
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
                    await sock.sendMessage(senderId, { text: `✅ Huduma ya *${parts[1].trim()}* imeongezwa kwenye mfumo!` });
                    return;
                }
            }
        }

        // --- AUTOMATION KWA AJILI YA MTEJA WA KAWAIDA ---
        const lowerBody = body.toLowerCase();
        const triggerWords = ['mambo', 'habari', 'hello', 'hi', 'menu', 'mambo vipi', 'habari yako'];

        // A: MENU KUU
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

        // B: MTEJA AKICHAGUA HUDUMA MAALUMU
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

        // C: CHAGUZI ZA MWISHO (W au M)
        if (lowerBody === 'w') {
            await sock.sendMessage(senderId, { text: "📞 Ombi lako limepokelewa. Mtoa huduma wetu wa kibinadamu anakwenda kuwasiliana na wewe hivi punde. Tafadhali subiri kidogo!" });
        } else if (lowerBody === 'm') {
            let servicesList = "";
            currentOwner.services.forEach(srv => {
                servicesList += `👉 Bonyeza *${srv.keyword}* : ${srv.name}\n`;
            });
            await sock.sendMessage(senderId, { text: `📋 *MAIN MENU - ${currentOwner.businessName}*\n\n${servicesList}` });
        }
    });
}

/**
 * 🌐 EXPRESS API: INAITWA NA TELEGRAM AU WEBSITE KULETA MTU MPYA
 * POST /api/pair
 * Body: { "name": "Stany Max", "number": "0712345678" }
 */
app.post('/api/pair', async (req, res) => {
    const { name, number } = req.body;
    if (!name || !number) {
        return res.status(400).json({ status: false, error: "Jina na namba ya simu yanatakiwa!" });
    }

    // Safisha namba ianze na 255
    let formattedNumber = number.replace('+', '').replace(/\s+/g, '');
    if (formattedNumber.startsWith('0')) {
        formattedNumber = '255' + formattedNumber.substring(1);
    }

    try {
        let owner = await Owner.findOne({ ownerNumber: formattedNumber });
        if (!owner) {
            owner = new Owner({
                ownerName: name,
                ownerNumber: formattedNumber,
                services: [
                    { keyword: "1", name: "Sample Service", description: "Badilisha maelezo haya kwa kutumia amri ya .add service", price: "TSH 10,000" }
                ]
            });
            await owner.save();
        }

        // Washa engine yake kwenye RAM
        await startOwnerBot(owner);

        // Subiri sekunde 4 kisha omba Pairing Code kutoka WhatsApp
        setTimeout(async () => {
            const sock = activeSessions.get(formattedNumber);
            if (sock) {
                try {
                    const pairingCode = await sock.requestPairingCode(formattedNumber);
                    return res.status(200).json({
                        status: true,
                        message: "Ingiza kodi hii kwenye WhatsApp yako -> Linked Devices",
                        code: pairingCode
                    });
                } catch (codeErr) {
                    return res.status(500).json({ status: false, error: "Imeshindikana kuzalisha kodi. Jaribu tena." });
                }
            } else {
                return res.status(500).json({ status: false, error: "Connection initialization failed." });
            }
        }, 4000);

    } catch (error) {
        return res.status(500).json({ status: false, error: error.message });
    }
});

/**
 * ⚡ AUTOSTART BOTS ZOTE ZILIZOPO SERVERNIKIWASHA (Heroku Dyno Wake Up)
 */
async function bootUpAllRegisteredBots() {
    try {
        const allOwners = await Owner.find({});
        console.log(`⚙️ Inapakia na kuwasha bots [${allOwners.length}] zilizo kwenye database...`);
        for (let owner of allOwners) {
            await startOwnerBot(owner);
        }
    } catch (err) {
        console.error("Ufufuaji wa bots ulifeli:", err);
    }
}

