require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = String(process.env.ADMIN_ID).trim();
const BOT_USERNAME = process.env.BOT_USERNAME || 'thenetmyan_bot';

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("✅ Database Connected!"))
    .catch(err => { console.log("❌ DB Error:", err); process.exit(1); });

// ═══════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════

const userSchema = new mongoose.Schema({
    tgId:           { type: Number, unique: true },
    username:       String,
    balance:        { type: Number, default: 0 },
    referredBy:     { type: Number, default: null },
    referralCount:  { type: Number, default: 0 },
    claimedChannels:{ type: [Number], default: [] },
    lastCheckin:    { type: Date, default: null },
    lastSpin:       { type: Date, default: null },
    isBanned:       { type: Boolean, default: false },
    state:          { type: String, default: 'none' },
    lastActive:     { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Earn history log
const historySchema = new mongoose.Schema({
    tgId:      Number,
    type:      String,
    label:     String,
    amount:    Number,
    createdAt: { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

// Config
const configSchema = new mongoose.Schema({
    key:   { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const Config = mongoose.model('Config', configSchema);

const DEFAULT_CONFIG = {
    channel1_link:    'https://t.me/TheNetMyan',
    channel1_name:    'TheNetMyan',
    channel2_link:    'https://t.me/TheNetMyan',
    channel2_name:    'TheNetMyan 2',
    channel1_id:      '@TheNetMyan',
    channel2_id:      '@TheNetMyan',
    join_reward:      20,
    ad_reward:        20,
    ad_cooldown_s:    180,
    ad_daily_limit:   4,
    ad_daily_reset_h: 24,
    referral_reward:  50,
    checkin_reward:   10,
    game_entry_fee:   50,
    game_max_earn:    90,
    spin_prizes:      [100, 50, 200, 300, 500, 50, 100, 200],
    currency_label:   'Coins',
    video_cooldown_s: 7200,
    min_withdraw:     1000,
};

async function setCfg(key, value) {
    await Config.findOneAndUpdate({ key }, { value }, { upsert: true });
}
async function getAllCfg() {
    const docs = await Config.find({});
    const result = { ...DEFAULT_CONFIG };
    docs.forEach(d => { result[d.key] = d.value; });
    return result;
}

// ═══════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════

app.get('/api/config', async (req, res) => {
    try { res.json(await getAllCfg()); }
    catch (e) { res.status(500).json({ error: 'Config error' }); }
});

app.post('/api/get-user', async (req, res) => {
    try {
        const { userId, username: uname } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        let user = await User.findOne({ tgId: Number(userId) });
        if (!user) {
            user = await User.findOneAndUpdate(
                { tgId: Number(userId) },
                { $setOnInsert: { username: uname || 'User', balance: 0 } },
                { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
            );
        }
        return res.json({
            username: user.username,
            balance: user.balance,
            referralCount: user.referralCount,
            lastCheckin: user.lastCheckin,
            lastSpin: user.lastSpin,
            isBanned: user.isBanned
        });
    } catch (e) {
        console.error("❌ /api/get-user:", e);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// Daily Check-in
app.post('/api/checkin', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false });
        const cfg = await getAllCfg();
        const user = await User.findOne({ tgId: Number(userId) });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (user.lastCheckin && new Date(user.lastCheckin) >= todayStart) {
            return res.json({ success: false, error: 'already_checked' });
        }

        const reward = cfg.checkin_reward;
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: reward }, $set: { lastCheckin: now } },
            { returnDocument: 'after' }
        );
        await History.create({ tgId: Number(userId), type: 'checkin', label: 'Daily Check-in', amount: reward });
        try { await bot.telegram.sendMessage(userId, `✅ Daily Check-in!\n🎁 ${reward} ${cfg.currency_label} ရရှိပါပြီ!\n💰 Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, reward, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/checkin:", e);
        res.status(500).json({ success: false });
    }
});

// Channel join claim
app.post('/api/claim-join', async (req, res) => {
    try {
        const { userId, channel } = req.body;
        if (!userId) return res.status(400).json({ success: false });
        const cfg = await getAllCfg();
        const channelId = channel === 2 ? cfg.channel2_id : cfg.channel1_id;

        const user = await User.findOne({ tgId: Number(userId) });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if ((user.claimedChannels || []).includes(channel)) {
            return res.json({ success: false, error: 'already_claimed' });
        }

        try {
            const member = await bot.telegram.getChatMember(channelId, Number(userId));
            if (['left','kicked'].includes(member.status)) return res.json({ success: false, error: 'not_joined' });
        } catch (e) { return res.json({ success: false, error: 'check_failed' }); }

        const reward = cfg.join_reward;
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: reward }, $push: { claimedChannels: channel } },
            { returnDocument: 'after' }
        );
        await History.create({ tgId: Number(userId), type: 'join', label: `Channel ${channel} Join`, amount: reward });
        try { await bot.telegram.sendMessage(userId, `✅ Channel Join! ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, reward, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/claim-join:", e);
        res.status(500).json({ success: false });
    }
});

// Ad reward
app.post('/api/reward-user', async (req, res) => {
    try {
        const { userId, slot } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        const cfg = await getAllCfg();
        const reward = cfg.ad_reward;
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: reward }, $set: { lastActive: new Date() } },
            { returnDocument: 'after' }
        );
        if (!updated) return res.status(404).json({ error: 'User not found' });
        await History.create({ tgId: Number(userId), type: 'ad', label: `Watch Ad ${slot||''}`, amount: reward });
        try { await bot.telegram.sendMessage(userId, `📺 Ad ${slot||''} — ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, rewardAmt: reward, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/reward-user:", e);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// Video task reward
app.post('/api/reward-video', async (req, res) => {
    try {
        const { userId, slot } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        const cfg = await getAllCfg();
        const reward = cfg.ad_reward * 2;
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: reward }, $set: { lastActive: new Date() } },
            { returnDocument: 'after' }
        );
        if (!updated) return res.status(404).json({ error: 'User not found' });
        await History.create({ tgId: Number(userId), type: 'video', label: `Daily Task ${slot||''}`, amount: reward });
        try { await bot.telegram.sendMessage(userId, `🎬 Daily Task ${slot||''} — ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, rewardAmt: reward, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/reward-video:", e);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// Spin — once per day
app.post('/api/spin', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, error: 'User ID required' });
        const cfg = await getAllCfg();

        const user = await User.findOne({ tgId: Number(userId) });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (user.lastSpin && new Date(user.lastSpin) >= todayStart) {
            return res.json({ success: false, error: 'already_spun' });
        }

        const prizes = cfg.spin_prizes;
        const idx = Math.floor(Math.random() * prizes.length);
        const prize = prizes[idx];

        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: prize }, $set: { lastActive: now, lastSpin: now } },
            { returnDocument: 'after' }
        );
        await History.create({ tgId: Number(userId), type: 'spin', label: 'Lucky Spin', amount: prize });
        try { await bot.telegram.sendMessage(userId, `🎰 Lucky Spin — ${prize} ${cfg.currency_label} ရရှိပါတယ်!\n💰 Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, prize, newBalance: updated.balance, prizeIndex: idx });
    } catch (e) {
        console.error("❌ /api/spin:", e);
        res.status(500).json({ success: false, error: 'Internal Error' });
    }
});

// Game refund
app.post('/api/game-refund', async (req, res) => {
    try {
        const { userId, fee } = req.body;
        if (!userId) return res.status(400).json({ success: false });
        const refundAmt = Number(fee) || 50;
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: refundAmt } },
            { returnDocument: 'after' }
        );
        if (!updated) return res.status(404).json({ success: false });
        return res.json({ success: true, newBalance: updated.balance });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Game start
app.post('/api/game-start', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false });
        const cfg = await getAllCfg();
        const fee = cfg.game_entry_fee;
        const user = await User.findOne({ tgId: Number(userId) });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (user.balance < fee) return res.json({ success: false, error: 'insufficient' });
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: -fee } },
            { returnDocument: 'after' }
        );
        return res.json({ success: true, fee, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/game-start:", e);
        res.status(500).json({ success: false });
    }
});

// Game end
app.post('/api/game-end', async (req, res) => {
    try {
        const { userId, earned } = req.body;
        if (!userId) return res.status(400).json({ success: false });
        const cfg = await getAllCfg();
        const safeEarned = Math.min(Number(earned) || 0, cfg.game_max_earn);
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: safeEarned }, $set: { lastActive: new Date() } },
            { returnDocument: 'after' }
        );
        if (!updated) return res.status(404).json({ success: false });
        if (safeEarned > 0) {
            await History.create({ tgId: Number(userId), type: 'game', label: 'Emoji Catcher', amount: safeEarned });
        }
        try { await bot.telegram.sendMessage(userId, `🎮 Game Over!\n🏆 ${safeEarned} ${cfg.currency_label} ရရှိပါပြီ!\n💰 Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, earned: safeEarned, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/game-end:", e);
        res.status(500).json({ success: false });
    }
});

// Earn history
app.post('/api/history', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        const logs = await History.find({ tgId: Number(userId) })
            .sort({ createdAt: -1 }).limit(30);
        res.json({ success: true, history: logs });
    } catch (e) {
        res.status(500).json({ error: 'Internal Error' });
    }
});

app.listen(port, () => console.log(`✅ Server listening on port ${port}`));

// ═══════════════════════════════════════════════
// BOT HELPERS
// ═══════════════════════════════════════════════

class TelegramApiError extends Error { constructor(m){ super(m); this.name='TelegramApiError'; } }

const joinCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
setInterval(() => { const now=Date.now(); for(const [k,v] of joinCache) if(now>=v.e) joinCache.delete(k); }, 10*60*1000);

async function withRetry(fn, retries=3, base=1000) {
    let last;
    for (let i=1; i<=retries; i++) {
        try { return await fn(); } catch(e) {
            last=e;
            const net = ['ETIMEDOUT','ECONNRESET','ENOTFOUND','ECONNREFUSED','EAI_AGAIN'].includes(e.code)
                || (e.message||'').includes('ETIMEDOUT');
            if (!net || i===retries) break;
            await new Promise(r=>setTimeout(r, base*Math.pow(2,i-1)));
        }
    }
    throw new TelegramApiError(`Telegram API retry failed: ${last?.message}`);
}

async function isJoined(ctx, channelId) {
    const uid = ctx.from.id;
    const cacheKey = `${uid}_${channelId}`;
    const cached = joinCache.get(cacheKey);
    if (cached && Date.now() < cached.e) return cached.v;
    const member = await withRetry(() => ctx.telegram.getChatMember(channelId, uid));
    const joined = !['left','kicked'].includes(member.status);
    if (joined) joinCache.set(cacheKey, { v:true, e:Date.now()+CACHE_TTL });
    return joined;
}

const isAdmin = ctx => String(ctx.from.id) === ADMIN_ID;
bot.catch((err, ctx) => console.error(`⚠️ Bot Error (${ctx.updateType}): ${err.message}`));

// ═══════════════════════════════════════════════
// /start COMMAND (with withdraw deep link support)
// ═══════════════════════════════════════════════

bot.start(async (ctx) => {
    try {
        const tgId = ctx.from.id;
        const uname = ctx.from.first_name || 'User';
        const startPayload = ctx.startPayload;
        const cfg = await getAllCfg();

        // ★ LOGIC 1: Handle /start withdraw deep link from TheNetCoinMM mini app
        if (startPayload === 'withdraw') {
            let user = await User.findOne({ tgId });
            if (!user) {
                user = await User.create({ tgId, username: uname });
            }
            if (user.isBanned) return ctx.reply("🚫 သင်သည် ပိတ်ပင်ခြင်း ခံထားရပါသည်။").catch(()=>{});

            const minW = cfg.min_withdraw || 1000;
            const hasEnough = user.balance >= minW;

            const msg = `📤 <b>ငွေထုတ်ယူရန်</b>\n\n`
                + `👤 ${uname}\n`
                + `💰 Balance: <b>${user.balance.toLocaleString()} ${cfg.currency_label}</b>\n\n`
                + `⚠️ Minimum: <b>${minW.toLocaleString()} ${cfg.currency_label}</b>\n\n`
                + (hasEnough
                    ? `✅ ငွေထုတ်ယူနိုင်ပါပြီ!\n📲 KPay / Wave Pay နံပါတ်ကို ပေးပို့ပါ`
                    : `❌ Balance မလောက်သေးပါ\n${minW - user.balance} ${cfg.currency_label} ပိုရှာရပါဦးမည်`
                );

            const buttons = hasEnough
                ? [[Markup.button.callback('📤 ငွေထုတ်ယူရန် (Request)', 'withdraw_request')]]
                : [[Markup.button.webApp('💸 App ပြန်သွားပြီး Earn ရယူပါ', 'https://the-netcoinmm.vercel.app/')]];

            return ctx.reply(msg, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(buttons)
            }).catch(()=>{});
        }

        // Normal /start flow
        let existingUser = await User.findOne({ tgId });
        if (!existingUser) {
            let referredBy = null;
            if (startPayload && startPayload.startsWith('ref_')) {
                referredBy = parseInt(startPayload.replace('ref_', ''));
                if (isNaN(referredBy) || referredBy === tgId) referredBy = null;
            }
            existingUser = await User.create({ tgId, username: uname, referredBy });
            if (referredBy) {
                const reward = cfg.referral_reward;
                const inviter = await User.findOneAndUpdate(
                    { tgId: referredBy },
                    { $inc: { balance: reward, referralCount: 1 } },
                    { returnDocument: 'after' }
                );
                if (inviter) {
                    await History.create({ tgId: referredBy, type: 'referral', label: `Invited ${uname}`, amount: reward });
                    try { await bot.telegram.sendMessage(referredBy,
                        `🎉 ${uname} ကို ဖိတ်ခေါ်မှုအတွက် ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 Balance: ${inviter.balance.toLocaleString()} ${cfg.currency_label}`);
                    } catch(e){}
                }
            }
        }

        if (existingUser.isBanned) return ctx.reply("🚫 သင်သည် ပိတ်ပင်ခြင်း ခံထားရပါသည်။").catch(()=>{});

        await ctx.reply(
            "👋 မင်္ဂလာပါ!\n\nBot ကို အသုံးပြုနိုင်ရန် ကျွန်ုပ်တို့၏ Channel ကို အရင် Join ပေးပါ 👇",
            Markup.inlineKeyboard([
                [Markup.button.url(`📲 ${cfg.channel1_name} Join ပါ`, cfg.channel1_link)],
                [Markup.button.callback('✅ စစ်ဆေးမည် (Joined)', 'check_join')]
            ])
        ).catch(()=>{});
    } catch(e) { console.error("❌ /start:", e); }
});

// Withdraw request action
bot.action('withdraw_request', async (ctx) => {
    try {
        const tgId = ctx.from.id;
        const cfg = await getAllCfg();
        const user = await User.findOne({ tgId });
        if (!user) return ctx.answerCbQuery("❌ User not found", { show_alert: true }).catch(()=>{});

        const minW = cfg.min_withdraw || 1000;
        if (user.balance < minW) {
            return ctx.answerCbQuery(`❌ Balance မလောက်ပါ (${minW} ${cfg.currency_label} လိုသည်)`, { show_alert: true }).catch(()=>{});
        }

        await ctx.answerCbQuery().catch(()=>{});
        await User.updateOne({ tgId }, { $set: { state: 'awaiting_withdraw' } });
        await ctx.reply(
            `📤 <b>ငွေထုတ်ယူရန်</b>\n\n`
            + `💰 Balance: <b>${user.balance.toLocaleString()} ${cfg.currency_label}</b>\n\n`
            + `📲 KPay သို့မဟုတ် Wave Pay နံပါတ်ကို ရိုက်ထည့်ပေးပါ:\n\n`
            + `<i>Example: 09xxxxxxxxx (KPay)</i>`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_withdraw')]]) }
        ).catch(()=>{});
    } catch(e) { console.error("❌ withdraw_request:", e); }
});

// Cancel withdraw
bot.action('cancel_withdraw', async (ctx) => {
    try {
        await User.updateOne({ tgId: ctx.from.id }, { $set: { state: 'none' } });
        await ctx.answerCbQuery('❌ ပယ်ဖျက်လိုက်ပါပြီ').catch(()=>{});
        await ctx.reply('❌ ငွေထုတ်မည့် Request ကို ပယ်ဖျက်လိုက်ပါပြီ').catch(()=>{});
    } catch(e) {}
});

bot.action('check_join', async (ctx) => {
    try {
        const cfg = await getAllCfg();
        let joined;
        try { joined = await isJoined(ctx, cfg.channel1_id); }
        catch(e) {
            if (e instanceof TelegramApiError)
                return ctx.answerCbQuery("⚠️ ယာယီ ချိတ်ဆက်မှု အခက်အခဲရှိနေပါသည်။", { show_alert:true }).catch(()=>{});
            throw e;
        }
        if (joined) {
            try { await ctx.deleteMessage(); } catch(e){}
            await ctx.reply(
                "✅ Channel Join ပြီးပါပြီ!\n\nCoins ရှာရန် 👇",
                Markup.inlineKeyboard([
                    [Markup.button.webApp('💸 Mini App ဖွင့်မည်', 'https://the-netcoinmm.vercel.app/')]
                ])
            ).catch(()=>{});
        } else {
            await ctx.answerCbQuery("⚠️ Channel ကို Join ရပါမည်!", { show_alert:true }).catch(()=>{});
        }
    } catch(e) { console.error("❌ check_join:", e); }
});

// ═══════════════════════════════════════════════
// ★ ADMIN COMMANDS
// ═══════════════════════════════════════════════

// ★ /admin — Show full command list
bot.command('admin', async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin Only").catch(()=>{});
    const cfg = await getAllCfg();
    const total = await User.countDocuments();
    const msg = `👑 <b>Admin Commands</b>\n`
        + `━━━━━━━━━━━━━━━━━━━\n`
        + `📊 Users: <b>${total}</b> | 💱 Currency: <b>${cfg.currency_label}</b>\n\n`

        + `<b>📺 Reward Settings</b>\n`
        + `/setadreward [n] — Ad ဆု (လက်ရှိ: ${cfg.ad_reward})\n`
        + `/setvideoreward [n] — Video Task ဆု (လက်ရှိ: ${cfg.ad_reward*2})\n`
        + `/setcheckinreward [n] — Check-in ဆု (လက်ရှိ: ${cfg.checkin_reward})\n`
        + `/setreferralreward [n] — Referral ဆု (လက်ရှိ: ${cfg.referral_reward})\n`
        + `/setjoinreward [n] — Channel Join ဆု (လက်ရှိ: ${cfg.join_reward})\n`
        + `/setgamefee [n] — Game Fee (လက်ရှိ: ${cfg.game_entry_fee})\n`
        + `/setgamemax [n] — Game Max Earn (လက်ရှိ: ${cfg.game_max_earn})\n\n`

        + `<b>⏱️ Cooldown Settings</b>\n`
        + `/setadcooldown [s] — Ad Cooldown (လက်ရှိ: ${cfg.ad_cooldown_s}s)\n`
        + `/setvideocooldown [s] — Video Cooldown (လက်ရှိ: ${cfg.video_cooldown_s}s)\n`
        + `/setaddaily [n] — Daily Ad Limit (လက်ရှိ: ${cfg.ad_daily_limit})\n\n`

        + `<b>💱 Display Settings</b>\n`
        + `/setcurrency [label] — Currency Label ပြောင်းရန် (လက်ရှိ: ${cfg.currency_label})\n`
        + `   └─ Example: /setcurrency MMK  ➜  frontend မှာ MMK ပြလိမ့်မည်\n`
        + `/setminwithdraw [n] — Min Withdraw (လက်ရှိ: ${cfg.min_withdraw})\n\n`

        + `<b>📢 Channel Settings</b>\n`
        + `/setchannel1 [@id] [name] [link]\n`
        + `/setchannel2 [@id] [name] [link]\n\n`

        + `<b>👥 User Management</b>\n`
        + `/users [page] — User list\n`
        + `/user [id] — User detail\n`
        + `/addbalance [id] [amount] — Balance ထည့်ပေးရန်\n`
        + `/ban [id] — Ban user\n`
        + `/unban [id] — Unban user\n\n`

        + `<b>📨 Messaging</b>\n`
        + `/send [id] [msg] — User တစ်ယောက်ဆီ ပို့ရန်\n`
        + `/broadcast [msg] — User အားလုံးဆီ ပို့ရန်\n\n`

        + `<b>📊 Statistics</b>\n`
        + `/stats — အသုံးပြုသူ စာရင်း အကျဉ်းချုပ်\n`
        + `/panel — Admin Panel (သတ်မှတ်ချက် အကုန်)\n`;

    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(()=>{});
});

// /stats — Quick stats
bot.command('stats', async ctx => {
    if (!isAdmin(ctx)) return;
    const cfg = await getAllCfg();
    const total = await User.countDocuments();
    const banned = await User.countDocuments({ isBanned: true });
    const today = new Date(); today.setHours(0,0,0,0);
    const newToday = await User.countDocuments({ lastActive: { $gte: today } });
    const topUsers = await User.find().sort({ balance: -1 }).limit(5);
    let msg = `📊 <b>Statistics</b>\n━━━━━━━━━━━━━━\n`
        + `👥 Total Users: <b>${total}</b>\n`
        + `🚫 Banned: <b>${banned}</b>\n`
        + `📅 Active Today: <b>${newToday}</b>\n`
        + `💱 Currency: <b>${cfg.currency_label}</b>\n\n`
        + `🏆 <b>Top 5 Balances</b>\n`;
    topUsers.forEach((u,i) => {
        msg += `${i+1}. ${u.username||'User'} — ${u.balance.toLocaleString()} ${cfg.currency_label}\n`;
    });
    ctx.reply(msg, { parse_mode: 'HTML' });
});

// /panel — Full config panel
bot.command('panel', async ctx => {
    if (!isAdmin(ctx)) return;
    const total = await User.countDocuments();
    const cfg = await getAllCfg();
    const msg = `👑 <b>Admin Panel</b>\n\n📊 Users: ${total} | 💱 Currency: ${cfg.currency_label}\n\n`
        + `<b>── Channels ──</b>\n`
        + `/setchannel1 [@id] [name] [link]\n`
        + `/setchannel2 [@id] [name] [link]\n\n`
        + `<b>── Rewards ──</b>\n`
        + `/setjoinreward [n] — Join (${cfg.join_reward})\n`
        + `/setadreward [n] — Ad (${cfg.ad_reward})\n`
        + `/setvideoreward [n] — Video task (${cfg.ad_reward*2})\n`
        + `/setcheckinreward [n] — Check-in (${cfg.checkin_reward})\n`
        + `/setreferralreward [n] — Referral (${cfg.referral_reward})\n`
        + `/setgamefee [n] — Game fee (${cfg.game_entry_fee})\n`
        + `/setgamemax [n] — Game max (${cfg.game_max_earn})\n\n`
        + `<b>── Cooldowns ──</b>\n`
        + `/setadcooldown [s] — Ad (${cfg.ad_cooldown_s}s)\n`
        + `/setvideocooldown [s] — Video (${cfg.video_cooldown_s}s)\n`
        + `/setaddaily [n] — Daily ad limit (${cfg.ad_daily_limit})\n\n`
        + `<b>── Display ──</b>\n`
        + `/setcurrency [label] — (${cfg.currency_label})\n`
        + `/setminwithdraw [n] — Min withdraw (${cfg.min_withdraw})\n\n`
        + `<b>── Users ──</b>\n`
        + `/users [page] | /user [id] | /ban [id] | /unban [id]\n`
        + `/addbalance [id] [n] | /send [id] [msg] | /broadcast [msg]`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('setchannel1', async ctx => {
    if (!isAdmin(ctx)) return;
    const p = ctx.message.text.split(' ');
    if (p.length < 4) return ctx.reply("⚠️ /setchannel1 [@id] [name] [link]");
    await setCfg('channel1_id', p[1]); await setCfg('channel1_name', p[2]); await setCfg('channel1_link', p[3]);
    ctx.reply(`✅ Channel 1 → ${p[1]} | ${p[2]}`);
});
bot.command('setchannel2', async ctx => {
    if (!isAdmin(ctx)) return;
    const p = ctx.message.text.split(' ');
    if (p.length < 4) return ctx.reply("⚠️ /setchannel2 [@id] [name] [link]");
    await setCfg('channel2_id', p[1]); await setCfg('channel2_name', p[2]); await setCfg('channel2_link', p[3]);
    ctx.reply(`✅ Channel 2 → ${p[1]} | ${p[2]}`);
});
bot.command('setjoinreward', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setjoinreward [n]");
    await setCfg('join_reward', v); ctx.reply(`✅ Join reward → ${v}`);
});
bot.command('setadreward', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setadreward [n]");
    await setCfg('ad_reward', v);
    const cfg = await getAllCfg();
    ctx.reply(`✅ Ad reward → ${v} ${cfg.currency_label}\n📺 Video Task → ${v*2} ${cfg.currency_label}\n\n💡 Frontend မှာ ဤ reward တန်ဖိုး auto-update ဖြစ်ပါမည်`);
});
// ★ /setvideoreward is computed from ad_reward, but we allow override
bot.command('setvideoreward', async ctx => {
    if (!isAdmin(ctx)) return;
    ctx.reply(
        "ℹ️ Video reward = Ad reward × 2\n\n" +
        "Ad reward ကို ပြောင်းရန်:\n/setadreward [n]\n\n" +
        "Example: /setadreward 200 → Video task = 400"
    );
});
bot.command('setcheckinreward', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setcheckinreward [n]");
    await setCfg('checkin_reward', v); ctx.reply(`✅ Check-in reward → ${v}`);
});
bot.command('setreferralreward', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setreferralreward [n]");
    await setCfg('referral_reward', v); ctx.reply(`✅ Referral reward → ${v}`);
});
bot.command('setgamefee', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setgamefee [n]");
    await setCfg('game_entry_fee', v); ctx.reply(`✅ Game fee → ${v}`);
});
bot.command('setgamemax', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setgamemax [n]");
    await setCfg('game_max_earn', v); ctx.reply(`✅ Game max earn → ${v}`);
});
bot.command('setadcooldown', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setadcooldown [seconds]");
    await setCfg('ad_cooldown_s', v); ctx.reply(`✅ Ad cooldown → ${v}s`);
});
bot.command('setvideocooldown', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setvideocooldown [seconds]");
    await setCfg('video_cooldown_s', v); ctx.reply(`✅ Video cooldown → ${v}s`);
});
bot.command('setaddaily', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setaddaily [n]");
    await setCfg('ad_daily_limit', v); ctx.reply(`✅ Daily ad limit → ${v}`);
});

// ★ /setcurrency — Changes display label across entire frontend
bot.command('setcurrency', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!v) return ctx.reply("⚠️ /setcurrency [label]\n\nExample:\n/setcurrency MMK\n/setcurrency Coins\n/setcurrency KS\n\nFrontend ကို Refresh လုပ်ရင် ချက်ချင်း ပြောင်းသည်");
    await setCfg('currency_label', v);
    ctx.reply(
        `✅ Currency label → <b>${v}</b>\n\n`
        + `Frontend ပြောင်းချက်:\n`
        + `• Balance: 0 <b>${v}</b>\n`
        + `• Ad Reward: +20 <b>${v}</b>\n`
        + `• Check-in: +10 <b>${v}</b>\n`
        + `• Invite: +50 <b>${v}</b>\n\n`
        + `⚡ Mini App ကို Refresh လုပ်ရင် ချက်ချင်း ပြောင်းပါမည်`,
        { parse_mode: 'HTML' }
    );
});

// ★ /setminwithdraw
bot.command('setminwithdraw', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setminwithdraw [n]");
    await setCfg('min_withdraw', v);
    const cfg = await getAllCfg();
    ctx.reply(`✅ Min withdraw → ${v} ${cfg.currency_label}`);
});

bot.command('addbalance', async ctx => {
    if (!isAdmin(ctx)) return;
    const p = ctx.message.text.split(' ');
    if (p.length < 3) return ctx.reply("⚠️ /addbalance [user_id] [amount]");
    const uid = parseInt(p[1]), amount = parseInt(p[2]);
    if (isNaN(uid)||isNaN(amount)) return ctx.reply("❌ Invalid");
    const cfg = await getAllCfg();
    const updated = await User.findOneAndUpdate({ tgId:uid }, { $inc:{balance:amount} }, { returnDocument:'after' });
    if (!updated) return ctx.reply("❌ User not found");
    ctx.reply(`✅ +${amount} ${cfg.currency_label} → Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`);
    try { await bot.telegram.sendMessage(uid, `💰 Admin မှ ${amount} ${cfg.currency_label} ထည့်ပေးလိုက်ပါတယ်!\n💰 Balance: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
});
bot.command('users', async ctx => {
    if (!isAdmin(ctx)) return;
    const page = parseInt(ctx.message.text.split(' ')[1]) || 1;
    const limit=10, skip=(page-1)*limit;
    const users = await User.find().skip(skip).limit(limit).sort({tgId:1});
    const total = await User.countDocuments();
    const cfg = await getAllCfg();
    let msg = `👥 <b>Users (${page}/${Math.ceil(total/limit)})</b>\n\n`;
    users.forEach(u => { msg += `🆔 <code>${u.tgId}</code> | ${u.username||'NoName'} | 💰${u.balance} ${cfg.currency_label} | ${u.isBanned?'🚫':'✅'}\n`; });
    ctx.reply(msg, { parse_mode:'HTML' });
});
bot.command('user', async ctx => {
    if (!isAdmin(ctx)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(uid)) return ctx.reply("⚠️ /user [id]");
    const u = await User.findOne({ tgId:uid });
    if (!u) return ctx.reply("❌ Not found.");
    const cfg = await getAllCfg();
    ctx.reply(`👤 <b>User</b>\n🆔 <code>${u.tgId}</code>\n👤 ${u.username||'N/A'}\n💰 ${u.balance.toLocaleString()} ${cfg.currency_label}\n👥 Refs: ${u.referralCount}\n🚫 Banned: ${u.isBanned}`, { parse_mode:'HTML' });
});
bot.command('ban', async ctx => {
    if (!isAdmin(ctx)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(uid)) return ctx.reply("⚠️ /ban [id]");
    const u = await User.findOne({ tgId:uid });
    if (!u) return ctx.reply("❌ Not found.");
    if (u.isBanned) return ctx.reply("✅ Already banned.");
    await User.updateOne({ tgId:uid }, { $set:{isBanned:true} });
    ctx.reply(`🚫 Banned ${uid}`);
    try { await bot.telegram.sendMessage(uid, "🚫 သင်သည် ပိတ်ပင်ခြင်း ခံထားရပါသည်။"); } catch(e){}
});
bot.command('unban', async ctx => {
    if (!isAdmin(ctx)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(uid)) return ctx.reply("⚠️ /unban [id]");
    const u = await User.findOne({ tgId:uid });
    if (!u) return ctx.reply("❌ Not found.");
    if (!u.isBanned) return ctx.reply("✅ Not banned.");
    await User.updateOne({ tgId:uid }, { $set:{isBanned:false} });
    ctx.reply(`✅ Unbanned ${uid}`);
    try { await bot.telegram.sendMessage(uid, "✅ အကောင့် ပြန်ဖွင့်ပေးလိုက်ပါပြီ။"); } catch(e){}
});
bot.command('send', async ctx => {
    if (!isAdmin(ctx)) return;
    const text = ctx.message.text;
    const rest = text.substring(text.indexOf(' ')+1).trim();
    const sp = rest.indexOf(' ');
    if (sp===-1) return ctx.reply("⚠️ /send [id] [msg]");
    const uid = parseInt(rest.substring(0,sp));
    const msg = rest.substring(sp+1).trim();
    if (isNaN(uid)) return ctx.reply("❌ Invalid id");
    try { await bot.telegram.sendMessage(uid, msg); ctx.reply(`✅ Sent to ${uid}`); }
    catch(e) { ctx.reply(`❌ Failed: ${e.message}`); }
});
bot.command('broadcast', async ctx => {
    if (!isAdmin(ctx)) return;
    const msg = ctx.message.text.split('/broadcast ')[1];
    if (!msg) return ctx.reply("⚠️ /broadcast [msg]");
    const users = await User.find({ isBanned:false });
    ctx.reply(`📨 Sending to ${users.length}...`);
    let ok=0, fail=0;
    for (const u of users) {
        try { await bot.telegram.sendMessage(u.tgId, msg); ok++; await new Promise(r=>setTimeout(r,50)); }
        catch(e) { fail++; }
    }
    ctx.reply(`✅ Done ✅${ok} ❌${fail}`);
});

// Global message handler (with withdraw state support)
bot.on('message', async ctx => {
    try {
        User.updateOne({ tgId:ctx.from.id }, { $set:{lastActive:new Date()} }).catch(()=>{});
        const user = await User.findOne({ tgId:ctx.from.id });
        if (!user || user.isBanned) return;

        // ★ Handle withdraw state: user is sending their payment number
        if (user.state === 'awaiting_withdraw') {
            const m = ctx.message;
            if (m.text && !m.text.startsWith('/')) {
                const cfg = await getAllCfg();
                const paymentInfo = m.text.trim();

                // Reset state
                await User.updateOne({ tgId: user.tgId }, { $set: { state: 'none' } });

                // Notify admin
                try {
                    await bot.telegram.sendMessage(
                        ADMIN_ID,
                        `📤 <b>Withdraw Request</b>\n`
                        + `━━━━━━━━━━━━━━\n`
                        + `🆔 <code>${user.tgId}</code>\n`
                        + `👤 ${user.username || 'N/A'}\n`
                        + `💰 Balance: ${user.balance.toLocaleString()} ${cfg.currency_label}\n`
                        + `📲 Payment: <b>${paymentInfo}</b>\n\n`
                        + `ဆောင်ရွက်ရန်:\n`
                        + `/addbalance ${user.tgId} [deduct_amount]`,
                        { parse_mode: 'HTML' }
                    );
                } catch(e) {}

                await ctx.reply(
                    `✅ <b>Request ပေးပို့ပြီးပါပြီ!</b>\n\n`
                    + `📲 Payment Info: <b>${paymentInfo}</b>\n`
                    + `💰 Balance: ${user.balance.toLocaleString()} ${cfg.currency_label}\n\n`
                    + `⏳ Admin မှ ၂၄ နာရီအတွင်း စစ်ဆေးပေးပါမည်`,
                    { parse_mode: 'HTML' }
                ).catch(()=>{});
            }
            return;
        }

        // Default: forward to admin
        if (user.state === 'none') {
            const m = ctx.message;
            try {
                if (m.text && !m.text.startsWith('/')) {
                    await bot.telegram.sendMessage(ADMIN_ID, `📨 Msg\n🆔 ${user.tgId}\n👤 ${user.username||'N/A'}\n💬 ${m.text}`);
                } else if (m.photo) {
                    await bot.telegram.sendPhoto(ADMIN_ID, m.photo[m.photo.length-1].file_id, { caption:`📨 Photo\n🆔 ${user.tgId}` });
                } else if (m.video) {
                    await bot.telegram.sendVideo(ADMIN_ID, m.video.file_id, { caption:`📨 Video\n🆔 ${user.tgId}` });
                } else if (m.document) {
                    await bot.telegram.sendDocument(ADMIN_ID, m.document.file_id, { caption:`📨 Doc\n🆔 ${user.tgId}` });
                }
            } catch(e) {}
        }
    } catch(e) { console.error("❌ msg handler:", e); }
});

bot.launch().then(() => console.log("🚀 Bot is Live!"));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
