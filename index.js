require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { useMongoDBAuthState } = require('./auth');

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

let sock;
let isConnected = false;

// Connect to MongoDB
mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB!'))
    .catch(err => console.error('MongoDB connection error:', err));

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMongoDBAuthState();

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Set to 'info' or 'debug' for more logs
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
                connectToWhatsApp();
            } else {
                console.log("You have been logged out. Please restart and scan the QR again.");
            }
        } else if (connection === 'open') {
            console.log('Successfully connected to WhatsApp!');
            isConnected = true;
        }
    });

    // You can listen to incoming messages here if you want to find the Group JID easily
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            // Uncomment this to print the Group JID when someone sends a message in the group
            console.log("Received message from JID:", msg.key.remoteJid);
        }
    });
}

const { generateDailyReport } = require('./leetcode');

// Express Endpoint for cron-job.org to hit
app.post('/send-reminder', async (req, res) => {
    const providedSecret = req.headers['x-cron-secret'] || req.query.secret;
    
    if (providedSecret !== CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Reconnects can take a few seconds after a cold start or a dropped
    // socket; wait briefly instead of failing the cron hit immediately.
    for (let attempt = 0; attempt < 6 && (!isConnected || !sock); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    if (!isConnected || !sock) {
        return res.status(503).json({ error: 'WhatsApp is not connected yet.' });
    }

    if (!GROUP_JID) {
        return res.status(500).json({ error: 'GROUP_JID is not configured in .env' });
    }

    try {
        const reportMessage = await generateDailyReport();
        
        // Fetch group metadata to get all members for @all feature
        const groupMetadata = await sock.groupMetadata(GROUP_JID);
        const allParticipants = groupMetadata.participants.map(p => p.id);
        
        // Send message and tag everyone
        await sock.sendMessage(GROUP_JID, { 
            text: reportMessage,
            mentions: allParticipants 
        });
        
        console.log("Reminder sent successfully with @all mention!");
        res.json({ success: true, message: "Reminder sent!" });
    } catch (error) {
        console.error("Failed to send message:", error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// A simple health check route for Render
app.get('/', (req, res) => {
    res.send(`WhatsApp Bot is Running! Status: ${isConnected ? 'Connected' : 'Disconnected'}`);
});

// Render's free tier sleeps after 15 min without inbound traffic, which made
// the 10 PM cron hit a sleeping instance. Pinging our own public URL keeps it awake.
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL;
if (KEEP_ALIVE_URL) {
    const fetch = require('node-fetch');
    setInterval(() => {
        fetch(KEEP_ALIVE_URL).catch((error) => console.error('Keep-alive ping failed:', error.message));
    }, 10 * 60 * 1000);
}

app.listen(PORT, async () => {
    console.log(`Express server running on port ${PORT}`);
    // Start WhatsApp connection once the server starts
    if (mongoose.connection.readyState === 1) {
        connectToWhatsApp();
    } else {
         mongoose.connection.once('open', () => {
            connectToWhatsApp();
         });
    }
});
