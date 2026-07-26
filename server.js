import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import mongoose from 'mongoose';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import { Owner } from './models.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// =============================================
// 1. UNGANISHA NA MONGODB
// =============================================
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error("❌ KOSA: MONGO_URI haipo kwenye environment variables!");
    process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log("✅ MongoDB imeunganishwa salama!");

// =============================================
// 2. RAMANI YA SESSIONS ZA WHATSAPP
// =============================================
const activeSessions = new Map();

// =============================================
// 3. CHECK WORKING HOURS
// =============================================
function isWithinWorkingHours(owner) {
    if (!owner.workingHoursStart || !owner.workingHoursEnd) return true;
    
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    const start = owner.workingHoursStart;
    const end = owner.workingHoursEnd;
    
    return currentTime >= start && currentTime <= end;
}

// =============================================
// 4. ANZISHA BOT YA MFANYABIASHARA (NO RECONNECT!)
// =============================================
async function startOwnerBot(ownerData) {
    const { ownerNumber, ownerName } = ownerData;
    
    // Hakikisha folder ya sessions ipo
    const sessionDir = `./sessions/${ownerNumber}`;
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.0"]
    });

    activeSessions.set(ownerNumber, sock);
    sock.ev.on('creds.update', saveCreds);

    // ============================================
    // CONNECTION UPDATE - NO RECONNECT!
    // ============================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            console.log(`🔌 Connection ilifungwa kwa ${ownerName} [${ownerNumber}]. HAKUNA RECONNECT!`);
            // Hakuna reconnect - tunaondoa session tu
            if (activeSessions.has(ownerNumber)) {
                activeSessions.delete(ownerNumber);
            }
            return;
        }
        
        if (connection === 'open') {
            console.log(`🚀 BOT IKO LIVE: ${ownerName} [${ownerNumber}]`);
            
            // ============================================
            // TUMA WELCOME MESSAGE KWA OWNER
            // ============================================
            try {
                const ownerJid = ownerNumber + '@s.whatsapp.net';
                const welcomeMsg = `🤖 *Karibu ${ownerName}!*\n\n` +
                    `Biashara yako imeunganishwa kwenye mfumo wa Stany AI.\n\n` +
                    `📋 *AMRI ZAKU:*\n` +
                    `🔹 .set business [jina] - Badilisha jina la biashara\n` +
                    `🔹 .set welcome [ujumbe] - Badilisha ujumbe wa kukaribisha\n` +
                    `🔹 .set logo (tuma picha) - Badilisha logo ya biashara\n` +
                    `🔹 .set hours [08:00] [18:00] - Weka saa za kazi\n` +
                    `🔹 .group on / .group off - Washa/zima bot kwenye groups\n` +
                    `🔹 .set tag [@botname] - Weka tag ya bot kwenye groups\n` +
                    `🔹 .add service [keyword]|[name]|[description]|[price] (tuma picha hiari) - Ongeza huduma\n` +
                    `🔹 .remove service [keyword] - Futa huduma\n` +
                    `🔹 .my info - Tazama taarifa zako\n\n` +
                    `✨ *BOT IKO TAYARI KUWASAIDIA WATEJA WAKO!*`;
                
                await sock.sendMessage(ownerJid, { text: welcomeMsg });
                console.log(`✅ Welcome message imetumwa kwa ${ownerName}`);
            } catch (err) {
                console.error(`❌ Imeshindwa kutuma welcome message: ${err.message}`);
            }
        }
    });

    // ============================================
    // 5. USHUGHULIKIAJI WA MESEJI
    // ============================================
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderId = msg.key.remoteJid;
        const isGroup = senderId.endsWith('@g.us');
        const clientName = msg.pushName || "Mteja";
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();

        const currentOwner = await Owner.findOne({ ownerNumber });
        if (!currentOwner) return;

        // ============================================
        // CHECK WORKING HOURS (Kwa wateja wasio owner)
        // ============================================
        const isOwner = senderId.includes(ownerNumber);
        if (!isOwner && !isWithinWorkingHours(currentOwner)) {
            await sock.sendMessage(senderId, { 
                text: `⏰ Samahani, bot yetu inafanya kazi kuanzia *${currentOwner.workingHoursStart}* hadi *${currentOwner.workingHoursEnd}*. Tafadhali rudi wakati huo. Asante!` 
            });
            return;
        }

        // ============================================
        // CHECK GROUP SETTINGS
        // ============================================
        if (isGroup) {
            if (!currentOwner.groupEnabled) {
                return;
            }
            const isTagged = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(ownerNumber + '@s.whatsapp.net');
            if (!isTagged) {
                return;
            }
        }

        // ============================================
        // AMRI ZA OWNER
        // ============================================
        if (isOwner || isGroup) {
            
            // .set business [jina]
            if (body.startsWith('.set business ')) {
                const bName = body.replace('.set business ', '');
                currentOwner.businessName = bName;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Jina la biashara limebadilishwa kuwa: *${bName}*` });
                return;
            }

            // .set welcome [ujumbe]
            if (body.startsWith('.set welcome ')) {
                const wMsg = body.replace('.set welcome ', '');
                currentOwner.welcomeMessage = wMsg;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Ujumbe wa kukaribisha wateja umesasishwa!` });
                return;
            }

            // .set logo (tuma picha)
            if (body === '.set logo') {
                const imageMsg = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                if (!imageMsg) {
                    await sock.sendMessage(senderId, { text: `❌ Tafadhali tuma picha pamoja na command .set logo` });
                    return;
                }
                
                const buffer = await sock.downloadMediaMessage(msg);
                const filename = `logo_${ownerNumber}_${Date.now()}.jpg`;
                const filepath = path.join('./uploads', filename);
                
                if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
                fs.writeFileSync(filepath, buffer);
                
                const imageUrl = `https://${process.env.HOST || 'localhost'}/uploads/${filename}`;
                currentOwner.businessLogo = imageUrl;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Logo ya biashara imebadilishwa!` });
                return;
            }

            // .set hours [start] [end]
            if (body.startsWith('.set hours ')) {
                const parts = body.replace('.set hours ', '').split(' ');
                if (parts.length === 2) {
                    currentOwner.workingHoursStart = parts[0];
                    currentOwner.workingHoursEnd = parts[1];
                    await currentOwner.save();
                    await sock.sendMessage(senderId, { text: `✅ Saa za kazi zimewekwa: *${parts[0]}* hadi *${parts[1]}*` });
                    return;
                }
            }

            // .group on / .group off
            if (body === '.group on') {
                currentOwner.groupEnabled = true;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Bot imewashwa kwenye groups! Sasa itajibu tu pale unapotag @bot.` });
                return;
            }
            if (body === '.group off') {
                currentOwner.groupEnabled = false;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Bot imezimwa kwenye groups.` });
                return;
            }

            // .set tag [jina la tag]
            if (body.startsWith('.set tag ')) {
                const tag = body.replace('.set tag ', '');
                currentOwner.groupTag = tag;
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Tag ya bot imewekwa kuwa: *${tag}*` });
                return;
            }

            // .add service [keyword]|[name]|[description]|[price]
            if (body.startsWith('.add service ')) {
                const parts = body.replace('.add service ', '').split('|');
                if (parts.length >= 4) {
                    let imageUrl = "";
                    const imageMsg = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                    if (imageMsg) {
                        const buffer = await sock.downloadMediaMessage(msg);
                        const filename = `service_${ownerNumber}_${Date.now()}.jpg`;
                        const filepath = path.join('./uploads', filename);
                        if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
                        fs.writeFileSync(filepath, buffer);
                        imageUrl = `https://${process.env.HOST || 'localhost'}/uploads/${filename}`;
                    }

                    currentOwner.services.push({
                        keyword: parts[0].trim(),
                        name: parts[1].trim(),
                        description: parts[2].trim(),
                        price: parts[3].trim(),
                        imageUrl: imageUrl
                    });
                    await currentOwner.save();
                    await sock.sendMessage(senderId, { text: `✅ Huduma ya *${parts[1].trim()}* imeongezwa!` });
                    return;
                }
            }

            // .remove service [keyword]
            if (body.startsWith('.remove service ')) {
                const keyword = body.replace('.remove service ', '').trim();
                currentOwner.services = currentOwner.services.filter(s => s.keyword !== keyword);
                await currentOwner.save();
                await sock.sendMessage(senderId, { text: `✅ Huduma ya *${keyword}* imefutwa!` });
                return;
            }

            // .my info
            if (body === '.my info') {
                let info = `📊 *TAARIFA ZA BOT YAKO*\n\n`;
                info += `🏢 Biashara: *${currentOwner.businessName}*\n`;
                info += `🆔 Namba: *${currentOwner.ownerNumber}*\n`;
                info += `⏰ Saa za kazi: *${currentOwner.workingHoursStart}* - *${currentOwner.workingHoursEnd}*\n`;
                info += `👥 Groups: ${currentOwner.groupEnabled ? '✅ ImeWASHWA' : '❌ ImeZIMWA'}\n`;
                info += `🏷️ Tag: *${currentOwner.groupTag || 'Hajaseti'}*\n`;
                info += `📋 Huduma: *${currentOwner.services.length}*\n`;
                await sock.sendMessage(senderId, { text: info });
                return;
            }
        }

        // ============================================
        // AUTOMATION KWA MTEJA (Private chat tu)
        // ============================================
        if (!isGroup) {
            const lowerBody = body.toLowerCase();
            const triggerWords = ['mambo', 'habari', 'hello', 'hi', 'menu', 'mambo vipi', 'habari yako', 'start', 'hujambo'];

            if (triggerWords.includes(lowerBody)) {
                let servicesList = "";
                currentOwner.services.forEach((srv, index) => {
                    servicesList += `${index+1}. *${srv.keyword}* - ${srv.name} (${srv.price})\n`;
                });

                const welcomeText = `👋 *HABARI ${clientName.toUpperCase()}!*\n\n` +
                    `Mimi ni AI Msaidizi wa *${currentOwner.businessName}*.\n` +
                    `${currentOwner.welcomeMessage}\n\n` +
                    `📋 *HUDUMA ZETU:*\n${servicesList}\n\n` +
                    `💡 *AMRI ZA MSINGI:*\n` +
                    `👉 Tuma *menu* kuona orodha kamili\n` +
                    `👉 Tuma *[keyword]* kuona maelezo ya huduma\n` +
                    `👉 Tuma *W* kuwasiliana na mtoa huduma\n` +
                    `👉 Tuma *M* kurudi kwenye menyu kuu\n\n` +
                    `_Asante kwa kutuchagua!_ ✨`;

                if (currentOwner.businessLogo) {
                    await sock.sendMessage(senderId, { 
                        image: { url: currentOwner.businessLogo }, 
                        caption: welcomeText 
                    });
                } else {
                    await sock.sendMessage(senderId, { text: welcomeText });
                }
                return;
            }

            // Huduma iliyochaguliwa
            const selectedService = currentOwner.services.find(srv => srv.keyword === body);
            if (selectedService) {
                const serviceMessage = `✨ *${selectedService.name}* ✨\n\n` +
                    `📝 ${selectedService.description}\n\n` +
                    `💰 *Bei:* ${selectedService.price}\n\n` +
                    `-----------------------------------\n` +
                    `💡 Tuma *W* kuwasiliana na mtoa huduma\n` +
                    `💡 Tuma *M* kurudi menyu`;

                if (selectedService.imageUrl) {
                    await sock.sendMessage(senderId, { 
                        image: { url: selectedService.imageUrl }, 
                        caption: serviceMessage 
                    });
                } else {
                    await sock.sendMessage(senderId, { text: serviceMessage });
                }
                return;
            }

            if (lowerBody === 'w' || lowerBody === 'wasiliana') {
                await sock.sendMessage(senderId, { 
                    text: "📞 Ombi lako limepokelewa. Mtoa huduma wetu atawasiliana na wewe hivi punde!" 
                });
                return;
            }

            if (lowerBody === 'm' || lowerBody === 'menu') {
                let servicesList = "";
                currentOwner.services.forEach((srv, index) => {
                    servicesList += `${index+1}. *${srv.keyword}* - ${srv.name} (${srv.price})\n`;
                });
                await sock.sendMessage(senderId, { 
                    text: `📋 *MENU KUU - ${currentOwner.businessName}*\n\n${servicesList}\n\nTuma keyword ya huduma unayotaka.` 
                });
                return;
            }
        }
    });
}

// =============================================
// 6. LOGIKI YA PAIRING CODE
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
                { keyword: "1", name: "Sample Service", description: "Tumia .add service kubadilisha", price: "TSH 10,000" }
            ]
        });
        await owner.save();
    }

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
// 7. ROUTES ZA API
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

// Serve static files (uploads)
app.use('/uploads', express.static('uploads'));

app.get('/', (req, res) => {
    res.sendFile('index.html', { root: '.' });
});

// =============================================
// 8. ADMIN ROUTES
// =============================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: 'admin-token-' + Date.now() });
    } else {
        res.status(401).json({ success: false, message: 'Password sahihi' });
    }
});

app.get('/api/admin/owners', async (req, res) => {
    try {
        const owners = await Owner.find({});
        res.json(owners);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/owner/:id', async (req, res) => {
    try {
        const owner = await Owner.findById(req.params.id);
        if (!owner) return res.status(404).json({ error: 'Not found' });
        res.json(owner);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/owner/:id', async (req, res) => {
    try {
        const owner = await Owner.findById(req.params.id);
        if (!owner) return res.status(404).json({ error: 'Not found' });

        const sessionDir = `./sessions/${owner.ownerNumber}`;
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        await Owner.findByIdAndDelete(req.params.id);
        
        if (activeSessions.has(owner.ownerNumber)) {
            const sock = activeSessions.get(owner.ownerNumber);
            if (sock) await sock.end();
            activeSessions.delete(owner.ownerNumber);
        }

        res.json({ success: true, message: 'Owner imefutwa!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/owner/:ownerId/service/:serviceIndex', async (req, res) => {
    try {
        const owner = await Owner.findById(req.params.ownerId);
        if (!owner) return res.status(404).json({ error: 'Owner not found' });

        const index = parseInt(req.params.serviceIndex);
        if (index < 0 || index >= owner.services.length) {
            return res.status(400).json({ error: 'Invalid service index' });
        }

        owner.services.splice(index, 1);
        await owner.save();
        res.json({ success: true, message: 'Service imefutwa!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalOwners = await Owner.countDocuments();
        const allOwners = await Owner.find({});
        let totalServices = 0;
        allOwners.forEach(o => totalServices += o.services.length);
        res.json({ totalOwners, totalServices });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile('admin.html', { root: '.' });
});

// =============================================
// 9. AUTOSTART BOTS (Hakuna reconnect)
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
// 10. TELEGRAM BOT (Imerakibishwa)
// =============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (TELEGRAM_TOKEN) {
    const bot = new TelegramBot(TELEGRAM_TOKEN, { 
        polling: { 
            autoStart: true,
            dropPendingUpdates: true,
            params: { timeout: 60 }
        } 
    });
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

        if (state.step === 'AWAITING_NAME') {
            state.name = text;
            state.step = 'AWAITING_NUMBER';
            userState.set(chatId, state);
            bot.sendMessage(chatId, `✅ Jina "${text}" limehifadhiwa. Sasa tafadhali andika *namba yako ya WhatsApp* (bila +, mfano: 255712345678):`);
            return;
        }

        if (state.step === 'AWAITING_NUMBER') {
            const number = text;
            const name = state.name;
            userState.delete(chatId);

            bot.sendMessage(chatId, `⏳ Inachakata ombi lako... tafadhali subiri sekunde chache.`);

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

    // Handle polling errors
    bot.on('polling_error', (err) => {
        if (err.code === 'ETELEGRAM' && err.message.includes('409 Conflict')) {
            console.log('⚠️ Telegram conflict ignored. Only one bot is running.');
        } else {
            console.error('Telegram polling error:', err.message);
        }
    });

} else {
    console.log("⚠️ TELEGRAM_TOKEN haijapatikana, Telegram Bot haitawashwa.");
}