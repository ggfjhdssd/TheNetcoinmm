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
    tgId:        { type: Number, unique: true },
    username:    String,
    balance:     { type: Number, default: 0 },
    referredBy:  { type: Number, default: null },
    referralCount:{ type: Number, default: 0 },
    isBanned:    { type: Boolean, default: false },
    state:       { type: String, default: 'none' },
    lastActive:  { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Global config stored in DB (admin-editable)
const configSchema = new mongoose.Schema({
    key:   { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const Config = mongoose.model('Config', configSchema);

// ── Default config values ──
const DEFAULT_CONFIG = {
    channel1_link:   'https://t.me/TheNetMyan',
    channel1_name:   'TheNetMyan',
    channel2_link:   'https://t.me/TheNetMyan',
    channel2_name:   'TheNetMyan 2',
    channel1_id:     '@TheNetMyan',
    channel2_id:     '@TheNetMyan',
    join_reward:     20,          // coins for joining channel
    ad_reward:       20,          // coins per ad watch
    ad_cooldown_s:   180,         // 3 min cooldown per watch
    ad_daily_limit:  4,           // watches per day
    ad_daily_reset_h:24,          // hours to reset full count
    referral_reward: 50,          // coins for inviting friend
    game_entry_fee:  50,          // coins to start game
    game_max_earn:   90,          // max coins per game
    spin_prizes:     [100,50,200,300,500,50,100,200],
    currency_label:  'Coins',     // display label
    video_cooldown_s:360,         // 6 min video cooldown
};

async function getCfg(key) {
    const doc = await Config.findOne({ key });
    return doc ? doc.value : DEFAULT_CONFIG[key];
}

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

// GET config for frontend
app.get('/api/config', async (req, res) => {
    try {
        const cfg = await getAllCfg();
        res.json(cfg);
    } catch (e) {
        res.status(500).json({ error: 'Config error' });
    }
});

// Get user info + balance
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
            isBanned: user.isBanned
        });
    } catch (e) {
        console.error("❌ /api/get-user:", e);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// Check channel join (both channels)
app.post('/api/check-join', async (req, res) => {
    try {
        const { userId, channel } = req.body; // channel: 1 or 2
        if (!userId) return res.status(400).json({ joined: false });
        const cfg = await getAllCfg();
        const channelId = channel === 2 ? cfg.channel2_id : cfg.channel1_id;
        try {
            const member = await bot.telegram.getChatMember(channelId, Number(userId));
            const joined = !['left', 'kicked'].includes(member.status);
            return res.json({ joined });
        } catch (e) {
            return res.json({ joined: false, error: e.message });
        }
    } catch (e) {
        res.status(500).json({ joined: false });
    }
});

// Claim channel join reward
app.post('/api/claim-join', async (req, res) => {
    try {
        const { userId, channel } = req.body;
        if (!userId) return res.status(400).json({ success: false });
        const cfg = await getAllCfg();
        const channelId = channel === 2 ? cfg.channel2_id : cfg.channel1_id;
        const claimKey = `claimed_channel_${channel}`;

        // Check already claimed via state field hack — use a separate claim tracking
        const user = await User.findOne({ tgId: Number(userId) });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const claimedChannels = user.claimedChannels || [];
        if (claimedChannels.includes(channel)) {
            return res.json({ success: false, error: 'already_claimed' });
        }

        // Verify joined
        try {
            const member = await bot.telegram.getChatMember(channelId, Number(userId));
            const joined = !['left', 'kicked'].includes(member.status);
            if (!joined) return res.json({ success: false, error: 'not_joined' });
        } catch (e) {
            return res.json({ success: false, error: 'check_failed' });
        }

        const reward = cfg.join_reward;
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: reward }, $push: { claimedChannels: channel } },
            { returnDocument: 'after' }
        );

        try { await bot.telegram.sendMessage(userId, `✅ Channel Join ဆုကြေး ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 လက်ကျန်: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
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
        try { await bot.telegram.sendMessage(userId, `📺 ကြော်ငြာ ${slot||''} ကြည့်မှုအတွက် ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 လက်ကျန်: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, rewardAmt: reward, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/reward-user:", e);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// Video task reward
app.post('/api/reward-video', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        const cfg = await getAllCfg();
        const reward = cfg.ad_reward * 2; // video reward = 2x ad reward
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: reward }, $set: { lastActive: new Date() } },
            { returnDocument: 'after' }
        );
        if (!updated) return res.status(404).json({ error: 'User not found' });
        try { await bot.telegram.sendMessage(userId, `🎬 ဗီဒီယိုကြည့်မှုအတွက် ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 လက်ကျန်: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, rewardAmt: reward, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/reward-video:", e);
        res.status(500).json({ error: 'Internal Error' });
    }
});

// Spin
app.post('/api/spin', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ success: false, error: 'User ID required' });
        const cfg = await getAllCfg();
        const prizes = cfg.spin_prizes;
        const idx = Math.floor(Math.random() * prizes.length);
        const prize = prizes[idx];
        const updated = await User.findOneAndUpdate(
            { tgId: Number(userId) },
            { $inc: { balance: prize }, $set: { lastActive: new Date() } },
            { returnDocument: 'after', upsert: false }
        );
        if (!updated) return res.status(404).json({ success: false, error: 'User not found' });
        try { await bot.telegram.sendMessage(userId, `🎰 Lucky Spin မှ ${prize} ${cfg.currency_label} ရရှိပါတယ်!\n💰 လက်ကျန်: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, prize, newBalance: updated.balance, prizeIndex: idx });
    } catch (e) {
        console.error("❌ /api/spin:", e);
        res.status(500).json({ success: false, error: 'Internal Error' });
    }
});

// Game: deduct entry fee + save result
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
        try { await bot.telegram.sendMessage(userId, `🎮 Game ပြီးသွားပါပြီ!\n🏆 ရရှိတဲ့ ${cfg.currency_label}: ${safeEarned}\n💰 လက်ကျန်: ${updated.balance.toLocaleString()} ${cfg.currency_label}`); } catch(e){}
        return res.json({ success: true, earned: safeEarned, newBalance: updated.balance });
    } catch (e) {
        console.error("❌ /api/game-end:", e);
        res.status(500).json({ success: false });
    }
});

// Referral reward (called when invited user starts bot)
// handled in bot /start command — no API needed

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
// /start — with referral handling
// ═══════════════════════════════════════════════
bot.start(async (ctx) => {
    try {
        const tgId = ctx.from.id;
        const uname = ctx.from.first_name || 'User';
        const startPayload = ctx.startPayload; // ref_123456
        const cfg = await getAllCfg();

        let existingUser = await User.findOne({ tgId });

        // Create user if new
        if (!existingUser) {
            let referredBy = null;
            if (startPayload && startPayload.startsWith('ref_')) {
                referredBy = parseInt(startPayload.replace('ref_', ''));
                if (isNaN(referredBy) || referredBy === tgId) referredBy = null;
            }
            existingUser = await User.create({ tgId, username: uname, referredBy });

            // Give referral reward to inviter
            if (referredBy) {
                const reward = cfg.referral_reward;
                const inviter = await User.findOneAndUpdate(
                    { tgId: referredBy },
                    { $inc: { balance: reward, referralCount: 1 } },
                    { returnDocument: 'after' }
                );
                if (inviter) {
                    try { await bot.telegram.sendMessage(referredBy,
                        `🎉 သူငယ်ချင်း ${uname} ဖိတ်ခေါ်မှုအတွက် ${reward} ${cfg.currency_label} ရရှိပါတယ်!\n💰 လက်ကျန်: ${inviter.balance.toLocaleString()} ${cfg.currency_label}`);
                    } catch(e){}
                }
            }
        }

        if (existingUser.isBanned) {
            return ctx.reply("🚫 သင်သည် စည်းကမ်းဖောက်ဖျက်မှုကြောင့် အသုံးပြုခွင့် ပိတ်ပင်ခံထားရပါသည်။").catch(()=>{});
        }

        await ctx.reply(
            "👋 မင်္ဂလာပါ!\n\nBot ကို အသုံးပြုနိုင်ရန် ကျွန်ုပ်တို့၏ Channel ကို အရင် Join ပေးပါ 👇",
            Markup.inlineKeyboard([
                [Markup.button.url(`📲 ${cfg.channel1_name} Join ပါ`, cfg.channel1_link)],
                [Markup.button.callback('✅ စစ်ဆေးမည် (Joined)', 'check_join')]
            ])
        ).catch(()=>{});
    } catch(e) { console.error("❌ /start:", e); }
});

bot.action('check_join', async (ctx) => {
    try {
        const cfg = await getAllCfg();
        let joined;
        try { joined = await isJoined(ctx, cfg.channel1_id); }
        catch(e) {
            if (e instanceof TelegramApiError)
                return ctx.answerCbQuery("⚠️ ယာယီ ချိတ်ဆက်မှု အခက်အခဲရှိနေပါသည်။ ခဏ စောင့်ပြီး ထပ်ကြိုးစားပါ။", { show_alert:true }).catch(()=>{});
            throw e;
        }
        if (joined) {
            try { await ctx.deleteMessage(); } catch(e){}
            await ctx.reply(
                "✅ Channel Join ပြီးပါပြီ!\n\nကြော်ငြာကြည့်ပြီးပိုက်ဆံရှာရန် 👇",
                Markup.inlineKeyboard([
                    [Markup.button.webApp('💸 Mini App ဖွင့်မည်', `https://the-netcoinmm.vercel.app/`)]
                ])
            ).catch(()=>{});
        } else {
            await ctx.answerCbQuery("⚠️ Channel ကို Join ရပါမည်!", { show_alert:true }).catch(()=>{});
        }
    } catch(e) { console.error("❌ check_join:", e); }
});

// ═══════════════════════════════════════════════
// ADMIN COMMANDS
// ═══════════════════════════════════════════════

bot.command('panel', async ctx => {
    if (!isAdmin(ctx)) return;
    const total = await User.countDocuments();
    const cfg = await getAllCfg();
    const msg = `👑 <b>Admin Panel</b>\n\n📊 Total Users: ${total}\n💱 Currency: ${cfg.currency_label}\n\n`
        + `<b>── Channel Settings ──</b>\n`
        + `/setchannel1 [id] [name] [link]\n`
        + `/setchannel2 [id] [name] [link]\n\n`
        + `<b>── Reward Settings ──</b>\n`
        + `/setjoinreward [coins] — Channel join ဆု (လက်ရှိ: ${cfg.join_reward})\n`
        + `/setadreward [coins] — Ad ဆု (လက်ရှိ: ${cfg.ad_reward})\n`
        + `/setreferralreward [coins] — Referral ဆု (လက်ရှိ: ${cfg.referral_reward})\n`
        + `/setgamefee [coins] — Game entry fee (လက်ရှိ: ${cfg.game_entry_fee})\n`
        + `/setgamemax [coins] — Game max earn (လက်ရှိ: ${cfg.game_max_earn})\n\n`
        + `<b>── Cooldown Settings ──</b>\n`
        + `/setadcooldown [seconds] — Ad cooldown (လက်ရှိ: ${cfg.ad_cooldown_s}s)\n`
        + `/setvideocooldown [seconds] — Video cooldown (လက်ရှိ: ${cfg.video_cooldown_s}s)\n`
        + `/setaddaily [count] — Daily ad limit (လက်ရှိ: ${cfg.ad_daily_limit})\n\n`
        + `<b>── Display ──</b>\n`
        + `/setcurrency [label] — Currency label (လက်ရှိ: ${cfg.currency_label})\n\n`
        + `<b>── Users ──</b>\n`
        + `/users [page] | /user [id] | /ban [id] | /unban [id]\n`
        + `/addbalance [id] [amount] | /send [id] [msg] | /broadcast [msg]`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
});

// Channel settings
bot.command('setchannel1', async ctx => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply("⚠️ /setchannel1 [@channel_id] [name] [https://link]");
    await setCfg('channel1_id', parts[1]);
    await setCfg('channel1_name', parts[2]);
    await setCfg('channel1_link', parts[3]);
    ctx.reply(`✅ Channel 1 → ID: ${parts[1]}, Name: ${parts[2]}, Link: ${parts[3]}`);
});
bot.command('setchannel2', async ctx => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply("⚠️ /setchannel2 [@channel_id] [name] [https://link]");
    await setCfg('channel2_id', parts[1]);
    await setCfg('channel2_name', parts[2]);
    await setCfg('channel2_link', parts[3]);
    ctx.reply(`✅ Channel 2 → ID: ${parts[1]}, Name: ${parts[2]}, Link: ${parts[3]}`);
});

// Reward settings
bot.command('setjoinreward', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setjoinreward [coins]");
    await setCfg('join_reward', v); ctx.reply(`✅ Join reward → ${v} coins`);
});
bot.command('setadreward', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setadreward [coins]");
    await setCfg('ad_reward', v); ctx.reply(`✅ Ad reward → ${v} coins`);
});
bot.command('setreferralreward', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setreferralreward [coins]");
    await setCfg('referral_reward', v); ctx.reply(`✅ Referral reward → ${v} coins`);
});
bot.command('setgamefee', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setgamefee [coins]");
    await setCfg('game_entry_fee', v); ctx.reply(`✅ Game entry fee → ${v} coins`);
});
bot.command('setgamemax', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setgamemax [coins]");
    await setCfg('game_max_earn', v); ctx.reply(`✅ Game max earn → ${v} coins`);
});

// Cooldown settings
bot.command('setadcooldown', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setadcooldown [seconds]");
    await setCfg('ad_cooldown_s', v); ctx.reply(`✅ Ad cooldown → ${v}s (${Math.round(v/60)} min)`);
});
bot.command('setvideocooldown', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setvideocooldown [seconds]");
    await setCfg('video_cooldown_s', v); ctx.reply(`✅ Video cooldown → ${v}s (${Math.round(v/60)} min)`);
});
bot.command('setaddaily', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(v)) return ctx.reply("⚠️ /setaddaily [count]");
    await setCfg('ad_daily_limit', v); ctx.reply(`✅ Daily ad limit → ${v} times`);
});

// Currency label
bot.command('setcurrency', async ctx => {
    if (!isAdmin(ctx)) return;
    const v = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!v) return ctx.reply("⚠️ /setcurrency [label]\nExample: /setcurrency MMK");
    await setCfg('currency_label', v); ctx.reply(`✅ Currency label → ${v}`);
});

// Add balance
bot.command('addbalance', async ctx => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) return ctx.reply("⚠️ /addbalance [user_id] [amount]");
    const uid = parseInt(parts[1]), amount = parseInt(parts[2]);
    if (isNaN(uid)||isNaN(amount)) return ctx.reply("❌ Invalid values");
    const updated = await User.findOneAndUpdate({ tgId:uid }, { $inc:{balance:amount} }, { returnDocument:'after' });
    if (!updated) return ctx.reply("❌ User not found");
    ctx.reply(`✅ User ${uid} balance +${amount} → ${updated.balance}`);
    try { await bot.telegram.sendMessage(uid, `💰 Admin မှ ${amount} ထည့်ပေးလိုက်ပါတယ်!\n💰 လက်ကျန်: ${updated.balance.toLocaleString()}`); } catch(e){}
});

// User management
bot.command('users', async ctx => {
    if (!isAdmin(ctx)) return;
    const page = parseInt(ctx.message.text.split(' ')[1]) || 1;
    const limit=10, skip=(page-1)*limit;
    const users = await User.find().skip(skip).limit(limit).sort({tgId:1});
    const total = await User.countDocuments();
    let msg = `👥 <b>Users (Page ${page}/${Math.ceil(total/limit)})</b>\n\n`;
    users.forEach(u => { msg += `🆔 <code>${u.tgId}</code> | ${u.username||'NoName'} | 💰${u.balance} | ${u.isBanned?'🚫':'✅'}\n`; });
    ctx.reply(msg, { parse_mode:'HTML' });
});

bot.command('user', async ctx => {
    if (!isAdmin(ctx)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(uid)) return ctx.reply("⚠️ /user [user_id]");
    const u = await User.findOne({ tgId:uid });
    if (!u) return ctx.reply("❌ User not found.");
    const cfg = await getAllCfg();
    ctx.reply(`👤 <b>User</b>\n🆔 <code>${u.tgId}</code>\n👤 ${u.username||'N/A'}\n💰 Balance: ${u.balance} ${cfg.currency_label}\n👥 Referrals: ${u.referralCount}\n🚫 Banned: ${u.isBanned}`, { parse_mode:'HTML' });
});

bot.command('ban', async ctx => {
    if (!isAdmin(ctx)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(uid)) return ctx.reply("⚠️ /ban [user_id]");
    const u = await User.findOne({ tgId:uid });
    if (!u) return ctx.reply("❌ Not found.");
    if (u.isBanned) return ctx.reply("✅ Already banned.");
    await User.updateOne({ tgId:uid }, { $set:{isBanned:true,state:'none'} });
    ctx.reply(`🚫 User ${uid} banned.`);
    try { await bot.telegram.sendMessage(uid, "🚫 သင်သည် ပိတ်ပင်ခြင်း ခံထားရပါသည်။"); } catch(e){}
});

bot.command('unban', async ctx => {
    if (!isAdmin(ctx)) return;
    const uid = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(uid)) return ctx.reply("⚠️ /unban [user_id]");
    const u = await User.findOne({ tgId:uid });
    if (!u) return ctx.reply("❌ Not found.");
    if (!u.isBanned) return ctx.reply("✅ Not banned.");
    await User.updateOne({ tgId:uid }, { $set:{isBanned:false} });
    ctx.reply(`✅ User ${uid} unbanned.`);
    try { await bot.telegram.sendMessage(uid, "✅ သင့်အကောင့်ကို ပြန်ဖွင့်ပေးလိုက်ပါပြီ။"); } catch(e){}
});

bot.command('send', async ctx => {
    if (!isAdmin(ctx)) return;
    const text = ctx.message.text;
    const rest = text.substring(text.indexOf(' ')+1).trim();
    const sp = rest.indexOf(' ');
    if (sp===-1) return ctx.reply("⚠️ /send [user_id] [msg]");
    const uid = parseInt(rest.substring(0,sp));
    const msg = rest.substring(sp+1).trim();
    if (isNaN(uid)) return ctx.reply("❌ Invalid user_id");
    try { await bot.telegram.sendMessage(uid, msg); ctx.reply(`✅ Sent to ${uid}`); }
    catch(e) { ctx.reply(`❌ Failed: ${e.message}`); }
});

bot.command('broadcast', async ctx => {
    if (!isAdmin(ctx)) return;
    const msg = ctx.message.text.split('/broadcast ')[1];
    if (!msg) return ctx.reply("⚠️ /broadcast [message]");
    const users = await User.find({ isBanned:false });
    ctx.reply(`📨 Broadcasting to ${users.length} users...`);
    let ok=0, fail=0;
    for (const u of users) {
        try { await bot.telegram.sendMessage(u.tgId, msg); ok++; await new Promise(r=>setTimeout(r,50)); }
        catch(e) { fail++; }
    }
    ctx.reply(`✅ Done. ✅${ok} ❌${fail}`);
});

// ═══════════════════════════════════════════════
// GLOBAL MESSAGE → Forward to admin
// ═══════════════════════════════════════════════
bot.on('message', async ctx => {
    try {
        User.updateOne({ tgId:ctx.from.id }, { $set:{lastActive:new Date()} }).catch(()=>{});
        const user = await User.findOne({ tgId:ctx.from.id });
        if (!user || user.isBanned) return;
        if (user.state === 'none') {
            const m = ctx.message;
            try {
                if (m.text && !m.text.startsWith('/')) {
                    await bot.telegram.sendMessage(ADMIN_ID, `📨 User Msg\n🆔 ${user.tgId}\n👤 ${user.username||'N/A'}\n💬 ${m.text}`);
                } else if (m.photo) {
                    await bot.telegram.sendPhoto(ADMIN_ID, m.photo[m.photo.length-1].file_id, { caption:`📨 Photo\n🆔 ${user.tgId}\n👤 ${user.username||'N/A'}` });
                } else if (m.video) {
                    await bot.telegram.sendVideo(ADMIN_ID, m.video.file_id, { caption:`📨 Video\n🆔 ${user.tgId}` });
                } else if (m.document) {
                    await bot.telegram.sendDocument(ADMIN_ID, m.document.file_id, { caption:`📨 Doc\n🆔 ${user.tgId}` });
                }
            } catch(e) { console.error("Forward error:", e); }
        }
    } catch(e) { console.error("❌ msg handler:", e); }
});

// Add claimedChannels to schema dynamically (migration friendly)
userSchema.add({ claimedChannels: { type: [Number], default: [] } });

bot.launch().then(() => console.log("🚀 Bot is Live!"));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
