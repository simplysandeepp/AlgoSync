require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const { useMongoDBAuthState } = require('./auth');
const { generateDailyReport } = require('./leetcode');

const app = express();
app.use(express.json());

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const GROUP_JID = process.env.GROUP_JID;
const CRON_SECRET = process.env.CRON_SECRET;
// HH:MM in IST. After this time the bot sends once per day on its own.
const REMINDER_TIME_IST = process.env.REMINDER_TIME_IST || '22:00';

let sock;
let isConnected = false;

mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB!'))
    .catch(err => console.error('MongoDB connection error:', err));

// One document per IST date that a reminder went out, so the built-in
// scheduler, GitHub Actions and cron-job.org can all trigger without duplicates.
const ReminderLog = mongoose.models.ReminderLog || mongoose.model('ReminderLog', new mongoose.Schema({
    _id: { type: String, required: true },
    sentAt: { type: Date, default: Date.now }
}));

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMongoDBAuthState();

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("Scan this QR code with your secondary WhatsApp number!");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);

            isConnected = false;

            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp().catch((e) => console.error('Reconnect failed:', e)), 5000);
            } else {
                console.log("You have been logged out. Please restart and scan the QR again.");
            }
        } else if (connection === 'open') {
            console.log('Successfully connected to WhatsApp!');
            isConnected = true;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            console.log("Received message from JID:", msg.key.remoteJid);
        }
    });
}

function istNow() {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date()).map((p) => [p.type, p.value])
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function waitForWhatsApp(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while ((!isConnected || !sock) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return isConnected && !!sock;
}

let lastSentDate = null;
let inFlight = null;

// Returns { sent: true } or { sent: false, reason }. Throws on real failures.
async function sendDailyReminder({ force = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
        const today = istNow().date;
        if (!force && lastSentDate === today) return { sent: false, reason: 'already sent today' };
        if (!GROUP_JID) throw new Error('GROUP_JID is not configured');
        if (!(await waitForWhatsApp(60000))) throw new Error('WhatsApp is not connected');

        let reserved = false;
        if (!force) {
            try {
                await ReminderLog.create({ _id: today });
                reserved = true;
            } catch (error) {
                if (error.code === 11000) {
                    lastSentDate = today;
                    return { sent: false, reason: 'already sent today' };
                }
                // If MongoDB is down, still send rather than silently skipping the day.
                console.error('Could not record reminder in MongoDB, sending anyway:', error.message);
            }
        }

        try {
            const reportMessage = await generateDailyReport();
            const groupMetadata = await sock.groupMetadata(GROUP_JID);
            const allParticipants = groupMetadata.participants.map(p => p.id);
            await sock.sendMessage(GROUP_JID, { text: reportMessage, mentions: allParticipants });
        } catch (error) {
            // Release the reservation so the next trigger can retry today.
            if (reserved) await ReminderLog.deleteOne({ _id: today }).catch(() => {});
            throw error;
        }

        lastSentDate = today;
        console.log(`Reminder sent for ${today}${force ? ' (forced)' : ''}`);
        return { sent: true };
    })();
    try {
        return await inFlight;
    } finally {
        inFlight = null;
    }
}

app.post('/send-reminder', async (req, res) => {
    const providedSecret = req.headers['x-cron-secret'] || req.query.secret;
    if (!CRON_SECRET || providedSecret !== CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const result = await sendDailyReminder({ force });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Failed to send reminder:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`WhatsApp Bot is Running! Status: ${isConnected ? 'Connected' : 'Disconnected'}`);
});

app.get('/health', (req, res) => {
    res.status(isConnected ? 200 : 503).json({
        whatsapp: isConnected ? 'connected' : 'disconnected',
        mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        lastSentDate,
        commit: process.env.RENDER_GIT_COMMIT || null
    });
});

// Only on Render: a local run must not post to the real group on its own.
if (process.env.RENDER) {
    setInterval(() => {
        const now = istNow();
        if (now.time < REMINDER_TIME_IST || lastSentDate === now.date || !isConnected) return;
        sendDailyReminder().catch((error) => console.error('Scheduled reminder failed:', error.message));
    }, 60 * 1000);

    // Render's free tier sleeps after 15 min without inbound traffic.
    if (process.env.RENDER_EXTERNAL_URL) {
        setInterval(() => {
            fetch(process.env.RENDER_EXTERNAL_URL).catch((error) => console.error('Keep-alive ping failed:', error.message));
        }, 10 * 60 * 1000);
    }
}

app.listen(PORT, async () => {
    console.log(`Express server running on port ${PORT}`);
    if (mongoose.connection.readyState === 1) {
        connectToWhatsApp();
    } else {
        mongoose.connection.once('open', () => {
            connectToWhatsApp();
        });
    }
});
