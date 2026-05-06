require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const path = require('path');

// --- 1. Render Port Binding & Mini App Server ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// CORS — Vercel frontend မှ Render backend ကို fetch လုပ်ခွင့်ပေးသည်
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 2. Bot Initialization ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = String(process.env.ADMIN_ID).trim();

// --- 3. Database Connection ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("✅ Database Connected!"))
    .catch(err => {
        console.log("❌ DB Error:", err);
        process.exit(1);
    });

// --- 4. Database Schema (referral fields ဖြုတ်ပြီး ID + Username သာ) ---
const userSchema = new mongoose.Schema({
    tgId: { type: Number, unique: true },
    username: String,
    isBanned: { type: Boolean, default: false },
    state: { type: String, default: 'none' },
    lastActive: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- 5. Reward API for Mini App (Adsgram အတွက်) ---
app.all('/reward-user', async (req, res) => {
    try {
        const userId = req.query.userId || req.body.userId;
        if (!userId) {
            return res.status(400).send('User ID required');
        }
        const user = await User.findOne({ tgId: Number(userId) });
        if (user) {
            try {
                await bot.telegram.sendMessage(userId, "💰 ကြော်ငြာကြည့်ရှုမှုအတွက် ၅၀၀ ကျပ် လက်ခံရရှိပါတယ်!");
            } catch (e) { /* User blocked the bot */ }
            return res.json({ success: true });
        }
        res.status(404).send('User not found');
    } catch (error) {
        console.error("❌ /reward-user error:", error);
        res.status(500).send('Internal Error');
    }
});

// /api/get-user — index.html ၏ refreshBalance() အတွက်
app.post('/api/get-user', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        const user = await User.findOne({ tgId: Number(userId) });
        if (user) {
            return res.json({
                username: user.username,
                isBanned: user.isBanned
            });
        }
        // User မတွေ့ → အသစ် create
        const newUser = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $setOnInsert: { username: 'User' } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return res.json({ username: newUser.username });
    } catch (error) {
        console.error("❌ /api/get-user error:", error);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// /api/reward-user — index.html ၏ ad reward အတွက်
app.post('/api/reward-user', async (req, res) => {
    try {
        const { userId, slot } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        const user = await User.findOne({ tgId: Number(userId) });
        if (user) {
            try {
                await bot.telegram.sendMessage(userId, `💰 ကြော်ငြာ (Slot ${slot || ''}) ကြည့်ရှုမှုအတွက် ၅၀၀ ကျပ် လက်ခံရရှိပါတယ်!`);
            } catch (e) {}
            return res.json({ success: true, rewardAmt: 500 });
        }
        res.status(404).json({ error: 'User not found' });
    } catch (error) {
        console.error("❌ /api/reward-user error:", error);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// /api/task-config — Task slot config အတွက်
app.get('/api/task-config', async (req, res) => {
    res.json({
        slots: [
            { id: 1, title: 'ကြော်ငြာ ၁', reward: 500, blockId: 'int-29385' },
            { id: 2, title: 'ကြော်ငြာ ၂', reward: 500, blockId: 'int-29385' },
            { id: 3, title: 'ကြော်ငြာ ၃', reward: 500, blockId: 'int-29385' },
            { id: 4, title: 'ကြော်ငြာ ၄', reward: 500, blockId: 'int-29385' },
        ]
    });
});

app.listen(port, () => console.log(`✅ Server is listening on port ${port}`));

// --- 6. Helpers ---

class TelegramApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TelegramApiError';
    }
}

// In-Memory Cache — userId → { joined, expiresAt }
const joinCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of joinCache.entries()) {
        if (now >= data.expiresAt) joinCache.delete(userId);
    }
}, 10 * 60 * 1000);

// Exponential Backoff Retry Helper
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);

async function withRetry(fn, retries = 3, baseDelayMs = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            const isNetworkError =
                RETRYABLE_CODES.has(e.code) ||
                (e.message && (e.message.includes('ETIMEDOUT') || e.message.includes('socket hang up')));

            if (!isNetworkError || attempt === retries) break;

            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.warn(`⚠️ [Retry ${attempt}/${retries}] ${e.code || e.message} — ${delay}ms စောင့်သည်...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new TelegramApiError(
        `Telegram API ${retries} ကြိမ် retry လုပ်လည်း ဆက်သွယ်မရပါ: ${lastError?.message}`
    );
}

// isJoined — TheNetMyan channel တစ်ခုတည်းစစ်သည်
const CHANNEL = '@TheNetMyan';

async function isJoined(ctx) {
    const userId = ctx.from.id;

    const cached = joinCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
        console.log(`✅ [Cache Hit] User ${userId}`);
        return cached.joined;
    }

    const member = await withRetry(() => ctx.telegram.getChatMember(CHANNEL, userId));
    const joined = !['left', 'kicked'].includes(member.status);

    if (joined) {
        joinCache.set(userId, { joined: true, expiresAt: Date.now() + CACHE_TTL_MS });
        console.log(`✅ [Cache Set] User ${userId}`);
    }

    return joined;
}

const isAdmin = (ctx) => String(ctx.from.id) === ADMIN_ID;

bot.catch((err, ctx) => {
    console.error(`⚠️ Telegram Error (${ctx.updateType}): ${err.message}`);
});

// --- 7. Start Command ---
bot.start(async (ctx) => {
    try {
        // User upsert (ID + Username သာ)
        const user = await User.findOneAndUpdate(
            { tgId: ctx.from.id },
            { $setOnInsert: { username: ctx.from.first_name || 'User' } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        if (user.isBanned) {
            return ctx.reply("🚫 သင်သည် စည်းကမ်းဖောက်ဖျက်မှုကြောင့် အသုံးပြုခွင့် ပိတ်ပင်ခံထားရပါသည်။").catch(() => {});
        }

        await ctx.reply(
            "👋 မင်္ဂလာပါ!\n\nBot ကို အသုံးပြုနိုင်ရန် ကျွန်ုပ်တို့၏ Channel ကို အရင် Join ပေးပါ 👇",
            Markup.inlineKeyboard([
                [Markup.button.url('📲 Channel ကို Join ပါ', 'https://t.me/TheNetMyan')],
                [Markup.button.callback('✅ စစ်ဆေးမည် (Joined)', 'check_join')]
            ])
        ).catch(() => {});
    } catch (e) {
        console.error("❌ /start error:", e);
    }
});

// --- 8. Check Join Action ---
bot.action('check_join', async (ctx) => {
    try {
        let joined;
        try {
            joined = await isJoined(ctx);
        } catch (e) {
            if (e instanceof TelegramApiError) {
                console.error(`🔴 [check_join] TelegramApiError: ${e.message}`);
                return ctx.answerCbQuery(
                    "⚠️ Bot တွင် ယာယီချိတ်ဆက်မှု အခက်အခဲရှိနေပါသဖြင့် ခေတ္တစောင့်ဆိုင်းပြီးမှ ထပ်မံကြိုးစားကြည့်ပါခင်ဗျာ။",
                    { show_alert: true }
                ).catch(() => {});
            }
            throw e;
        }

        if (joined) {
            try { await ctx.deleteMessage(); } catch (e) {}
            await ctx.reply(
                "✅ Channel Join ပြီးပါပြီ!\n\nကြော်ငြာကြည့်ပြီးပိုက်ဆံရှာရန် အောက်ပါ button ကို နှိပ်ပါ 👇",
                Markup.inlineKeyboard([
                    [Markup.button.url('💸 ကြော်ငြာကြည့်ပြီးပိုက်ဆံရှာရန်', 'http://t.me/thenetmyan_bot/app')]
                ])
            ).catch(() => {});
        } else {
            await ctx.answerCbQuery("⚠️ Channel ကို Join ရပါမည်!", { show_alert: true }).catch(() => {});
        }
    } catch (e) {
        console.error("❌ check_join error:", e);
    }
});

// ==================== ADMIN COMMANDS ====================

bot.command('panel', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const total = await User.countDocuments();
        let msg = `👑 <b>Admin Panel</b>\n\n📊 Total Users: ${total}\n\n`;
        msg += `🔹 <code>/users [page]</code> - စာမျက်နှာအလိုက် user စာရင်း\n`;
        msg += `🔹 <code>/user [user_id]</code> - user အချက်အလက်ကြည့်\n`;
        msg += `🔹 <code>/ban [user_id]</code> - ပိတ်ပင်မယ်\n`;
        msg += `🔹 <code>/unban [user_id]</code> - ပြန်ဖွင့်မယ်\n`;
        msg += `🔹 <code>/send [user_id] [စာသား]</code> - တစ်ဦးချင်းစာပို့\n`;
        msg += `🔹 <code>/sendbatch [အရေအတွက်(<=50)] [စာသား]</code> - နောက်ဆုံး active users ကို batch ပို့\n`;
        msg += `🔹 <code>/broadcast [စာသား]</code> - အားလုံးကိုပို့ (သတိထားပါ)\n`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("❌ /panel error:", e);
    }
});

bot.command('users', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const args = ctx.message.text.split(' ');
        let page = 1;
        if (args.length > 1) page = parseInt(args[1]) || 1;
        const limit = 10;
        const skip = (page - 1) * limit;
        const users = await User.find().skip(skip).limit(limit).sort({ tgId: 1 });
        const total = await User.countDocuments();
        let msg = `👥 <b>User List (Page ${page}/${Math.ceil(total / limit)})</b>\n\n`;
        users.forEach(u => {
            msg += `🆔 <code>${u.tgId}</code> | ${u.username || 'NoName'} | ${u.isBanned ? '🚫Banned' : '✅'}\n`;
        });
        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("❌ /users error:", e);
    }
});

bot.command('user', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply("⚠️ user_id ထည့်ပါ။\n/user 123456789");
        const userId = parseInt(args[1]);
        const user = await User.findOne({ tgId: userId });
        if (!user) return ctx.reply("❌ User not found.");
        const msg = `👤 <b>User Info</b>\n\n` +
            `🆔 ID: <code>${user.tgId}</code>\n` +
            `👤 Name: ${user.username || 'N/A'}\n` +
            `🚫 Banned: ${user.isBanned ? 'Yes' : 'No'}\n` +
            `🕒 Last Active: ${user.lastActive ? user.lastActive.toLocaleString() : 'Never'}`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        console.error("❌ /user error:", e);
    }
});

bot.command('ban', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply("⚠️ /ban [user_id]");
        const userId = parseInt(args[1]);
        const user = await User.findOne({ tgId: userId });
        if (!user) return ctx.reply("❌ User not found.");
        if (user.isBanned) return ctx.reply("✅ User already banned.");

        await User.updateOne(
            { tgId: userId },
            { $set: { isBanned: true, state: 'none' } }
        );

        await ctx.reply(`🚫 User ${userId} ကို ban လိုက်ပါပြီ။`);
        try { await bot.telegram.sendMessage(userId, "🚫 သင်သည် စည်းကမ်းဖောက်ဖျက်မှုကြောင့် အသုံးပြုခွင့် ပိတ်ပင်ခံထားရပါသည်။"); } catch (e) {}
    } catch (e) {
        console.error("❌ /ban error:", e);
    }
});

bot.command('unban', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply("⚠️ /unban [user_id]");
        const userId = parseInt(args[1]);
        const user = await User.findOne({ tgId: userId });
        if (!user) return ctx.reply("❌ User not found.");
        if (!user.isBanned) return ctx.reply("✅ User is not banned.");

        await User.updateOne({ tgId: userId }, { $set: { isBanned: false } });

        await ctx.reply(`✅ User ${userId} ကို unban လိုက်ပါပြီ။`);
        try { await bot.telegram.sendMessage(userId, "✅ သင့်အကောင့်ကို ပြန်လည်အသုံးပြုခွင့်ပေးလိုက်ပါပြီ။"); } catch (e) {}
    } catch (e) {
        console.error("❌ /unban error:", e);
    }
});

bot.command('send', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const text = ctx.message.text;
        const firstSpace = text.indexOf(' ');
        if (firstSpace === -1) return ctx.reply("⚠️ /send [user_id] [message]");
        const rest = text.substring(firstSpace + 1).trim();
        const secondSpace = rest.indexOf(' ');
        if (secondSpace === -1) return ctx.reply("⚠️ /send [user_id] [message]");
        const userIdStr = rest.substring(0, secondSpace);
        const msgText = rest.substring(secondSpace + 1).trim();
        const userId = parseInt(userIdStr);
        if (isNaN(userId)) return ctx.reply("❌ user_id မှားယွင်းနေပါသည်။");
        const user = await User.findOne({ tgId: userId });
        if (!user) return ctx.reply("❌ User not found.");
        try {
            await bot.telegram.sendMessage(userId, msgText);
            await ctx.reply(`✅ Message sent to ${userId}`);
        } catch (e) {
            await ctx.reply(`❌ Failed to send: ${e.message}`);
        }
    } catch (e) {
        console.error("❌ /send error:", e);
    }
});

bot.command('sendbatch', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const text = ctx.message.text;
        const firstSpace = text.indexOf(' ');
        if (firstSpace === -1) return ctx.reply("⚠️ /sendbatch [count] [message]");
        const rest = text.substring(firstSpace + 1).trim();
        const secondSpace = rest.indexOf(' ');
        if (secondSpace === -1) return ctx.reply("⚠️ /sendbatch [count] [message]");
        const countStr = rest.substring(0, secondSpace);
        const msgText = rest.substring(secondSpace + 1).trim();
        const count = parseInt(countStr);
        if (isNaN(count) || count < 1 || count > 50) return ctx.reply("❌ count သည် 1 နှင့် 50 ကြားဖြစ်ရပါမည်။");

        const users = await User.find({ isBanned: false }).sort({ lastActive: -1 }).limit(count);
        if (users.length === 0) return ctx.reply("❌ No active users found.");

        await ctx.reply(`📨 စတင် batch ပို့နေပါသည်... (ဦးရေ: ${users.length})`);
        let success = 0, fail = 0;
        for (const u of users) {
            try {
                await bot.telegram.sendMessage(u.tgId, msgText);
                success++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                fail++;
            }
        }
        await ctx.reply(`✅ Batch send complete.\n✅ Success: ${success}\n❌ Failed: ${fail}`);
    } catch (e) {
        console.error("❌ /sendbatch error:", e);
    }
});

bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const msgText = ctx.message.text.split('/broadcast ')[1];
        if (!msgText) return ctx.reply("⚠️ စာသားထည့်ပါ။");
        const users = await User.find({ isBanned: false });
        await ctx.reply(`📨 စတင် broadcast ပို့နေပါသည်... (ဦးရေ: ${users.length})`);
        let success = 0, fail = 0;
        for (const u of users) {
            try {
                await bot.telegram.sendMessage(u.tgId, msgText);
                success++;
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (e) {
                fail++;
            }
        }
        await ctx.reply(`✅ Broadcast done.\n✅ Success: ${success}\n❌ Failed: ${fail}`);
    } catch (e) {
        console.error("❌ /broadcast error:", e);
    }
});

// ==================== GLOBAL MESSAGE HANDLER ====================

bot.on('message', async (ctx) => {
    try {
        // Update last active
        User.updateOne({ tgId: ctx.from.id }, { $set: { lastActive: new Date() } }).catch(() => {});

        const user = await User.findOne({ tgId: ctx.from.id });
        if (!user || user.isBanned) return;

        // User ဆီကနေ မည်သည့် message မဆို ADMIN_ID ဆီ တိုက်ရိုက် Forward လုပ်သည်
        if (user.state === 'none') {
            try {
                const message = ctx.message;
                if (message.text) {
                    await bot.telegram.sendMessage(
                        ADMIN_ID,
                        `📨 User Message\n\n🆔 ID: ${user.tgId}\n👤 Name: ${user.username || 'N/A'}\n💬 Message: ${message.text}`
                    );
                } else if (message.photo) {
                    await bot.telegram.sendPhoto(
                        ADMIN_ID,
                        message.photo[message.photo.length - 1].file_id,
                        { caption: `📨 User Photo\n\n🆔 ID: ${user.tgId}\n👤 Name: ${user.username || 'N/A'}` }
                    );
                } else if (message.video) {
                    await bot.telegram.sendVideo(
                        ADMIN_ID,
                        message.video.file_id,
                        { caption: `📨 User Video\n\n🆔 ID: ${user.tgId}\n👤 Name: ${user.username || 'N/A'}` }
                    );
                } else if (message.document) {
                    await bot.telegram.sendDocument(
                        ADMIN_ID,
                        message.document.file_id,
                        { caption: `📨 User Document\n\n🆔 ID: ${user.tgId}\n👤 Name: ${user.username || 'N/A'}` }
                    );
                }
            } catch (e) {
                console.error("Failed to forward message to admin:", e);
            }
        }

    } catch (e) {
        console.error("❌ Message handler error:", e);
    }
});

bot.launch().then(() => console.log("🚀 Bot is Live!"));

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
