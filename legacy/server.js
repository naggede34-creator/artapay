const express = require('express');
const mongoose = require('mongoose');
const cookieSession = require('./cookiesession');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Telegraf } = require('telegraf');
const ipGuard = require('./lib/ipguard');
const reqMeta = require('./lib/reqmeta');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ================== CUSTOM ID PREFIX ==================
const startId = {
  apikey: 'PIAN',
  invoice: 'INV',
  withdraw: 'WD',
  transaction: 'TRX',
  payment: 'PAY',
  paymentRequest: 'PRQ'
};

const ADMIN_TELEGRAM = {
  username: process.env.ADMIN_TELEGRAM_USERNAME || '',
  url: process.env.ADMIN_TELEGRAM_URL || 'https://t.me/'
};

// ================== MIDDLEWARE DASAR ==================
app.use(async (req, res, next) => {
  try { await ensureReady(); next(); }
  catch (e) { console.error('ensureReady gagal:', e.message); res.status(503).send('Layanan belum siap: ' + e.message); }
});
app.use(ipGuard.middleware);
app.use(reqMeta.middleware);
app.use(express.json({ verify: (req, res, buf) => { if (req.url && req.url.startsWith('/agw/webhook')) req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({ secret: process.env.SESSION_SECRET || 'ganti-SESSION_SECRET-di-vercel', name: 'ap_sid', maxAge: 24 * 60 * 60 * 1000 }));
app.engine('ejs', require('ejs').__express);
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'legacy', 'views'));

// ================== RATE LIMITER ==================
const Limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  handler: (req, res) => {
    ipGuard.strike(req, 0.5, 'Spam login/register/lupa password');
    req.session.errorMsg = 'Terlalu banyak percobaan. Silakan coba lagi setelah 5 menit.';
    res.redirect('/login');
  }
});

const ApiLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    ipGuard.strike(req, 0.25, 'Spam request API');
    res.json({
      success: false,
      message: 'Terlalu banyak request. Tunggu 5 detik lalu coba lagi.'
    });
  }
});

// ================== MONGODB CONNECTION ==================
let botManager = null;
let readyPromise = null;
function ensureReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI belum diisi di Environment Variables Vercel');
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    await seed();
    await ipGuard.init({ onBlock: (entries) => (botManager ? botManager.notifyIpBlocked(entries) : null) });
    try {
      botManager = new BotManager({ Setting, User, Transaction, Stats });
      await botManager.init();
      await botManager.manageBot();
    } catch (e) { console.error('Bot Telegram gagal start:', e.message); }
  })().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}
function siteBaseUrl() {
  const u = process.env.BASE_URL || process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
  if (!u) return '';
  return (/^https?:\/\//.test(u) ? u : 'https://' + u).replace(/\/+$/, '');
}

// ================== CUSTOM ID GENERATOR ==================
function generateCustomId(prefix) {
  const len = 12 - prefix.length;
  const randomHex = crypto.randomBytes(Math.ceil(len / 2)).toString('hex').substring(0, len);
  return prefix + randomHex;
}

function generateApiKey() {
  return startId.apikey + '_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

// ================== MONGOOSE MODELS ==================
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    validate: {
      validator: function(v) { return /^[a-zA-Z0-9]+$/.test(v); },
      message: 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)'
    },
    maxlength: [15, 'Username maksimal 15 karakter']
  },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  pendingBalance: { type: Number, default: 0 },
  role: { type: String, default: 'user', enum: ['user', 'admin'] },
  suspended: { type: Boolean, default: false },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  projectName: { type: String, default: '' },
  callbackUrl: { type: String, default: '' },
  merchantLogoUrl: { type: String, default: '' },
  loginIps: {
    type: [{ ip: String, device: String, firstSeen: Date, lastSeen: Date }],
    default: []
  },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateCustomId(startId.transaction) },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['deposit', 'withdraw'] },
  amount: Number,
  fee: Number,
  total: Number,
  qris_image: String,
  trxid: String,
  mutationId: { type: String, default: null },
  expiredAt: Date,
  status: { type: String, default: 'pending', enum: ['pending', 'paid', 'expired', 'success', 'rejected', 'cancelled'] },
  reference: String,
  createdAt: { type: Date, default: Date.now },
  adminNote: String,
  completedAt: Date,
  method: String,
  accountNumber: String,
  accountName: { type: String, default: '' },
  instant: { type: Boolean, default: false },
  destination: String,
  h2hRefId: String,
  h2hResponse: String,
  methodCode: String,
  balanceAfter: { type: Number, default: null },
  gateway: { type: String, default: '' },
  pending: { type: Boolean, default: false },
  settleAt: Date,
  releasedAt: Date,
  reqIp: { type: String, default: '' },
  reqDevice: { type: String, default: '' }
});
const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

const apiKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  key: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now }
});
const ApiKey = mongoose.models.ApiKey || mongoose.model('ApiKey', apiKeySchema);

const settingSchema = new mongoose.Schema({
  name: { type: String, default: 'ARTA PEDIA PAY' },
  title: { type: String, default: 'Payment Gateway QRIS Super Cepat' },
  description: { type: String, default: 'Terima pembayaran melalui QRIS Payment untuk Aplikasi atau Platform Bisnis kamu dengan mudah, cepat, dan aman.' },
  contactDeveloper: { type: String, default: '' },
  channelInformation: { type: String, default: '' },
  minDeposit: { type: Number, default: 1000 },
  minWithdraw: { type: Number, default: 5000 },
  minFee: { type: Number, default: 0 },
  maxFee: { type: Number, default: 500 },
  checkInterval: { type: Number, default: 30 },
  qrisExpiredMinutes: { type: Number, default: 30 },
  smtpUser: { type: String, default: '' },
  smtpPass: { type: String, default: '' },
  logoUrl: { type: String, default: '/logo.svg' },
  gopayDomain: { type: String, default: 'gomerch.vercel.app' },
  gopayToken: { type: String, default: '' },
  gopayStaticQr: { type: String, default: '' },
  gopayRefreshToken: { type: String, default: '' },
  paymentGateway: { type: String, default: 'gopaymerchant', enum: ['gopaymerchant', 'pakasir', 'xendit', 'midtrans', 'casaku', 'klikqris', 'agw'] },
  pakasirSlug: { type: String, default: '' },
  pakasirApiKey: { type: String, default: '' },
  xenditSecretKey: { type: String, default: '' },
  midtransServerKey: { type: String, default: '' },
  midtransClientKey: { type: String, default: '' },
  midtransProduction: { type: Boolean, default: false },
  casakuLicenseKey: { type: String, default: '' },
  casakuQrId: { type: String, default: '' },
  casakuPackageIds: { type: String, default: 'id.dana' },
  casakuPrefix: { type: String, default: 'CSK' },
  klikqrisApiKey: { type: String, default: '' },
  klikqrisMerchantId: { type: String, default: '' },
  klikqrisCallbackUrl: { type: String, default: '' },
  agwBaseUrl: { type: String, default: 'https://www.tokonokosarta.my.id/api/agw' },
  agwApiKey: { type: String, default: '' },
  agwApiSecret: { type: String, default: '' },
  agwWebhookSecret: { type: String, default: '' },
  telegramBotToken: { type: String, default: '' },
  telegramOwnerId: { type: String, default: '' },
  telegramChannelId: { type: String, default: '' },
  telegramBotEnabled: { type: Boolean, default: false },
  withdrawMethods: {
    type: [
      {
        name: { type: String, required: true },
        fee: { type: Number, required: true, default: 1000 },
        min: { type: Number, default: 0 },
        max: { type: Number, default: 1000000 }
      }
    ],
    default: [
      { name: 'Dana', fee: 1000, min: 10000, max: 1000000 },
      { name: 'GoPay', fee: 2000, min: 10000, max: 1000000 }
    ]
  },
  h2hIdMerchant: { type: String, default: '' },
  h2hPin: { type: String, default: '' },
  h2hPassword: { type: String, default: '' },
  instantWithdrawMethods: {
    type: [
      {
        name: { type: String, required: true },
        code: { type: String, required: true },
        fee: { type: Number, required: true, default: 1000 },
        minAmount: { type: Number, required: true, default: 10000 },
        maxAmount: { type: Number, default: 1000000 },
        active: { type: Boolean, default: true }
      }
    ],
    default: [
      { name: 'Dana', code: 'BBSD', fee: 1000, minAmount: 10000, maxAmount: 1000000, active: true },
      { name: 'GoPay', code: 'BBSGOP', fee: 2000, minAmount: 10000, maxAmount: 1000000, active: true }
    ]
  },
  pendingBalanceEnabled: { type: Boolean, default: true },
  pendingBalanceCutoffHour: { type: Number, default: 9 },
  pendingBalanceReleaseHour: { type: Number, default: 12 },
  withdrawHolidayDays: { type: [Number], default: [0] },
  withdrawHolidayManualOnly: { type: Boolean, default: true },
  socialPopupEnabled: { type: Boolean, default: true },
  socialWhatsappUrl: { type: String, default: '' },
  socialYoutubeUrl: { type: String, default: '' },
  socialTiktokUrl: { type: String, default: '' },
  socialInstagramUrl: { type: String, default: '' },
  statsOverrideEnabled: { type: Boolean, default: true },
  statDeposit24h: { type: Number, default: 2000 },
  statWithdraw24h: { type: Number, default: 49000 },
  statTotalUsers: { type: Number, default: 95 }
});
const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);

const statsSchema = new mongoose.Schema({
  totalDepositAmount: { type: Number, default: 0 },
  totalDepositFee: { type: Number, default: 0 },
  totalWithdrawAmount: { type: Number, default: 0 },
  totalWithdrawFee: { type: Number, default: 0 },
  totalUsers: { type: Number, default: 0 },
  totalTransactions: { type: Number, default: 0 },
  totalUserBalance: { type: Number, default: 0 }
});
const Stats = mongoose.models.Stats || mongoose.model('Stats', statsSchema);

const paymentAccountSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateCustomId(startId.payment) },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  provider: { type: String, required: true },
  accountName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
paymentAccountSchema.index({ userId: 1, provider: 1 }, { unique: true });
const PaymentAccount = mongoose.models.PaymentAccount || mongoose.model('PaymentAccount', paymentAccountSchema);

const paymentRequestSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateCustomId(startId.paymentRequest) },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  provider: { type: String, required: true },
  accountName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  screenshot: { type: String, required: true },
  status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
  adminNote: { type: String, default: '' },
  replacesNumber: { type: String, default: '' },
  reqIp: { type: String, default: '' },
  reqDevice: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date
});
const PaymentRequest = mongoose.models.PaymentRequest || mongoose.model('PaymentRequest', paymentRequestSchema);

// ================== UPLOAD (disimpan di MongoDB, karena disk Vercel tidak permanen) ==================
const fileBlobSchema = new mongoose.Schema({
  _id: String,
  mime: String,
  kind: String,
  data: Buffer,
  createdAt: { type: Date, default: Date.now }
});
const FileBlob = mongoose.models.FileBlob || mongoose.model('FileBlob', fileBlobSchema);
function toBuf(v) { return Buffer.isBuffer(v) ? v : Buffer.from((v && v.buffer) || v); }
async function saveBlob(buffer, mime, kind) {
  const id = kind + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  await FileBlob.create({ _id: id, mime, kind, data: buffer });
  return id;
}
async function getBlobBuffer(id) {
  const b = await FileBlob.findById(path.basename(String(id)));
  return b ? toBuf(b.data) : Buffer.alloc(0);
}

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'), false);
    cb(null, true);
  }
});

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(new Error('Screenshot harus berupa gambar JPG, PNG, atau WEBP'), false);
    cb(null, true);
  }
});

app.get('/uploads/:id', async (req, res) => {
  try {
    const b = await FileBlob.findOne({ _id: path.basename(req.params.id), kind: 'logo' });
    if (!b) return res.status(404).send('Tidak ditemukan');
    res.set('Content-Type', b.mime || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(toBuf(b.data));
  } catch (e) { res.status(404).send('Tidak ditemukan'); }
});

// ================== ANTI-DUPLICATE HELPER ==================
async function createWithRetry(Model, data, maxRetries = 5, customIdGen = null) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (customIdGen && !data._id) data._id = customIdGen();
      return await Model.create(data);
    } catch (err) {
      if (err.code === 11000 && attempt < maxRetries - 1) {
        if (customIdGen) data._id = customIdGen();
        else if (Model === ApiKey) data.key = generateApiKey();
        continue;
      }
      throw err;
    }
  }
  throw new Error('Gagal membuat dokumen setelah beberapa kali percobaan (duplicate ID)');
}

// ================== POPUP SOSIAL ADMIN ==================
// Isi link default di sini kalau mau diatur lewat server.js.
// Kalau kolom di Pengaturan Admin diisi, itu yang dipakai; kalau kosong, pakai nilai di bawah ini.
const SOCIAL_DEFAULTS = {
  whatsapp: '',   // contoh: 'https://whatsapp.com/channel/xxxx'
  youtube: '',    // contoh: 'https://youtube.com/@namakamu'
  tiktok: '',     // contoh: 'https://tiktok.com/@namakamu'
  instagram: ''   // contoh: 'https://instagram.com/namakamu'
};

function cleanSocialUrl(v) {
  let u = String(v || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z0-9.-]+:\d+/i.test(u)) return '';
    u = 'https://' + u.replace(/^\/+/, '');
  }
  return /^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(u) ? u : '';
}

function getSocialLinks(settings) {
  if (!settings || settings.socialPopupEnabled === false) return [];
  const items = [
    { key: 'whatsapp', label: 'Channel WhatsApp Admin', url: cleanSocialUrl(settings.socialWhatsappUrl) || cleanSocialUrl(SOCIAL_DEFAULTS.whatsapp) },
    { key: 'youtube', label: 'Channel YouTube Admin', url: cleanSocialUrl(settings.socialYoutubeUrl) || cleanSocialUrl(SOCIAL_DEFAULTS.youtube) },
    { key: 'tiktok', label: 'TikTok Admin', url: cleanSocialUrl(settings.socialTiktokUrl) || cleanSocialUrl(SOCIAL_DEFAULTS.tiktok) },
    { key: 'instagram', label: 'Instagram Admin', url: cleanSocialUrl(settings.socialInstagramUrl) || cleanSocialUrl(SOCIAL_DEFAULTS.instagram) }
  ];
  return items.filter(i => i.url);
}

// ================== HELPERS ==================
async function getSettings() {
  let s = await Setting.findOne();
  if (!s) s = await Setting.create({});
  // Orderkuota sudah tidak dipakai sebagai gateway deposit (hanya H2H untuk withdraw).
  if (s.paymentGateway === 'orderkuota') {
    await Setting.updateOne({ _id: s._id }, { $set: { paymentGateway: 'gopaymerchant' } });
    s.paymentGateway = 'gopaymerchant';
  }
  const OLD_NAMES = ['Sky Gateway', 'Pianpedia', 'Nevapedia', 'Pianpedia Gateway', 'Nevapedia Gateway'];
  const patch = {};
  if (OLD_NAMES.includes(s.name)) patch.name = 'ARTA PEDIA PAY';
  if (/pixhost\.to/.test(s.logoUrl || '')) patch.logoUrl = '/logo.svg';
  if (s.statDeposit24h === undefined || s.statWithdraw24h === undefined || s.statTotalUsers === undefined || s.statsOverrideEnabled === undefined) {
    patch.statsOverrideEnabled = s.statsOverrideEnabled === undefined ? true : s.statsOverrideEnabled;
    patch.statDeposit24h = s.statDeposit24h === undefined ? 2000 : s.statDeposit24h;
    patch.statWithdraw24h = s.statWithdraw24h === undefined ? 49000 : s.statWithdraw24h;
    patch.statTotalUsers = s.statTotalUsers === undefined ? 95 : s.statTotalUsers;
  }
  if (Object.keys(patch).length) {
    await Setting.updateOne({ _id: s._id }, { $set: patch });
    Object.assign(s, patch);
  }
  return s;
}

async function computeStats() {
  const [depositAgg, withdrawAgg, totalUsers, totalTrx, balanceAgg] = await Promise.all([
    Transaction.aggregate([{ $match: { type: 'deposit', status: 'paid' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    Transaction.aggregate([{ $match: { type: 'withdraw', status: 'success' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    User.countDocuments({ role: 'user' }),
    Transaction.countDocuments(),
    User.aggregate([{ $match: { role: 'user' } }, { $group: { _id: null, totalBalance: { $sum: '$balance' } } }])
  ]);

  const dAmount = depositAgg[0]?.totalAmount || 0;
  const dFee = depositAgg[0]?.totalFee || 0;
  const wAmount = withdrawAgg[0]?.totalAmount || 0;
  const wFee = withdrawAgg[0]?.totalFee || 0;
  const totalUserBalance = balanceAgg[0]?.totalBalance || 0;

  await Stats.findOneAndUpdate({}, {
    totalDepositAmount: dAmount,
    totalDepositFee: dFee,
    totalWithdrawAmount: wAmount,
    totalWithdrawFee: wFee,
    totalUsers,
    totalTransactions: totalTrx,
    totalUserBalance
  }, { upsert: true });

  return { totalDepositAmount: dAmount, totalDepositFee: dFee, totalWithdrawAmount: wAmount, totalWithdrawFee: wFee, totalUsers, totalTransactions: totalTrx, totalUserBalance };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

async function sendWebhook(user, event, data) {
  if (!user || !user.callbackUrl) return;
  try {
    await axios.post(user.callbackUrl, { event, data, timestamp: new Date().toISOString() }, { timeout: 5000, headers: { 'Content-Type': 'application/json' } });
  } catch (err) { console.error(`Callback gagal untuk user ${user.username}:`, err.message); }
}

// ================== WAKTU WIB & SALDO TERTUNDA ==================
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function jakartaParts(date = new Date()) {
  const j = new Date(date.getTime() + WIB_OFFSET_MS);
  return { year: j.getUTCFullYear(), month: j.getUTCMonth(), day: j.getUTCDate(), hour: j.getUTCHours(), weekday: j.getUTCDay() };
}

function jakartaDateAt(year, month, day, hour) {
  return new Date(Date.UTC(year, month, day, hour, 0, 0) - WIB_OFFSET_MS);
}

function computeSettleAt(settings, from = new Date()) {
  const cutoffHour = settings.pendingBalanceCutoffHour ?? 9;
  const releaseHour = settings.pendingBalanceReleaseHour ?? 12;
  const p = jakartaParts(from);
  let releaseAt = jakartaDateAt(p.year, p.month, p.day, releaseHour);
  if (p.hour >= cutoffHour || from.getTime() >= releaseAt.getTime()) {
    releaseAt = jakartaDateAt(p.year, p.month, p.day + 1, releaseHour);
  }
  return releaseAt;
}

function isWithdrawHoliday(settings, date = new Date()) {
  const days = (settings.withdrawHolidayDays && settings.withdrawHolidayDays.length) ? settings.withdrawHolidayDays : [0];
  return days.includes(jakartaParts(date).weekday);
}

async function creditDepositAmount(dep, settings) {
  if (settings.pendingBalanceEnabled) {
    const settleAt = computeSettleAt(settings, new Date());
    await User.findByIdAndUpdate(dep.userId, { $inc: { pendingBalance: dep.amount } });
    await Transaction.findByIdAndUpdate(dep._id, { pending: true, settleAt });
  } else {
    await User.findByIdAndUpdate(dep.userId, { $inc: { balance: dep.amount } });
  }
  const updatedUser = await User.findById(dep.userId);
  await Transaction.findByIdAndUpdate(dep._id, { balanceAfter: updatedUser.balance });
  return updatedUser;
}

async function releasePendingBalances() {
  try {
    const now = new Date();
    const due = await Transaction.find({ type: 'deposit', pending: true, settleAt: { $lte: now } });
    for (const dep of due) {
      const updatedUser = await User.findOneAndUpdate(
        { _id: dep.userId, pendingBalance: { $gte: dep.amount } },
        { $inc: { pendingBalance: -dep.amount, balance: dep.amount } },
        { new: true }
      );
      if (!updatedUser) continue;
      await Transaction.findByIdAndUpdate(dep._id, { pending: false, releasedAt: now, balanceAfter: updatedUser.balance });
      const userFull = await User.findById(dep.userId).lean();
      sendWebhook(userFull, 'balance.released', { invoice_id: dep._id, amount: dep.amount, balance_after: updatedUser.balance });
    }
  } catch (err) {
    console.error('releasePendingBalances error:', err.message);
    if (botManager) botManager.notifyError('releasePendingBalances', err.message);
  }
}

// ================== GATEWAY PEMBAYARAN: PAKASIR / XENDIT / MIDTRANS ==================
function qrImageUrl(rawString) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(rawString)}`;
}

const PAKASIR_BASE_URL = 'https://app.pakasir.com/api/v2';

function pakasirHeaders(settings) {
  return { 'Content-Type': 'application/json', 'X-Api-Key': settings.pakasirApiKey };
}

async function createPakasirQris(orderId, amount, settings) {
  const url = `${PAKASIR_BASE_URL}/create-transaction/${encodeURIComponent(settings.pakasirSlug)}/${encodeURIComponent(orderId)}`;
  const resp = await axios.post(url, { method: 'qris', amount }, { headers: pakasirHeaders(settings), timeout: 20000 });
  const data = resp.data?.payment || resp.data;
  if (!data?.txn_id || !data?.qr_string) throw new Error('Gagal membuat QRIS Pakasir');
  return { trxid: data.txn_id, qrisImage: qrImageUrl(data.qr_string) };
}

async function checkPakasirStatus(dep, settings) {
  const url = `${PAKASIR_BASE_URL}/transaction-status/${encodeURIComponent(settings.pakasirSlug)}/${encodeURIComponent(dep.trxid)}`;
  const resp = await axios.get(url, { headers: { 'X-Api-Key': settings.pakasirApiKey }, timeout: 20000 });
  const status = resp.data?.status || resp.data?.transaction?.status || '';
  return String(status).toLowerCase() === 'completed';
}

async function cancelPakasirTransaction(dep, settings) {
  const url = `${PAKASIR_BASE_URL}/cancel-transaction/${encodeURIComponent(settings.pakasirSlug)}/${encodeURIComponent(dep.trxid)}`;
  await axios.post(url, {}, { headers: pakasirHeaders(settings), timeout: 20000 });
}

function xenditClient(settings) {
  return axios.create({ baseURL: 'https://api.xendit.co', auth: { username: settings.xenditSecretKey, password: '' }, headers: { 'Content-Type': 'application/json' } });
}

async function createXenditQris(orderId, amount, settings) {
  const { data } = await xenditClient(settings).post('/v3/payment_requests', {
    reference_id: orderId,
    type: 'PAY',
    country: 'ID',
    currency: 'IDR',
    request_amount: amount,
    channel_properties: { qr_string_type: 'DYNAMIC' },
    capture_method: 'AUTOMATIC',
    description: `Deposit ${orderId}`
  });
  const qrString = data?.channel_properties?.qr_string || data?.actions?.find(a => a.type === 'PRESENT_TO_CUSTOMER')?.value;
  if (!qrString) throw new Error('Gagal membuat QRIS Xendit');
  return { trxid: data.payment_request_id, qrisImage: qrImageUrl(qrString) };
}

async function checkXenditStatus(dep, settings) {
  const { data } = await xenditClient(settings).get(`/v3/payment_requests/${dep.trxid}`);
  return String(data?.status || '').toUpperCase() === 'SUCCEEDED';
}

async function createXenditPayout(refId, amount, channelCode, accountNumber, settings) {
  const { data } = await xenditClient(settings).post('/v3/payouts', {
    reference_id: refId,
    currency: 'IDR',
    amount,
    channel_properties: { account_number: accountNumber },
    channel_code: channelCode,
    description: 'Withdrawal'
  });
  return data;
}

function midtransBaseUrl(settings) {
  return settings.midtransProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
}

function midtransAuthHeader(settings) {
  return { Authorization: 'Basic ' + Buffer.from(settings.midtransServerKey + ':').toString('base64') };
}

async function createMidtransQris(orderId, amount, settings) {
  const parameter = {
    payment_type: 'qris',
    transaction_details: { order_id: orderId, gross_amount: amount },
    item_details: [{ id: orderId, price: amount, quantity: 1, name: 'Deposit' }],
    qris: { acquirer: 'gopay' }
  };
  const { data } = await axios.post(`${midtransBaseUrl(settings)}/v2/charge`, parameter, { headers: { ...midtransAuthHeader(settings), 'Content-Type': 'application/json' } });
  const qrUrl = data?.actions?.find(a => a.name === 'generate-qr-code')?.url;
  if (!qrUrl && !data?.qr_string) throw new Error('Gagal membuat QRIS Midtrans');
  return { trxid: data.order_id, qrisImage: qrUrl || qrImageUrl(data.qr_string) };
}

async function checkMidtransStatus(dep, settings) {
  const { data } = await axios.get(`${midtransBaseUrl(settings)}/v2/${dep.trxid}/status`, { headers: midtransAuthHeader(settings) });
  return ['settlement', 'capture'].includes(String(data?.transaction_status || '').toLowerCase());
}

const CASAKU_BASE_URL = 'https://api.casaku.id';
const KLIKQRIS_BASE_URL = 'https://klikqris.com/api';

function pickProviderStatus(payload) {
  const candidates = [payload?.data?.status, payload?.data?.data?.status, payload?.transaction?.status, payload?.status];
  const found = candidates.find(v => typeof v === 'string' && v.trim() !== '');
  return found ? found.trim().toLowerCase() : '';
}

function parseProviderAmount(value) {
  const n = Math.round(parseFloat(value));
  return isNaN(n) ? 0 : n;
}

function casakuHeaders(settings) {
  return { 'Content-Type': 'application/json', 'x-license-key': settings.casakuLicenseKey };
}

async function createCasakuQris(amount, settings) {
  const packageIds = String(settings.casakuPackageIds || '').split(',').map(v => v.trim()).filter(Boolean);
  const body = {
    qr_id: settings.casakuQrId,
    amount,
    useUniqueCode: false,
    packageIds,
    expiredInMinutes: settings.qrisExpiredMinutes || 30,
    qrType: 'dynamic',
    paymentMethod: 'qris',
    useQris: true,
    prefix: String(settings.casakuPrefix || 'CSK').slice(0, 8)
  };
  const resp = await axios.post(`${CASAKU_BASE_URL}/api/generate/v2/qris`, body, { headers: casakuHeaders(settings), timeout: 20000 });
  const data = resp.data?.data || resp.data;
  if (!data?.transactionId || !data?.qr_string) throw new Error(resp.data?.message || 'Gagal membuat QRIS Casaku');
  return { trxid: data.transactionId, qrisImage: qrImageUrl(data.qr_string), total: parseProviderAmount(data.totalAmount) };
}

async function checkCasakuStatus(dep, settings) {
  const resp = await axios.post(`${CASAKU_BASE_URL}/api/generate/check-status`, { transactionId: dep.trxid }, { headers: casakuHeaders(settings), timeout: 20000 });
  return pickProviderStatus(resp.data) === 'paid';
}

function klikqrisHeaders(settings) {
  return { 'Content-Type': 'application/json', 'x-api-key': settings.klikqrisApiKey, 'id_merchant': settings.klikqrisMerchantId };
}

async function createKlikqrisQris(orderId, amount, settings) {
  const body = {
    order_id: orderId,
    id_merchant: settings.klikqrisMerchantId,
    amount,
    keterangan: `Deposit ${orderId}`
  };
  if (settings.klikqrisCallbackUrl) body.callback_url = settings.klikqrisCallbackUrl;
  const resp = await axios.post(`${KLIKQRIS_BASE_URL}/qris/create`, body, { headers: klikqrisHeaders(settings), timeout: 20000 });
  const data = resp.data?.data;
  const qrisImage = data?.qris_image || data?.qris_url;
  if (!resp.data?.status || !qrisImage) throw new Error(resp.data?.message || 'Gagal membuat QRIS KlikQRIS');
  return { trxid: data.order_id || orderId, qrisImage, total: parseProviderAmount(data.total_amount) };
}

async function checkKlikqrisStatus(dep, settings) {
  const resp = await axios.get(`${KLIKQRIS_BASE_URL}/qris/status/${encodeURIComponent(dep.trxid)}`, { headers: klikqrisHeaders(settings), timeout: 20000 });
  return String(resp.data?.data?.status || '').toUpperCase() === 'SUCCESS';
}


// ================== ADMIN GATEWAY (AGW / SMP Payment) ==================
// Dokumentasi: Base URL .../api/agw, header X-API-Key, HMAC opsional (X-Timestamp + X-Signature), webhook invoice.paid.
function agwConfig(settings) {
  const base = String(settings.agwBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base || !settings.agwApiKey) throw new Error('Konfigurasi Admin Gateway belum lengkap. Hubungi admin.');
  return base;
}

async function agwCall(settings, method, path, body) {
  const base = agwConfig(settings);
  const raw = body ? JSON.stringify(body) : '';
  const headers = { 'X-API-Key': settings.agwApiKey, 'Content-Type': 'application/json' };
  if (settings.agwApiSecret) {
    const ts = String(Math.floor(Date.now() / 1000));
    const prefix = new URL(base).pathname.replace(/\/+$/, '');
    const canon = [method, prefix + path.split('?')[0], raw, ts].join('\n');
    headers['X-Timestamp'] = ts;
    headers['X-Signature'] = crypto.createHmac('sha256', settings.agwApiSecret).update(canon).digest('hex');
  }
  const resp = await axios({ method, url: base + path, headers, data: raw || undefined, timeout: 20000, validateStatus: () => true });
  if (!resp.data || resp.data.success !== true) {
    throw new Error((resp.data && (resp.data.message || resp.data.code)) || `Admin Gateway HTTP ${resp.status}`);
  }
  return resp.data;
}

async function createAgwQris(orderId, amount, settings) {
  const data = await agwCall(settings, 'POST', '/qris/create', { amount, order_id: orderId, description: `Deposit ${orderId}` });
  const inv = data.invoice || {};
  if (!inv.invoice_id || !(inv.qr_string || inv.qr_image)) throw new Error('Gagal membuat QRIS Admin Gateway');
  return {
    trxid: inv.invoice_id,
    qrisImage: inv.qr_string ? qrImageUrl(inv.qr_string) : inv.qr_image,
    total: parseProviderAmount(inv.total_pay),
    expiredAt: inv.expired_at ? new Date(inv.expired_at) : null
  };
}

async function checkAgwStatus(dep, settings) {
  const data = await agwCall(settings, 'GET', '/qris/status/' + encodeURIComponent(dep.trxid));
  if (String(data.status || data.invoice?.status || '').toLowerCase() !== 'paid') return false;
  const paidTotal = parseProviderAmount(data.invoice?.total_pay);
  return !paidTotal || paidTotal === Number(dep.total);
}

async function cancelAgwInvoice(dep, settings) {
  await agwCall(settings, 'POST', '/qris/cancel/' + encodeURIComponent(dep.trxid));
}

// ================== GOPAY TOKEN REFRESH & RETRY ==================
let refreshingPromise = null;

async function refreshGopayToken() {
  const settings = await getSettings();
  if (!settings.gopayRefreshToken) {
    const err = new Error('Refresh token tidak tersedia. Harap isi di pengaturan admin.');
    if (botManager) botManager.notifyError('refreshGopayToken', err.message);
    throw err;
  }
  const gopayBase = settings.gopayDomain || 'gomerch.vercel.app';
  const refreshUrl = `https://${gopayBase}/auth/refresh/token?refresh_token=${encodeURIComponent(settings.gopayRefreshToken)}`;
  try {
    const resp = await axios.get(refreshUrl);
    const res = resp.data;
    if (!res.success) {
      const err = new Error(res.error || 'Gagal refresh token');
      if (botManager) botManager.notifyError('/auth/refresh/token', err.message);
      throw err;
    }
    const newToken = res.data.access_token;
    const newRefreshToken = res.data.refresh_token;
    const updateFields = { gopayToken: newToken };
    if (newRefreshToken) updateFields.gopayRefreshToken = newRefreshToken;
    await Setting.updateOne({}, updateFields);
    console.log('✅ Gopay token berhasil diperbarui');
    return newToken;
  } catch (err) {
    console.error('❌ Gagal refresh Gopay token:', err.response?.data || err.message);
    if (botManager) botManager.notifyError('/auth/refresh/token', err.response?.data?.error || err.message);
    throw new Error('Gagal memperbarui token Gopay. Refresh token mungkin sudah kadaluarsa.');
  }
}

async function callGopayApiWithRetry(url, options = {}, maxRetries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios({ url, ...options });
      return response.data;
    } catch (err) {
      const isTokenError =
        (err.response && err.response.status === 401) ||
        (err.response?.data?.error &&
          (typeof err.response.data.error === 'string'
            ? /Expired token/i.test(err.response.data.error)
            : /Expired token/i.test(err.response.data.error?.message || '')));
      if (isTokenError && attempt < maxRetries) {
        console.log('🔄 Token expired, mencoba refresh...');
        if (!refreshingPromise) {
          refreshingPromise = refreshGopayToken().finally(() => { refreshingPromise = null; });
        }
        await refreshingPromise;
        const settings = await getSettings();
        if (url.includes('token=')) url = url.replace(/token=[^&]*/, `token=${encodeURIComponent(settings.gopayToken)}`);
        continue;
      }
      lastError = err;
      break;
    }
  }
  if (lastError && botManager) botManager.notifyError(url, lastError.response?.data?.error || lastError.message);
  throw lastError;
}

// ================== PROSES PERMINTAAN PAYMENT (WEB + BOT) ==================
async function processPaymentRequest(id, action, note) {
  const request = await PaymentRequest.findOne({ _id: id });
  if (!request || request.status !== 'pending') return { ok: false, message: 'Permintaan tidak ditemukan atau sudah diproses.' };
  if (action === 'approve') {
    const existing = await PaymentAccount.findOne({ userId: request.userId, provider: request.provider });
    if (existing) {
      existing.accountName = request.accountName;
      existing.accountNumber = request.accountNumber;
      existing.updatedAt = new Date();
      await existing.save();
    } else {
      await createWithRetry(PaymentAccount, {
        userId: request.userId,
        provider: request.provider,
        accountName: request.accountName,
        accountNumber: request.accountNumber
      }, 5, () => generateCustomId(startId.payment));
    }
    request.status = 'approved';
  } else {
    request.status = 'rejected';
    request.adminNote = String(note || '').slice(0, 200);
  }
  request.processedAt = new Date();
  await request.save();
  return { ok: true, request };
}

// ================== BOT MANAGER CLASS ==================
const SITE_URL = siteBaseUrl() || 'https://example.com';

const LINE_BREAK = `
`;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatRupiah(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function parseChannelTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^-\d{5,}$/.test(value)) return value;
  let name = value;
  const link = value.match(/^(?:https?:\/\/)?(?:t|telegram)\.me\/(.+)$/i);
  if (link) {
    const part = link[1].split(/[?#]/)[0].replace(/\/+$/, '');
    if (part.startsWith('+') || /^joinchat/i.test(part)) return null;
    if (/^c\//i.test(part)) {
      const id = part.split('/')[1];
      return /^\d+$/.test(id) ? `-100${id}` : null;
    }
    name = part.split('/')[0];
  }
  name = name.replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? `@${name}` : null;
}

function webhookSecret(token) {
  return crypto.createHash('sha256').update(String(token) + (process.env.SESSION_SECRET || '')).digest('hex').slice(0, 40);
}

class BotManager {
  constructor(models) {
    this.models = models;
    this.bot = null;
    this.running = false;
    this.settings = null;
  }

  async init() {
    this.settings = await this.models.Setting.findOne();
  }

  async updateSettings(newSettings) {
    this.settings = newSettings;
    await this.manageBot();
  }

  async manageBot() {
    if (!this.settings) return;
    const { telegramBotEnabled, telegramBotToken, telegramOwnerId } = this.settings;
    if (telegramBotEnabled && telegramBotToken && telegramOwnerId) {
      if (!this.running) {
        await this.startBot(telegramBotToken, telegramOwnerId);
      } else if (this.bot && this.bot.token !== telegramBotToken) {
        await this.stopBot();
        await this.startBot(telegramBotToken, telegramOwnerId);
      }
    } else {
      if (this.running) await this.stopBot();
    }
  }

  async restartBot() {
    if (!this.settings) throw new Error('Settings belum dimuat.');
    const { telegramBotToken, telegramOwnerId } = this.settings;
    if (!telegramBotToken || !telegramOwnerId) throw new Error('Token Bot atau Owner ID belum diisi di Pengaturan.');
    await this.stopBot();
    await this.startBot(telegramBotToken, telegramOwnerId);
  }

  async startBot(token, ownerId) {
    this.bot = new Telegraf(token);
    this.ownerId = ownerId;

    this.bot.command('stats', async (ctx) => {
      const stats = await computeStats();
      const pendingManual = await this.models.Transaction.countDocuments({
        type: 'withdraw',
        instant: false,
        status: 'pending'
      });
      const isOwner = ctx.from.id.toString() === this.ownerId.toString();
      const msg =
        `📊 *Statistik Keuangan ${this.settings.name}*\n` +
        `_- Total Deposit:_ Rp ${stats.totalDepositAmount.toLocaleString('id-ID')}\n` +
        (isOwner
          ? `_- Total Fee Deposit:_ Rp ${stats.totalDepositFee.toLocaleString('id-ID')}\n`
          : "") +
        `_- Total Withdraw:_ Rp ${stats.totalWithdrawAmount.toLocaleString('id-ID')}\n` +
        (isOwner
          ? `_- Total Fee Withdraw:_ Rp ${stats.totalWithdrawFee.toLocaleString('id-ID')}\n`
          : "") +
        `_- Total Pengguna:_ ${stats.totalUsers}\n` +
        `_- Total Transaksi:_ ${stats.totalTransactions}\n` +
        `_- Total Saldo User:_ Rp ${stats.totalUserBalance.toLocaleString('id-ID')}\n` +
        `_- Request Withdraw:_ ${pendingManual} permintaan`;
      ctx.replyWithMarkdown(msg);
    });

    this.bot.command('menu', async (ctx) => {
      const keyboard = [
        [{ text: '📊 Stats', callback_data: 'stats' }, { text: '📤 Backup Script', callback_data: 'backup' }]
      ];
      await ctx.reply(`_Hallo 👋_,\n_Saya adalah bot notifikasi_ *${this.settings.name}*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    });

    this.bot.command('sendpesan', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) {
        return ctx.reply('⚠️ Hanya owner yang dapat menggunakan fitur ini.');
      }
      const chatId = this.getChannelChatId();
      if (!chatId) return ctx.reply('❌ Channel Telegram belum diatur atau formatnya tidak valid di pengaturan admin.');

      let messageText = '';
      let photoFileId = null;
      if (ctx.message?.reply_to_message?.photo) {
        const photo = ctx.message.reply_to_message.photo;
        const fil = photo[photo.length - 1];
        photoFileId = fil.file_id;
        messageText = ctx.message.text || '';
      } else {
        messageText = ctx.message.text || '';
      }
      messageText = messageText.replace(/^\/sendpesan(@\w+)?\s*/, '');

      let customUrl = null;
      if (messageText.includes('|')) {
        const parts = messageText.split('|');
        messageText = parts[0].trim();
        const rawUrl = parts.slice(1).join('|').trim();
        if (rawUrl) customUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
      } else {
        messageText = messageText.trim();
      }

      if (!messageText && !photoFileId) {
        return ctx.reply('ℹ️ Format penggunaan:\n/sendpesan <teks pesan>\n/sendpesan <teks>|<url>\n\nContoh:\n/sendpesan Promo spesial\n/sendpesan Diskon besar|https://s.id/promo\n\nBisa juga reply foto dengan caption /sendpesan ...');
      }

      const sendOptions = {};
      if (customUrl) {
        sendOptions.reply_markup = {
          inline_keyboard: [[{ text: '🌐 Website ARTA PEDIA PAY', url: SITE_URL }]]
        };
      }

      try {
        if (photoFileId) {
          await ctx.telegram.sendPhoto(chatId, photoFileId, { caption: messageText, ...sendOptions, parse_mode: 'Markdown' });
        } else {
          await ctx.telegram.sendMessage(chatId, messageText, sendOptions);
        }
        await ctx.reply('✅ Pesan berhasil dikirim ke channel.');
      } catch (err) {
        console.error('Gagal kirim pesan ke channel:', err);
        ctx.reply('❌ Gagal mengirim pesan ke channel: ' + err.message);
        this.notifyError('/sendpesan', err.message);
      }
    });

    this.bot.command('backup', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) return ctx.reply('⚠️ Hanya owner yang dapat menggunakan fitur ini.');
      this.createBackup(ctx);
    });

    this.bot.action('backup', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) { await ctx.answerCbQuery('⚠️ Hanya owner.'); return; }
      await ctx.answerCbQuery();
      this.createBackup(ctx);
    });

    this.bot.action('stats', async (ctx) => {
      await ctx.answerCbQuery();
      const stats = await computeStats();
      const pendingManual = await this.models.Transaction.countDocuments({
        type: 'withdraw',
        instant: false,
        status: 'pending'
      });
      const isOwner = ctx.from.id.toString() === this.ownerId.toString();
      const msg =
        `📊 *Statistik Keuangan ${this.settings.name}*\n` +
        `_- Total Deposit:_ Rp ${stats.totalDepositAmount.toLocaleString('id-ID')}\n` +
        (isOwner
          ? `_- Total Fee Deposit:_ Rp ${stats.totalDepositFee.toLocaleString('id-ID')}\n`
          : "") +
        `_- Total Withdraw:_ Rp ${stats.totalWithdrawAmount.toLocaleString('id-ID')}\n` +
        (isOwner
          ? `_- Total Fee Withdraw:_ Rp ${stats.totalWithdrawFee.toLocaleString('id-ID')}\n`
          : "") +
        `_- Total Pengguna:_ ${stats.totalUsers}\n` +
        `_- Total Transaksi:_ ${stats.totalTransactions}\n` +
        `_- Total Saldo User:_ Rp ${stats.totalUserBalance.toLocaleString('id-ID')}\n` +
        `_- Request Withdraw:_ ${pendingManual} permintaan`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    });

    this.bot.command('blocklist', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) return ctx.reply('⚠️ Hanya owner yang dapat menggunakan fitur ini.');
      const view = this.buildBlocklistView();
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
    });

    this.bot.command('unblock', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) return ctx.reply('⚠️ Hanya owner yang dapat menggunakan fitur ini.');
      const target = ctx.message.text.trim().split(/\s+/)[1];
      if (!target) return ctx.reply('ℹ️ Format: /unblock &lt;ip&gt;', { parse_mode: 'HTML' });
      const done = await ipGuard.unblock(target);
      const shown = escapeHtml(ipGuard.normalizeIp(target));
      await ctx.reply(done ? `✅ Blokir <code>${shown}</code> sudah dibuka.` : `ℹ️ <code>${shown}</code> tidak ada di daftar blokir.`, { parse_mode: 'HTML' });
    });

    this.bot.command('block', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) return ctx.reply('⚠️ Hanya owner yang dapat menggunakan fitur ini.');
      const [, target, ...rest] = ctx.message.text.trim().split(/\s+/);
      if (!target) return ctx.reply('ℹ️ Format: /block &lt;ip&gt; [alasan]', { parse_mode: 'HTML' });
      const entry = ipGuard.blockManual(target, rest.join(' '));
      if (!entry) return ctx.reply('❌ IP tidak valid. Contoh: /block 1.2.3.4 spam');
      await ctx.reply(`🚫 <code>${escapeHtml(entry.ip)}</code> diblokir permanen.`, { parse_mode: 'HTML' });
    });

    this.bot.command('testchannel', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) return ctx.reply('⚠️ Hanya owner yang dapat menggunakan fitur ini.');
      const chatId = this.getChannelChatId();
      if (!chatId) return ctx.reply('❌ Channel Telegram belum diatur atau formatnya tidak valid. Isi di Pengaturan Admin dengan @username channel atau ID channel (-100xxxxxxxxxx).');
      try {
        await ctx.telegram.sendMessage(chatId, `✅ <b>Tes Notifikasi Channel</b>

Bot ${escapeHtml(this.settings.name)} terhubung ke channel ini.`, { parse_mode: 'HTML' });
        await ctx.reply(`✅ Pesan tes berhasil dikirim ke ${chatId}`);
      } catch (e) {
        await ctx.reply(`❌ Gagal kirim ke ${escapeHtml(chatId)}: ${escapeHtml(this.describeChannelError(e, chatId))}`, { parse_mode: 'HTML' });
      }
    });

    this.bot.action('blocklist', async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) return ctx.answerCbQuery('⚠️ Hanya owner.');
      await ctx.answerCbQuery();
      const view = this.buildBlocklistView();
      try {
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      } catch (e) {
        console.error('Refresh daftar blokir:', e.message);
      }
    });

    this.bot.action(/^unblock_(.+)$/, async (ctx) => {
      if (ctx.from.id.toString() !== this.ownerId.toString()) return ctx.answerCbQuery('⚠️ Hanya owner.');
      const done = await ipGuard.unblock(ctx.match[1]);
      await ctx.answerCbQuery(done ? '✅ Blokir dibuka' : 'ℹ️ IP sudah tidak diblokir');
      const view = this.buildBlocklistView();
      try {
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      } catch (e) {
        console.error('Update daftar blokir:', e.message);
      }
    });

    this.bot.on('callback_query', async (ctx) => {
      const ownerId = this.ownerId.toString();
      if (ctx.from.id.toString() !== ownerId) return;
      const data = ctx.callbackQuery.data;
      if (data.startsWith('payapprove_') || data.startsWith('payreject_') || data.startsWith('payrejectReason_') || data.startsWith('paycancelReject_')) {
        const parts = data.split('_');
        const prqId = parts[1];
        const finishCaption = async (statusHtml) => {
          const original = escapeHtml((ctx.callbackQuery.message.caption || '').slice(0, 800));
          await ctx.editMessageCaption(`${original}\n\n${statusHtml}`, { parse_mode: 'HTML' });
        };
        try {
          if (parts[0] === 'payapprove') {
            const result = await processPaymentRequest(prqId, 'approve');
            if (!result.ok) await finishCaption('⚠️ ' + result.message);
            else await finishCaption('✅ <b>Payment Disetujui</b>');
          } else if (parts[0] === 'payreject') {
            await ctx.editMessageReplyMarkup({ inline_keyboard: [
              [{ text: '1. Data Payment Tidak Valid', callback_data: `payrejectReason_${prqId}_0` }],
              [{ text: '2. Nama Akun Tidak Sesuai', callback_data: `payrejectReason_${prqId}_1` }],
              [{ text: '3. Screenshot Tidak Jelas', callback_data: `payrejectReason_${prqId}_2` }],
              [{ text: '4. IP Tidak Sesuai', callback_data: `payrejectReason_${prqId}_3` }],
              [{ text: '🔙 Batalkan', callback_data: `paycancelReject_${prqId}` }]
            ]});
          } else if (parts[0] === 'payrejectReason') {
            const reasons = ['Data Payment Tidak Valid', 'Nama Akun Tidak Sesuai', 'Screenshot Tidak Jelas', 'IP Tidak Sesuai'];
            const reason = reasons[parseInt(parts[2])] || 'Alasan tidak diketahui';
            const result = await processPaymentRequest(prqId, 'reject', reason);
            if (!result.ok) await finishCaption('⚠️ ' + result.message);
            else await finishCaption(`❌ <b>Ditolak</b>\nAlasan: ${escapeHtml(reason)}`);
          } else if (parts[0] === 'paycancelReject') {
            await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Approve', callback_data: `payapprove_${prqId}` }, { text: '❌ Reject', callback_data: `payreject_${prqId}` }]] });
          }
        } catch (e) {
          console.error(e);
          this.notifyError('/callback_query (payment)', e.message);
        }
      } else if (data.startsWith('approve_')) {
        const wdId = data.split('_')[1];
        await this.approveWithdrawal(ctx, wdId);
      } else if (data.startsWith('reject_')) {
        const wdId = data.split('_')[1];
        await this.showRejectReasons(ctx, wdId);
      } else if (data.startsWith('rejectReason_')) {
        const [, wdId, reasonIndex] = data.split('_');
        const reasons = ['Data Ewallet Tidak Valid', 'Nama Akun Tidak Valid', 'Metode Penarikan Tidak Valid'];
        const reason = reasons[parseInt(reasonIndex)] || 'Alasan tidak diketahui';
        await this.rejectWithdrawal(ctx, wdId, reason);
      } else if (data.startsWith('cancelReject_')) {
        const wdId = data.split('_')[1];
        const keyboard = { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${wdId}` }, { text: '❌ Reject', callback_data: `reject_${wdId}` }]] };
        try { await ctx.editMessageReplyMarkup(keyboard); } catch (e) { console.error(e); this.notifyError('/callback_query (cancelReject)', e.message); }
      }
      ctx.answerCbQuery();
    });

    this.bot.catch((err) => {
      console.error('Bot error:', err);
      this.notifyError('Bot Generic Error', err.message);
    });

    try {
      this.bot.botInfo = await this.bot.telegram.getMe();
      this.running = true;
      const hookUrl = SITE_URL + '/telegram/webhook/' + webhookSecret(token);
      const info = await this.bot.telegram.getWebhookInfo();
      var _fresh = info.url !== hookUrl;
      if (_fresh) await this.bot.telegram.setWebhook(hookUrl);
      console.log('✅ Bot Telegram berjalan');
      const baseCommands = [
        { command: "menu", description: "Menu Utama" },
        { command: "stats", description: "Statistik" },
        { command: "backup", description: "Backup Script" }
      ];
      if (_fresh) try {
        await this.bot.telegram.setMyCommands(baseCommands);
        await this.bot.telegram.setMyCommands([
          ...baseCommands,
          { command: "blocklist", description: "Daftar IP diblokir" },
          { command: "block", description: "Blokir IP manual" },
          { command: "unblock", description: "Buka blokir IP" },
          { command: "testchannel", description: "Tes notifikasi channel" }
        ], { scope: { type: 'chat', chat_id: Number(this.ownerId) } });
      } catch (e) {
        console.error('Gagal mengatur daftar perintah bot:', e.message);
      }
      if (_fresh) try {
        await this.bot.telegram.sendMessage(this.ownerId, `✅ <b>Bot Berhasil Tersambung</b>
Siap mengirim notifikasi.`, { parse_mode: 'HTML' });
      } catch (e) {
        console.error('Gagal kirim notifikasi tersambung:', e.message);
      }
    } catch (e) {
      console.error('❌ Gagal menjalankan bot:', e.message);
      this.running = false;
    }
  }

  async stopBot() {
    if (this.bot) {
      try { await this.bot.telegram.deleteWebhook(); } catch (e) { /* abaikan */ }
      this.bot = null;
      this.running = false;
      console.log('⏹️ Bot Telegram dihentikan');
    }
  }

  isRunning() { return this.running; }

  getChannelChatId() {
    const own = String(this.settings?.telegramChannelId || '').trim();
    if (own) return parseChannelTarget(own);
    return parseChannelTarget(this.settings?.channelInformation);
  }

  describeChannelError(e, chatId) {
    const message = String(e?.description || e?.message || 'Unknown error');
    if (/chat not found/i.test(message)) return `Channel ${chatId} tidak ditemukan. Cek @username atau ID channel di Pengaturan Admin.`;
    if (/not enough rights|administrator|forbidden|kicked|blocked/i.test(message)) return `Bot belum jadi admin di channel ${chatId} atau tidak punya izin kirim pesan.`;
    if (/can't parse entities/i.test(message)) return `Format pesan ditolak Telegram: ${message}`;
    return message;
  }

  async reportChannelFailure(reason) {
    const now = Date.now();
    if (this.lastChannelAlert && now - this.lastChannelAlert < 30 * 60 * 1000) return;
    this.lastChannelAlert = now;
    if (!this.running || !this.bot || !this.ownerId) return;
    try {
      await this.bot.telegram.sendMessage(this.ownerId, `⚠️ <b>Notifikasi Channel Gagal</b>

${escapeHtml(reason)}

<i>Cek dengan /testchannel setelah diperbaiki.</i>`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Gagal kirim laporan channel ke owner:', e.message);
    }
  }

  stripOwnerOnly(text) {
    return String(text || '').split('\n').filter(line => !line.includes(reqMeta.OWNER_ONLY)).join('\n');
  }

  ownerMeta(source) {
    const ip = reqMeta.cleanText(source?.reqIp, 45);
    if (!ip) return '';
    const device = reqMeta.cleanText(source?.reqDevice, 80) || 'Tidak diketahui';
    return `\n${reqMeta.OWNER_ONLY}🌍 IP: <code>${escapeHtml(ip)}</code>\n${reqMeta.OWNER_ONLY}📱 Device: ${escapeHtml(device)}`;
  }

  async sendToChannel(text, extra = {}) {
    if (!this.running || !this.bot) return false;
    text = this.stripOwnerOnly(text);
    const chatId = this.getChannelChatId();
    if (!chatId) {
      this.reportChannelFailure('Channel Telegram belum diatur atau formatnya tidak valid. Isi kolom "Channel Telegram (Notifikasi)" di Pengaturan Admin dengan @username channel atau ID channel (-100xxxxxxxxxx).');
      return false;
    }
    const options = {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🌐 Website', url: SITE_URL }]] },
      ...extra
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.bot.telegram.sendMessage(chatId, text, options);
        return true;
      } catch (e) {
        const wait = e?.response?.parameters?.retry_after;
        if (wait && attempt === 0 && wait <= 30) {
          await new Promise(resolve => setTimeout(resolve, wait * 1000 + 200));
          continue;
        }
        if (attempt === 0 && /BUTTON_URL_INVALID|reply markup/i.test(e?.message || '') && options.reply_markup) {
          // Tombol link ditolak Telegram -> kirim ulang tanpa tombol agar notifikasi tetap sampai
          delete options.reply_markup;
          continue;
        }
        console.error('Gagal kirim ke channel:', e.message);
        this.reportChannelFailure(this.describeChannelError(e, chatId));
        return false;
      }
    }
    return false;
  }

  sensorAccount(num) {
    if (!num) return 'XXXXXX';
    const str = String(num);
    if (str.length <= 6) return 'XXXXXX';
    return str.slice(0, -6) + 'XXXXXX';
  }

  formatTime(date = new Date()) {
    return date.toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(/\./g, ':');
  }

  brandHeader() {
    return `🌐 <b>${escapeHtml(this.settings.name)} | Payment Gateway</b>`;
  }

  buildDepositText(transaction, user, forOwner) {
    const id = forOwner ? `<code>${escapeHtml(transaction._id)}</code>` : escapeHtml(transaction._id);
    return `${this.brandHeader()}

<b>✅ Deposit Berhasil</b>
ID: ${id}
User: ${escapeHtml(user.username)}
Jumlah: ${formatRupiah(transaction.amount)}
Biaya: ${formatRupiah(transaction.fee)}
Total: ${formatRupiah(transaction.total)}
Saldo Akhir: ${formatRupiah(user.balance)}${forOwner ? this.ownerMeta(transaction) : ''}

<i>⏰ ${this.formatTime()}</i>`;
  }

  async notifyDeposit(transaction, user) {
    const userFull = await User.findById(user._id).lean();
    sendWebhook(userFull, 'deposit.paid', { invoice_id: transaction._id, amount: transaction.amount, fee: transaction.fee, total: transaction.total, status: 'paid', balance_after: transaction.balanceAfter || user.balance });
    if (!this.running || !this.bot || !this.settings) return;
    if (this.ownerId) {
      try {
        await this.bot.telegram.sendMessage(this.ownerId, this.buildDepositText(transaction, user, true), { parse_mode: 'HTML' });
      } catch (e) {
        console.error('Notif deposit gagal:', e.message);
      }
    }
    this.notifyDepositToChannel(transaction, user);
  }

  async notifyDepositToChannel(transaction, user) {
    await this.sendToChannel(this.buildDepositText(transaction, user, false));
  }

  async notifyWithdrawRequest(transaction, user) {
    if (!this.running || !this.bot || !this.ownerId) return;
    const text = `${this.brandHeader()}

🏧 <b>Permintaan Withdraw Baru</b>
ID: <code>${escapeHtml(transaction._id)}</code>
User: ${escapeHtml(user.username)}
Metode: ${escapeHtml(transaction.method)}
Nama: ${escapeHtml(transaction.accountName || '-')}
No.Rekening: <code>${escapeHtml(transaction.accountNumber)}</code>
Jumlah: ${formatRupiah(transaction.amount)}
Biaya: ${formatRupiah(transaction.fee)}
Saldo Akhir: ${formatRupiah(user.balance)}${this.ownerMeta(transaction)}

<i>⏰ ${this.formatTime()}</i>`;
    const keyboard = { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${transaction._id}` }, { text: '❌ Reject', callback_data: `reject_${transaction._id}` }]] };
    try {
      const message = await this.bot.telegram.sendMessage(this.ownerId, text, { reply_markup: keyboard, parse_mode: 'HTML' });
      await this.bot.telegram.pinChatMessage(this.ownerId, message.message_id, { disable_notification: true });
    } catch (e) {
      console.error('Notif withdraw gagal:', e.message);
    }
  }

  async notifyPaymentRequest(request, user) {
    if (!this.running || !this.bot || !this.ownerId) return;
    const knownIp = (user.loginIps || []).find(i => i.ip === request.reqIp);
    let ipStatus = '⚠️ IP belum pernah login sebelumnya';
    if (knownIp) {
      const ageMs = new Date(request.createdAt) - new Date(knownIp.firstSeen);
      ipStatus = ageMs < 48 * 60 * 60 * 1000 ? '⚠️ IP baru (pertama login kurang dari 48 jam)' : '✅ IP sudah dikenal';
    }
    const jenis = request.replacesNumber ? `Ganti dari <code>${escapeHtml(request.replacesNumber)}</code>` : 'Payment baru';
    const caption = `${this.brandHeader()}

💳 <b>Permintaan Payment</b>
ID: <code>${escapeHtml(request._id)}</code>
User: ${escapeHtml(user.username)}
Provider: ${escapeHtml(request.provider)}
Nama: ${escapeHtml(request.accountName)}
Nomor: <code>${escapeHtml(request.accountNumber)}</code>
Jenis: ${jenis}${this.ownerMeta(request)}
Status IP: ${ipStatus}

<i>⏰ ${this.formatTime()}</i>`;
    const keyboard = { inline_keyboard: [[{ text: '✅ Approve', callback_data: `payapprove_${request._id}` }, { text: '❌ Reject', callback_data: `payreject_${request._id}` }]] };
    try {
      await this.bot.telegram.sendPhoto(this.ownerId, { source: await getBlobBuffer(request.screenshot) }, { caption, parse_mode: 'HTML', reply_markup: keyboard });
    } catch (e) {
      console.error('Notif payment gagal:', e.message);
      try {
        await this.bot.telegram.sendMessage(this.ownerId, caption + '\n\n⚠️ Screenshot gagal dikirim, cek di menu Permintaan Payment di website.', { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (e2) { console.error('Notif payment (teks) gagal:', e2.message); }
    }
  }

  async notifyInstantWithdraw(transaction, user, failed = false, reason = '') {
    const userFull = await User.findById(user._id).lean();
    if (failed) {
      sendWebhook(userFull, 'withdraw.rejected', { withdraw_id: transaction._id, amount: transaction.amount, fee: transaction.fee, method: transaction.method, reason, status: 'rejected', balance_after: transaction.balanceAfter || user.balance });
    } else {
      sendWebhook(userFull, 'withdraw.success', { withdraw_id: transaction._id, amount: transaction.amount, fee: transaction.fee, method: transaction.method, destination: transaction.destination || transaction.accountNumber, status: 'success', balance_after: transaction.balanceAfter || user.balance });
    }
    if (!this.running || !this.bot || !this.settings) return;
    if (this.ownerId) {
      const header = failed ? '❌ <b>Withdraw Instan Gagal</b>' : '⚡ <b>Withdraw Instan Berhasil</b>';
      const text = `${this.brandHeader()}

${header}
ID: <code>${escapeHtml(transaction._id)}</code>
User: ${escapeHtml(user.username)}
Metode: ${escapeHtml(transaction.method)}
No.Rekening: <code>${escapeHtml(transaction.destination || transaction.accountNumber)}</code>
Jumlah: ${formatRupiah(transaction.amount)}
Biaya: ${formatRupiah(transaction.fee)}
Saldo Akhir: ${formatRupiah(user.balance)}${this.ownerMeta(transaction)}

<i>⏰ ${this.formatTime()}</i>${failed && reason ? `
Alasan: ${escapeHtml(reason)}` : ''}`;
      try {
        await this.bot.telegram.sendMessage(this.ownerId, text, { parse_mode: 'HTML' });
      } catch (e) {
        console.error('Notif withdraw instan gagal:', e.message);
      }
    }
    if (!failed) this.notifyWithdrawSuccessToChannel(transaction, user);
  }

  async notifyWithdrawSuccessToChannel(transaction, user) {
    if (!this.settings) return;
    const tipe = transaction.instant ? 'Instan' : 'Manual';
    const text = `${this.brandHeader()}

<b>⚡ Withdraw Berhasil</b>
ID: ${escapeHtml(transaction._id)}
Tipe: ${tipe}
User: ${escapeHtml(user.username)}
Metode: ${escapeHtml(transaction.method)}
No.Rekening: ${escapeHtml(this.sensorAccount(transaction.destination || transaction.accountNumber))}
Jumlah: ${formatRupiah(transaction.amount)}
Biaya: ${formatRupiah(transaction.fee)}
Saldo Akhir: ${formatRupiah(user.balance)}

<i>⏰ ${this.formatTime()}</i>`;
    await this.sendToChannel(text);
  }

  async notifyError(endpoint, errorMessage) {
    if (!this.running || !this.bot || !this.ownerId) return;
    const text = `⚠️ <b>Error Terdeteksi</b>
<i>- Endpoint:</i> <code>${escapeHtml(endpoint)}</code>
<i>- Waktu:</i> ${this.formatTime()}
<i>- Pesan:</i> ${escapeHtml(String(errorMessage ?? '').slice(0, 800))}${this.ownerMeta(reqMeta.current())}`;
    try {
      await this.bot.telegram.sendMessage(this.ownerId, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Gagal kirim notifikasi error:', e.message);
    }
  }

  buildBlocklistView() {
    const items = ipGuard.list();
    const shown = items.slice(0, 10);
    const rows = shown.map(entry => [{ text: `🔓 ${entry.ip}`, callback_data: `unblock_${entry.ip}` }]);
    rows.push([{ text: '🔄 Refresh', callback_data: 'blocklist' }]);
    const body = shown.length
      ? shown.map((entry, index) => `${index + 1}. <code>${escapeHtml(entry.ip)}</code>
${escapeHtml(entry.reason)}
Sisa: ${ipGuard.remainingOf(entry)}`).join(LINE_BREAK + LINE_BREAK)
      : 'Tidak ada IP yang sedang diblokir.';
    const more = items.length > shown.length ? `${LINE_BREAK}${LINE_BREAK}<i>+${items.length - shown.length} IP lainnya</i>` : '';
    const text = `🛡️ <b>Daftar IP Diblokir</b> (${items.length})

${body}${more}

<i>Ketuk IP untuk membuka blokir, atau pakai /unblock &lt;ip&gt;</i>`;
    return { text, keyboard: { inline_keyboard: rows } };
  }

  async notifyIpBlocked(entries) {
    if (!this.running || !this.bot || !this.ownerId || !entries.length) return;
    let text;
    let keyboard;
    if (entries.length === 1) {
      const entry = entries[0];
      text = `🛡️ <b>IP Diblokir Otomatis</b>

IP: <code>${escapeHtml(entry.ip)}</code>
Alasan: ${escapeHtml(entry.reason)}
Durasi: ${ipGuard.durationOf(entry)}
Pelanggaran ke: ${entry.offenses}
Total request: ${entry.hits}

<i>⏰ ${this.formatTime(new Date(entry.blockedAt))}</i>`;
      keyboard = { inline_keyboard: [[{ text: '🔓 Buka Blokir', callback_data: `unblock_${entry.ip}` }, { text: '📋 Daftar Blokir', callback_data: 'blocklist' }]] };
    } else {
      const lines = entries.slice(0, 10).map(entry => `• <code>${escapeHtml(entry.ip)}</code> — ${escapeHtml(entry.reason)} (${ipGuard.durationOf(entry)})`).join(LINE_BREAK);
      const more = entries.length > 10 ? `${LINE_BREAK}<i>+${entries.length - 10} IP lainnya</i>` : '';
      text = `🛡️ <b>${entries.length} IP Diblokir Otomatis</b>

${lines}${more}

<i>⏰ ${this.formatTime()}</i>`;
      keyboard = { inline_keyboard: [[{ text: '📋 Daftar Blokir', callback_data: 'blocklist' }]] };
    }
    try {
      await this.bot.telegram.sendMessage(this.ownerId, text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (e) {
      console.error('Notif IP diblokir gagal:', e.message);
    }
  }

  async createBackup(ctx) {
    return ctx.reply('ℹ️ Backup file tidak tersedia di Vercel. Data tersimpan di MongoDB, gunakan Atlas Backup untuk mencadangkan database.');
  }

  async finishWithdrawMessage(ctx, statusHtml) {
    const original = escapeHtml(ctx.callbackQuery.message.text || '');
    const message = await ctx.editMessageText(`${original}

${statusHtml}`, { parse_mode: 'HTML' });
    try {
      await ctx.telegram.unpinChatMessage(ctx.chat.id, message.message_id);
    } catch (e) {
      console.error('Gagal unpin pesan withdraw:', e.message);
    }
  }

  async approveWithdrawal(ctx, wdId) {
    try {
      const trx = await this.models.Transaction.findOne({ _id: wdId, type: 'withdraw' });
      if (!trx || trx.status !== 'pending') return ctx.editMessageText('⚠️ Withdrawal tidak ditemukan atau sudah diproses.');
      trx.status = 'success'; trx.completedAt = new Date(); await trx.save();
      const user = await this.models.User.findById(trx.userId).lean();
      if (user) {
        this.notifyWithdrawSuccessToChannel(trx, user);
        sendWebhook(user, 'withdraw.success', { withdraw_id: trx._id, amount: trx.amount, fee: trx.fee, method: trx.method, account_number: trx.accountNumber, status: 'success', balance_after: trx.balanceAfter || user.balance });
      }
      await this.finishWithdrawMessage(ctx, '✅ <b>Approved</b>');
    } catch (e) {
      console.error(e);
      this.notifyError('/approveWithdrawal', e.message);
      ctx.editMessageText('❌ Gagal approve.').catch(() => {});
    }
  }

  async showRejectReasons(ctx, wdId) {
    const keyboard = { inline_keyboard: [
      [{ text: '1. Data Ewallet Tidak Valid', callback_data: `rejectReason_${wdId}_0` }],
      [{ text: '2. Nama Akun Tidak Valid', callback_data: `rejectReason_${wdId}_1` }],
      [{ text: '3. Metode Penarikan Tidak Valid', callback_data: `rejectReason_${wdId}_2` }],
      [{ text: '🔙 Batalkan', callback_data: `cancelReject_${wdId}` }]
    ]};
    await ctx.editMessageReplyMarkup(keyboard);
  }

  async rejectWithdrawal(ctx, wdId, reason) {
    try {
      const trx = await this.models.Transaction.findOne({ _id: wdId, type: 'withdraw' });
      if (!trx || trx.status !== 'pending') return ctx.editMessageText('⚠️ Withdrawal tidak ditemukan atau sudah diproses.');
      trx.status = 'rejected'; trx.adminNote = reason; trx.completedAt = new Date();
      await this.models.User.findByIdAndUpdate(trx.userId, { $inc: { balance: trx.amount + trx.fee } });
      const userAfter = await this.models.User.findById(trx.userId);
      trx.balanceAfter = userAfter.balance;
      await trx.save();
      const user = await this.models.User.findById(trx.userId).lean();
      if (user) sendWebhook(user, 'withdraw.rejected', { withdraw_id: trx._id, amount: trx.amount, fee: trx.fee, method: trx.method, reason, status: 'rejected', balance_after: trx.balanceAfter || user.balance });
      await this.finishWithdrawMessage(ctx, `❌ <b>Ditolak</b>
Alasan: ${escapeHtml(reason)}`);
    } catch (e) {
      console.error(e);
      this.notifyError('/rejectWithdrawal', e.message);
      ctx.editMessageText('❌ Gagal reject.').catch(() => {});
    }
  }
}

// ================== GLOBAL MIDDLEWARE (AUTH) ==================
app.use(async (req, res, next) => {
  res.locals.user = null;
  if (req.session.userId) {
    try {
      const user = await User.findById(req.session.userId);
      if (user) res.locals.user = user.toObject();
    } catch {}
  }
  if (req.session.userRole === 'admin') ipGuard.trust(req.clientIp);
  res.locals.settings = await getSettings();
  res.locals.currentPath = req.path;
  res.locals.error = req.session.errorMsg || null;
  res.locals.success = req.session.successMsg || null;
  delete req.session.errorMsg;
  delete req.session.successMsg;
  next();
});

function isAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.userRole === 'admin') return next();
  res.redirect('/login');
}

// ================== SEED ==================
async function seed() {
  const ex = await User.findOne({ role: "admin" });
  if (!ex) {
    await User.create({ username: (process.env.ADMIN_USERNAME || 'admin').toLowerCase(), email: process.env.ADMIN_EMAIL || 'admin@gmail.com', password: hashPassword(process.env.ADMIN_PASSWORD || 'admin123'), role: 'admin' });
    console.log(`🔑 Admin Account Default\nUsername: admin\nPassword: admin123`);
  }
  const settings = await getSettings();
  if (!settings.withdrawMethods || settings.withdrawMethods.length === 0) {
    settings.withdrawMethods = [
      { name: 'Dana', fee: 1000, min: 10000, max: 1000000 },
      { name: 'GoPay', fee: 2000, min: 10000, max: 1000000 }
    ];
    await settings.save();
  }
}

// ================== ROUTES DASHBOARD / AUTH ==================
// ================== PUBLIC MONITORING (HALAMAN AWAL) ==================
const PUBLIC_STATS_TTL = 15 * 1000;
const PUBLIC_BUCKET_MS = 30 * 60 * 1000; // 1 titik grafik = 30 menit, total 48 titik (24 jam)
let publicStatsCache = { at: 0, data: null };

async function buildPublicStats() {
  const now = Date.now();
  if (publicStatsCache.data && now - publicStatsCache.at < PUBLIC_STATS_TTL) return publicStatsCache.data;

  const since = new Date(now - 24 * 60 * 60 * 1000);
  const prevSince = new Date(now - 48 * 60 * 60 * 1000);
  const bucketExpr = { $floor: { $divide: [{ $toLong: '$createdAt' }, PUBLIC_BUCKET_MS] } };

  const [series, depositNow, depositPrev, withdrawNow, statusAgg, totalUsers, totalProjects, recent] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'deposit', status: 'paid', createdAt: { $gte: since } } },
      { $group: { _id: bucketExpr, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Transaction.aggregate([
      { $match: { type: 'deposit', status: 'paid', createdAt: { $gte: since } } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Transaction.aggregate([
      { $match: { type: 'deposit', status: 'paid', createdAt: { $gte: prevSince, $lt: since } } },
      { $group: { _id: null, amount: { $sum: '$amount' } } }
    ]),
    Transaction.aggregate([
      { $match: { type: 'withdraw', status: 'success', createdAt: { $gte: since } } },
      { $group: { _id: null, amount: { $sum: '$amount' } } }
    ]),
    Transaction.aggregate([
      { $match: { type: 'deposit', createdAt: { $gte: since }, status: { $in: ['paid', 'expired', 'cancelled'] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    User.countDocuments({ role: 'user' }),
    User.countDocuments({ role: 'user', projectName: { $nin: ['', null] } }),
    Transaction.find({ type: 'deposit', status: 'paid' }).sort({ createdAt: -1 }).limit(6).select('amount createdAt').lean()
  ]);

  // Susun 48 titik grafik (lama -> baru), bucket kosong diisi 0
  const currentBucket = Math.floor(now / PUBLIC_BUCKET_MS);
  const map = new Map(series.map(r => [r._id, r]));
  const points = [];
  for (let i = 47; i >= 0; i--) {
    const b = currentBucket - i;
    const r = map.get(b);
    points.push({ t: b * PUBLIC_BUCKET_MS, amount: r ? r.amount : 0, count: r ? r.count : 0 });
  }

  const st = Object.fromEntries(statusAgg.map(r => [r._id, r.count]));
  const finished = (st.paid || 0) + (st.expired || 0) + (st.cancelled || 0);
  const successRate = finished > 0 ? Math.round(((st.paid || 0) / finished) * 1000) / 10 : null;

  const nowAmount = depositNow[0]?.amount || 0;
  const prevAmount = depositPrev[0]?.amount || 0;
  const changePct = prevAmount > 0 ? Math.round(((nowAmount - prevAmount) / prevAmount) * 1000) / 10 : null;

  const data = {
    generatedAt: now,
    depositAmount24h: nowAmount,
    depositCount24h: depositNow[0]?.count || 0,
    withdrawAmount24h: withdrawNow[0]?.amount || 0,
    totalUsers,
    totalProjects,
    changePct,
    successRate,
    points,
    recent: recent.map(r => ({ amount: r.amount, at: new Date(r.createdAt).getTime() }))
  };
  const st0 = await getSettings();
  if (st0.statsOverrideEnabled) {
    data.depositAmount24h = st0.statDeposit24h;
    data.withdrawAmount24h = st0.statWithdraw24h;
    data.totalUsers = st0.statTotalUsers;
  }
  data.site = { name: st0.name, title: st0.title, description: st0.description, logoUrl: st0.logoUrl };
  publicStatsCache = { at: now, data };
  return data;
}

app.get('/api/public/stats', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await buildPublicStats());
  } catch (e) {
    console.error('public stats error:', e.message);
    res.status(500).json({ error: 'stats_unavailable' });
  }
});

app.get('/', async (req, res) => {
  let pubStats = null;
  try { pubStats = await buildPublicStats(); } catch (e) { console.error('home stats error:', e.message); }
  res.render('home', { pubStats });
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('login');
});

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('register');
});

app.post('/login', Limiter, async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) { req.session.errorMsg = 'Harap isi semua field'; return res.redirect('/login'); }
  const isEmail = login.includes('@');
  let user;
  if (isEmail) {
    user = await User.findOne({ email: login.toLowerCase() });
    if (user && user.role === 'admin') { req.session.errorMsg = 'Admin hanya dapat login menggunakan username'; return res.redirect('/login'); }
  } else {
    user = await User.findOne({ username: login.toLowerCase() });
  }
  if (!user || !verifyPassword(password, user.password)) { req.session.errorMsg = 'Username/email atau kata sandi salah'; return res.redirect('/login'); }
  if (user.suspended) { req.session.errorMsg = 'Akun Anda dinonaktifkan'; return res.redirect('/login'); }
  req.session.userId = user._id;
  req.session.userRole = user.role;
  if (user.role === 'admin') return res.redirect('/admin/dashboard');
  try {
    const meta = reqMeta.fromReq(req);
    if (meta.reqIp) {
      const ips = (user.loginIps || []).map(i => i.toObject ? i.toObject() : i);
      const found = ips.find(i => i.ip === meta.reqIp);
      if (found) { found.lastSeen = new Date(); found.device = meta.reqDevice; }
      else ips.push({ ip: meta.reqIp, device: meta.reqDevice, firstSeen: new Date(), lastSeen: new Date() });
      ips.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
      await User.findByIdAndUpdate(user._id, { loginIps: ips.slice(0, 15) });
    }
  } catch (e) { console.error('Gagal mencatat IP login:', e.message); }
  req.session.showSocialPopup = true;
  req.session.socialPopupSeen = false;
  res.redirect('/dashboard');
});

app.post('/register', Limiter, async (req, res) => {
  const { username, email, password } = req.body;
  const trimmedUsername = username?.trim() || '';
  if (!trimmedUsername) { req.session.errorMsg = 'Username tidak boleh kosong'; return res.redirect('/register'); }
  if (!/^[a-zA-Z0-9]+$/.test(trimmedUsername)) { req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka'; return res.redirect('/register'); }
  if (trimmedUsername.length > 15) { req.session.errorMsg = 'Username maksimal 15 karakter'; return res.redirect('/register'); }
  const normalizedUsername = trimmedUsername.toLowerCase();
  const normalizedEmail = email?.trim().toLowerCase();
  try {
    const existingUsername = await User.findOne({ username: normalizedUsername });
    if (existingUsername) { req.session.errorMsg = 'Username sudah terdaftar'; return res.redirect('/register'); }
    const existingEmail = await User.findOne({ email: normalizedEmail });
    if (existingEmail) { req.session.errorMsg = 'Email sudah terdaftar'; return res.redirect('/register'); }
    const user = await User.create({ username: normalizedUsername, email: normalizedEmail, password: hashPassword(password) });
    await createWithRetry(ApiKey, { userId: user._id, key: generateApiKey() });
    req.session.userId = user._id;
    req.session.userRole = 'user';
    req.session.showSocialPopup = true;
    req.session.socialPopupSeen = false;
    return res.redirect('/dashboard');
  } catch (err) {
    if (err.name === 'ValidationError') {
      req.session.errorMsg = Object.values(err.errors).map(e => e.message).join(', ');
    } else {
      req.session.errorMsg = 'Gagal mendaftar, periksa kembali data Anda';
    }
    return res.redirect('/register');
  }
});

app.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('forgot_password');
});

app.post('/forgot-password', Limiter, async (req, res) => {
  const login = String(req.body.login || '').trim();
  if (!login) { req.session.errorMsg = 'Harap masukkan email atau username Anda.'; return res.redirect('/forgot-password'); }
  try {
    const settings = await getSettings();
    if (!settings.smtpUser || !settings.smtpPass) { req.session.errorMsg = 'Fitur lupa password belum tersedia.'; return res.redirect('/forgot-password'); }
    const isEmail = login.includes('@');
    let user;
    if (isEmail) user = await User.findOne({ email: login.toLowerCase() });
    else user = await User.findOne({ username: login.toLowerCase() });
    if (!user) { req.session.errorMsg = 'Akun tidak ditemukan.'; return res.redirect('/forgot-password'); }
    if (!user.email) { req.session.errorMsg = 'Akun ini tidak memiliki alamat email yang valid.'; return res.redirect('/forgot-password'); }
    const token = crypto.randomBytes(32).toString('hex');
    // updateOne (bukan save) supaya validasi field lain (mis. username lama) tidak menggagalkan reset
    await User.updateOne({ _id: user._id }, { $set: { resetPasswordToken: token, resetPasswordExpires: new Date(Date.now() + 30 * 60 * 1000) } });
    // Set BASE_URL di .env (mis. https://domainmu.com) agar link selalu benar & aman dari spoofing header Host
    const baseUrl = String(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const resetLink = `${baseUrl}/reset-password/${token}`;
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: String(settings.smtpUser).trim(), pass: String(settings.smtpPass).replace(/\s+/g, '') },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000
    });
    await transporter.sendMail({
      to: user.email,
      from: `"${settings.name}" <${settings.smtpUser}>`,
      subject: `Permintaan Reset Password`,
      html: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background-color:#f9f9f9;padding:40px 20px;margin:0;"><div style="max-width:500px;margin:0 auto;background-color:#ffffff;border:1px solid #dddddd;border-radius:2px;overflow:hidden;"><div style="padding:28px 24px 0;text-align:center;"><h2 style="color:#1f2937;font-size:20px;font-weight:600;margin:0 0 4px;">${settings.name}</h2><p style="color:#1f2937;font-size:14px;margin:0 0 4px;">${settings.title}</p></div><div style="padding:24px;"><p style="color:#4b5563;font-size:14px;line-height:1.5;margin:0 0 20px;">Halo <strong style="color:#1f2937;">${user.username}</strong>,<br>Kami menerima permintaan untuk mengatur ulang kata sandi akun Anda di <strong>${settings.name}</strong>. Jika ini memang Anda, silakan klik tombol di bawah ini:</p><div style="text-align:center;margin-bottom:24px;"><a href="${resetLink}" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:2px;font-weight:600;font-size:14px;line-height:1.5;">Ganti Password Saya</a></div><p style="color:#dc2626;font-size:13px;font-weight:600;text-align:center;margin-bottom:24px;background-color:#fef2f2;border:1px solid #fecaca;padding:10px 14px;border-radius:2px;">Tautan ini hanya berlaku selama 30 menit.</p><div style="border-top:1px solid #dddddd;padding-top:20px;margin-top:8px;"><p style="color:#9ca3af;font-size:14px;line-height:1.5;margin:0;">Jika tombol di atas tidak berfungsi, salin dan tempel URL berikut ke browser Anda:<br><a href="${resetLink}" style="color:#3b82f6;word-break:break-all;text-decoration:none;">${resetLink}</a></p></div></div></div><div style="text-align:center;max-width:480px;margin:20px auto 0;"><p style="color:#9ca3af;font-size:14px;margin:0;">&copy; ${new Date().getFullYear()} ${settings.name}. All rights reserved.</p></div></div>`
    });
    req.session.successMsg = `Link reset password telah dikirim ke email. Cek juga folder Spam.`;
    res.redirect('/forgot-password');
  } catch (error) {
    console.error('Error Forgot Password:', error);
    if (botManager) botManager.notifyError('/forgot-password', error.message);
    req.session.errorMsg = error && error.code === 'EAUTH'
      ? 'Login SMTP ditolak. Periksa email & App Password di pengaturan admin.'
      : 'Gagal mengirim email reset. Silakan coba lagi sebentar lagi.';
    res.redirect('/forgot-password');
  }
});

app.get('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({ resetPasswordToken: req.params.token, resetPasswordExpires: { $gt: Date.now() } });
    if (!user) { req.session.errorMsg = 'Link reset tidak valid atau sudah kedaluwarsa (berlaku 30 menit).'; return res.redirect('/forgot-password'); }
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.render('reset_password', { token: req.params.token });
  } catch (error) { res.redirect('/login'); }
});

app.post('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({ resetPasswordToken: req.params.token, resetPasswordExpires: { $gt: Date.now() } });
    if (!user) { req.session.errorMsg = 'Token reset password tidak valid atau sudah kedaluwarsa.'; return res.redirect('/forgot-password'); }
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    if (password.length < 4) { req.session.errorMsg = 'Password minimal 4 karakter.'; return res.redirect(`/reset-password/${req.params.token}`); }
    if (password !== confirmPassword) { req.session.errorMsg = 'Password dan konfirmasi password tidak cocok.'; return res.redirect(`/reset-password/${req.params.token}`); }
    await User.updateOne({ _id: user._id }, { $set: { password: hashPassword(password) }, $unset: { resetPasswordToken: 1, resetPasswordExpires: 1 } });
    req.session.successMsg = 'Password berhasil diubah. Silakan login dengan password baru.';
    res.redirect('/login');
  } catch (error) { console.error('Error Reset Password:', error); req.session.errorMsg = 'Gagal mereset password. Silakan coba lagi.'; res.redirect(`/reset-password/${req.params.token}`); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ================== USER DASHBOARD ==================
app.get('/dashboard', isAuth, async (req, res) => {
  if (req.session.userRole === 'admin') return res.redirect('/admin/dashboard');
  const user = res.locals.user;
  const totalDeposit = (await Transaction.aggregate([
    { $match: { userId: user._id, type: 'deposit', status: 'paid' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]))[0]?.total || 0;
  const totalWithdraw = (await Transaction.aggregate([
    { $match: { userId: user._id, type: 'withdraw', status: 'success' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]))[0]?.total || 0;
  const recentTrx = await Transaction.find({ userId: user._id, type: 'deposit' }).sort({ createdAt: -1 }).lean();
  const apiKeys = await ApiKey.find({ userId: req.session.userId }).lean();
  let pubStats = null;
  try { pubStats = await buildPublicStats(); } catch (e) { console.error('dashboard stats error:', e.message); }
  let socialLinks = [];
  if (req.session.showSocialPopup || !req.session.socialPopupSeen) {
    socialLinks = getSocialLinks(res.locals.settings);
    if (socialLinks.length) {
      req.session.socialPopupSeen = true;
      delete req.session.showSocialPopup;
    }
  }
  res.render('dashboard', { user, totalDeposit, totalWithdraw, recentTrx, apiKeys, pubStats, socialLinks });
});

// Profile
app.get('/profile', isAuth, async (req, res) => {
  const user = await User.findById(req.session.userId).lean();
  const apiKeys = await ApiKey.find({ userId: req.session.userId }).lean();
  const settings = res.locals.settings;
  const providerMap = new Map();
  (settings.withdrawMethods || []).forEach(m => {
    providerMap.set(m.name.toLowerCase(), { name: m.name, manualFee: m.fee || 0, instantFee: null });
  });
  (settings.instantWithdrawMethods || []).filter(m => m.active).forEach(m => {
    const key = m.name.toLowerCase();
    const found = providerMap.get(key);
    if (found) found.instantFee = m.fee || 0;
    else providerMap.set(key, { name: m.name, manualFee: null, instantFee: m.fee || 0 });
  });
  const providers = [...providerMap.values()];
  const paymentAccounts = await PaymentAccount.find({ userId: req.session.userId }).sort({ createdAt: 1 }).lean();
  const pendingPayments = await PaymentRequest.find({ userId: req.session.userId, status: 'pending' }).sort({ createdAt: -1 }).lean();
  const lastRejected = await PaymentRequest.findOne({ userId: req.session.userId, status: 'rejected' }).sort({ processedAt: -1 }).lean();
  res.render('profile', { apiKeys, user, providers, paymentAccounts, pendingPayments, lastRejected, adminTelegram: ADMIN_TELEGRAM });
});

app.post('/profile/payment', isAuth, (req, res, next) => {
  proofUpload.single('screenshot')(req, res, (err) => {
    if (err) {
      req.session.errorMsg = err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran screenshot maksimal 4 MB.' : (err.message || 'Gagal mengunggah screenshot.');
      return res.redirect('/profile');
    }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  const fail = (msg) => {
    req.session.errorMsg = msg;
    return res.redirect('/profile');
  };
  try {
    if (req.session.userRole === 'admin') return fail('Akun admin tidak memerlukan payment.');
    const settings = res.locals.settings;
    const providerKey = String(req.body.provider || '').trim().toLowerCase();
    const names = [
      ...(settings.withdrawMethods || []).map(m => m.name),
      ...(settings.instantWithdrawMethods || []).filter(m => m.active).map(m => m.name)
    ];
    const provider = names.find(n => n.toLowerCase() === providerKey);
    if (!provider) return fail('Provider payment tidak valid.');

    const accountName = String(req.body.accountName || '').replace(/\s+/g, ' ').trim();
    if (accountName.length < 2 || accountName.length > 40 || !/^[\p{L}\p{N} .,'\-]+$/u.test(accountName)) {
      return fail('Nama akun payment tidak valid (2-40 karakter, huruf/angka saja).');
    }

    let accountNumber = String(req.body.accountNumber || '').replace(/[\s\-]/g, '');
    if (accountNumber.startsWith('+62')) accountNumber = '0' + accountNumber.slice(3);
    else if (/^62\d{9,13}$/.test(accountNumber)) accountNumber = '0' + accountNumber.slice(2);
    if (!/^\d{6,20}$/.test(accountNumber)) return fail('Nomor payment tidak valid (hanya angka, 6-20 digit).');

    if (!file) return fail('Screenshot profil payment wajib diunggah.');
    const head = file.buffer.slice(0, 12);
    let ext = '';
    if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) ext = '.jpg';
    else if (head.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) ext = '.png';
    else if (head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP') ext = '.webp';
    if (!ext) return fail('File screenshot tidak valid. Gunakan JPG, PNG, atau WEBP.');

    const existing = await PaymentAccount.findOne({ userId: req.session.userId, provider }).lean();
    if (existing && existing.accountNumber === accountNumber && existing.accountName.toLowerCase() === accountName.toLowerCase()) {
      return fail('Payment ' + provider + ' dengan data yang sama sudah terdaftar.');
    }
    const pendingAll = await PaymentRequest.find({ userId: req.session.userId, status: 'pending' }).select('provider').lean();
    if (pendingAll.some(r => r.provider === provider)) return fail('Masih ada permintaan ' + provider + ' yang menunggu persetujuan admin.');
    if (pendingAll.length >= 3) return fail('Terlalu banyak permintaan yang menunggu. Tunggu admin memproses dulu.');

    const finalName = await saveBlob(file.buffer, ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', 'proof');

    const request = await createWithRetry(PaymentRequest, {
      userId: req.session.userId,
      provider,
      accountName,
      accountNumber,
      screenshot: finalName,
      replacesNumber: existing ? existing.accountNumber : '',
      ...reqMeta.fromReq(req)
    }, 5, () => generateCustomId(startId.paymentRequest));

    if (botManager) {
      const user = await User.findById(req.session.userId).lean();
      botManager.notifyPaymentRequest(request, user);
    }
    req.session.successMsg = 'Permintaan payment terkirim. Mohon tunggu 1-24 jam kerja. Untuk percepat atau menambah payment baru, chat admin di Telegram (' + ADMIN_TELEGRAM.url + ').';
    res.redirect('/profile');
  } catch (err) {
    console.error('/profile/payment error:', err);
    if (botManager) botManager.notifyError('/profile/payment', err.message);
    return fail('Gagal mengirim permintaan payment. Silakan coba lagi.');
  }
});

app.post('/profile', isAuth, async (req, res) => {
  const { email, newPassword, projectName, callbackUrl, merchantLogoUrl } = req.body;
  try {
    const upd = { email };
    if (newPassword && newPassword.trim()) upd.password = hashPassword(newPassword);
    if (projectName !== undefined) {
      let trimmed = projectName.trim();
      if (trimmed.length > 25) trimmed = trimmed.substring(0, 25);
      upd.projectName = trimmed;
    }
    if (callbackUrl !== undefined) {
      const trimmedUrl = callbackUrl.trim();
      if (trimmedUrl === '') {
        upd.callbackUrl = '';
      } else {
        try {
          const parsed = new URL(trimmedUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
          upd.callbackUrl = trimmedUrl;
        } catch (err) {
          req.session.errorMsg = 'Callback URL tidak valid. Gunakan URL lengkap (https://...).';
          return res.redirect('/profile');
        }
      }
    }
    if (merchantLogoUrl !== undefined) {
      const trimmedLogo = merchantLogoUrl.trim();
      if (trimmedLogo === '') {
        upd.merchantLogoUrl = '';
      } else {
        try {
          new URL(trimmedLogo);
          upd.merchantLogoUrl = trimmedLogo;
        } catch (err) {
          req.session.errorMsg = 'URL Logo tidak valid. Gunakan URL lengkap (https://...).';
          return res.redirect('/profile');
        }
      }
    }
    await User.findByIdAndUpdate(req.session.userId, upd);
    req.session.successMsg = 'Profil berhasil diperbarui';
    res.redirect('/profile');
  } catch (err) {
    if (err.code === 11000) req.session.errorMsg = 'Email sudah digunakan oleh pengguna lain';
    else req.session.errorMsg = 'Gagal memperbarui profil';
    if (botManager) botManager.notifyError('/profile', err.message);
    res.redirect('/profile');
  }
});

app.post('/api/user/api-key/regenerate', isAuth, async (req, res) => {
  await ApiKey.deleteMany({ userId: req.session.userId });
  const key = generateApiKey();
  try {
    await createWithRetry(ApiKey, { userId: req.session.userId, key });
    res.json({ apiKey: key });
  } catch (err) {
    if (botManager) botManager.notifyError('/api/user/api-key/regenerate', err.message);
    res.status(500).json({ error: 'Gagal membuat API key' });
  }
});

// ================== DEPOSIT ROUTE ==================
app.get('/deposit', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const deposits = await Transaction.find({ userId: req.session.userId, type: 'deposit' }).sort({ createdAt: -1 }).lean();
  res.render('deposit', { deposits, minDeposit: settings.minDeposit });
});

async function createDepositTransaction(userId, amount, settings, meta = reqMeta.current()) {
  if (!settings) settings = await getSettings();
  if (isNaN(amount) || amount < settings.minDeposit) throw new Error(`Minimal deposit adalah Rp ${settings.minDeposit.toLocaleString('id-ID')}`);

  const oneDayAgo = new Date(Date.now() - 30 * 60 * 1000);
  const lockedTx = await Transaction.find({
    type: 'deposit',
    status: { $in: ['pending', 'paid'] },
    createdAt: { $gte: oneDayAgo }
  }).select('fee');
  const usedFees = lockedTx.map(i => Number(i.fee)).filter(f => !isNaN(f));

  const minFee = settings.minFee ?? 0;
  const maxFee = settings.maxFee ?? 500;

  let availableFees = [];
  for (let i = minFee; i <= maxFee; i++) {
    if (!usedFees.includes(i)) availableFees.push(i);
  }

  if (availableFees.length === 0) {
    for (let i = maxFee + 1; i <= maxFee + 100; i++) {
      if (!usedFees.includes(i)) {
        availableFees.push(i);
        break;
      }
    }
  }

  if (availableFees.length === 0) throw new Error('Kode unik deposit sedang penuh. Silakan coba lagi beberapa menit.');

  let fee = availableFees[Math.floor(Math.random() * availableFees.length)];
  let total = amount + fee;
  const expiredMinutes = settings.qrisExpiredMinutes || 30;
  let expiredAt = new Date(Date.now() + expiredMinutes * 60 * 1000);

  let qrisImage, trxid, providerTotal = 0;
  if (settings.paymentGateway === 'pakasir') {
    if (!settings.pakasirSlug || !settings.pakasirApiKey) throw new Error('Konfigurasi Pakasir belum lengkap. Hubungi admin.');
    try {
      const orderId = generateCustomId(startId.invoice);
      const result = await createPakasirQris(orderId, total, settings);
      trxid = result.trxid;
      qrisImage = result.qrisImage;
    } catch (e) { throw new Error('Gagal menghubungi Pakasir: ' + e.message); }
  } else if (settings.paymentGateway === 'xendit') {
    if (!settings.xenditSecretKey) throw new Error('Konfigurasi Xendit belum lengkap. Hubungi admin.');
    try {
      const orderId = generateCustomId(startId.invoice);
      const result = await createXenditQris(orderId, total, settings);
      trxid = result.trxid;
      qrisImage = result.qrisImage;
    } catch (e) { throw new Error('Gagal menghubungi Xendit: ' + (e.response?.data?.message || e.message)); }
  } else if (settings.paymentGateway === 'midtrans') {
    if (!settings.midtransServerKey || !settings.midtransClientKey) throw new Error('Konfigurasi Midtrans belum lengkap. Hubungi admin.');
    try {
      const orderId = generateCustomId(startId.invoice);
      const result = await createMidtransQris(orderId, total, settings);
      trxid = result.trxid;
      qrisImage = result.qrisImage;
    } catch (e) { throw new Error('Gagal menghubungi Midtrans: ' + (e.response?.data?.status_message || e.message)); }
  } else if (settings.paymentGateway === 'casaku') {
    if (!settings.casakuLicenseKey || !settings.casakuQrId || !settings.casakuPackageIds) throw new Error('Konfigurasi Casaku belum lengkap. Hubungi admin.');
    try {
      const result = await createCasakuQris(total, settings);
      trxid = result.trxid;
      qrisImage = result.qrisImage;
      providerTotal = result.total;
    } catch (e) { throw new Error('Gagal menghubungi Casaku: ' + (e.response?.data?.message || e.message)); }
  } else if (settings.paymentGateway === 'agw') {
    if (!settings.agwApiKey || !settings.agwBaseUrl) throw new Error('Konfigurasi Admin Gateway belum lengkap. Hubungi admin.');
    try {
      const orderId = generateCustomId(startId.invoice);
      // Nominal asli dikirim; kode unik ditentukan Admin Gateway (total_pay) lalu dipakai sebagai fee.
      const result = await createAgwQris(orderId, amount, settings);
      trxid = result.trxid;
      qrisImage = result.qrisImage;
      providerTotal = result.total;
      if (result.expiredAt && !isNaN(result.expiredAt.getTime())) expiredAt = result.expiredAt;
    } catch (e) { throw new Error('Gagal menghubungi Admin Gateway: ' + e.message); }
  } else if (settings.paymentGateway === 'klikqris') {
    if (!settings.klikqrisApiKey || !settings.klikqrisMerchantId) throw new Error('Konfigurasi KlikQRIS belum lengkap. Hubungi admin.');
    try {
      const orderId = generateCustomId(startId.invoice);
      const result = await createKlikqrisQris(orderId, total, settings);
      trxid = result.trxid;
      qrisImage = result.qrisImage;
      providerTotal = result.total;
    } catch (e) { throw new Error('Gagal menghubungi KlikQRIS: ' + (e.response?.data?.message || e.message)); }
  } else {
    if (!settings.gopayToken || !settings.gopayStaticQr) throw new Error('Konfigurasi Payment Gateway belum lengkap.');
    const gopayBase = settings.gopayDomain || 'gomerch.vercel.app';
    const apiUrl = `https://${gopayBase}/api/qris/create?amount=${total}&static_qr=${encodeURIComponent(settings.gopayStaticQr)}`;
    try {
      const data = await callGopayApiWithRetry(apiUrl);
      if (!data.success) throw new Error('Gagal membuat QRIS');
      qrisImage = data.image_url;
      trxid = generateCustomId(startId.invoice);
    } catch (e) { throw e; }
  }

  if (providerTotal >= amount && providerTotal !== total) {
    total = providerTotal;
    fee = total - amount;
  }

  const deposit = await createWithRetry(Transaction, {
    _id: generateCustomId(startId.invoice),
    userId,
    type: 'deposit',
    amount,
    fee,
    total,
    trxid,
    qris_image: qrisImage,
    expiredAt,
    status: 'pending',
    reference: generateCustomId(startId.invoice),
    gateway: settings.paymentGateway,
    reqIp: meta.reqIp,
    reqDevice: meta.reqDevice
  }, 5, () => generateCustomId(startId.invoice));

  return deposit;
}

app.post('/invoice/create', isAuth, async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    const settings = res.locals.settings;
    const deposit = await createDepositTransaction(req.session.userId, amount, settings, reqMeta.fromReq(req));
    const user = await User.findById(req.session.userId).lean();
    return res.json({
      reference: deposit._id.toString(),
      id: deposit._id.toString(),
      amount: deposit.amount,
      fee: deposit.fee,
      total: deposit.total,
      qris_image: deposit.qris_image,
      createdAt: deposit.createdAt,
      expiredAt: deposit.expiredAt,
      status: 'pending',
      callback_url: user.callbackUrl || ''
    });
  } catch (e) {
    console.error('Create invoice error:', e.message);
    if (botManager) botManager.notifyError('/invoice/create', e.message);
    return res.status(400).json({ error: e.message });
  }
});

// ================== WITHDRAW ROUTES (WEB) ==================
// Xendit punya API payout sendiri, jadi withdraw instan memakai channel Xendit saat gateway ini aktif.
// Gateway lain (Pakasir, Midtrans, Casaku, KlikQRIS, GoPay Merchant) tidak punya sistem penarikan,
// sehingga withdraw instan dikirim lewat H2H Orderkuota (saldo Orderkuota owner harus terisi).
// Setiap hari yang ditandai sebagai hari libur (default Minggu) juga memaksa semua penarikan menjadi manual.

function getInstantWithdrawMethods(settings) {
  if (settings.withdrawHolidayManualOnly && isWithdrawHoliday(settings)) return [];
  return (settings.instantWithdrawMethods || []).filter(m => m.active);
}

app.get('/withdraw', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const instantMethods = getInstantWithdrawMethods(settings);
  const withdrawals = await Transaction.find({ userId: req.session.userId, type: 'withdraw' }).sort({ createdAt: -1 }).lean();
  const paymentAccounts = await PaymentAccount.find({ userId: req.session.userId }).sort({ createdAt: 1 }).lean();
  const manualPayments = [];
  const instantPayments = [];
  paymentAccounts.forEach(pa => {
    const key = pa.provider.toLowerCase();
    const mm = (settings.withdrawMethods || []).find(m => m.name.toLowerCase() === key);
    if (mm) manualPayments.push({ id: pa._id, provider: pa.provider, accountName: pa.accountName, accountNumber: pa.accountNumber, fee: mm.fee || 0, min: mm.min || 0 });
    const im = instantMethods.find(m => m.name.toLowerCase() === key);
    if (im) instantPayments.push({ id: pa._id, provider: pa.provider, accountName: pa.accountName, accountNumber: pa.accountNumber, fee: im.fee || 0, min: im.minAmount || 0 });
  });
  res.render('withdraw', { settings, withdrawals, withdrawMethods: settings.withdrawMethods || [], instantMethods, manualPayments, instantPayments, totalPayments: paymentAccounts.length, adminTelegram: ADMIN_TELEGRAM });
});

app.post('/withdraw/request', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const { amount, paymentId } = req.body;
  if (!paymentId) {
    req.session.errorMsg = 'Pilih payment terlebih dahulu.';
    return res.redirect('/withdraw');
  }
  const amt = parseInt(amount);
  if (isNaN(amt) || amt <= 0) {
    req.session.errorMsg = 'Nominal tidak valid.';
    return res.redirect('/withdraw');
  }
  const pa = await PaymentAccount.findOne({ _id: String(paymentId), userId: req.session.userId }).lean();
  if (!pa) {
    req.session.errorMsg = 'Payment tidak ditemukan. Pilih payment yang sudah terdaftar di profil.';
    return res.redirect('/withdraw');
  }
  const accountNumber = pa.accountNumber;
  const selectedMethod = (settings.withdrawMethods || []).find(m => m.name.toLowerCase() === pa.provider.toLowerCase());
  if (!selectedMethod) {
    req.session.errorMsg = 'Metode penarikan tidak valid.';
    return res.redirect('/withdraw');
  }
  if (selectedMethod.min && amt < selectedMethod.min) {
    req.session.errorMsg = `Minimal penarikan untuk ${selectedMethod.name} adalah Rp ${selectedMethod.min.toLocaleString('id-ID')}`;
    return res.redirect('/withdraw');
  }
  const maxAmount = selectedMethod.max || 1000000;
  if (amt > maxAmount) {
    req.session.errorMsg = `Maksimal penarikan untuk ${selectedMethod.name} adalah Rp ${maxAmount.toLocaleString('id-ID')}`;
    return res.redirect('/withdraw');
  }
  const fee = selectedMethod.fee || 0;
  const totalDeduct = amt + fee;
  const updatedUser = await User.findOneAndUpdate(
    { _id: req.session.userId, balance: { $gte: totalDeduct } },
    { $inc: { balance: -totalDeduct } },
    { new: true }
  );
  if (!updatedUser) {
    req.session.errorMsg = 'Saldo tidak cukup (termasuk biaya admin Rp ' + fee.toLocaleString('id-ID') + ')';
    return res.redirect('/withdraw');
  }
  try {
    const ref = 'W' + Date.now().toString(36).toUpperCase();
    const wd = await createWithRetry(Transaction, {
      _id: generateCustomId(startId.withdraw),
      userId: req.session.userId,
      type: 'withdraw',
      amount: amt,
      fee,
      method: selectedMethod.name,
      accountNumber,
      accountName: pa.accountName,
      status: 'pending',
      reference: ref,
      instant: false,
      ...reqMeta.fromReq(req)
    }, 5, () => generateCustomId(startId.withdraw));

    const userAfter = await User.findById(req.session.userId);
    wd.balanceAfter = userAfter.balance;
    await wd.save();

    if (botManager) {
      const user = await User.findById(req.session.userId).lean();
      botManager.notifyWithdrawRequest(wd, user);
    }
    req.session.successMsg = 'Penarikan berhasil diajukan dan sedang diproses.';
  } catch (err) {
    await User.findByIdAndUpdate(req.session.userId, { $inc: { balance: totalDeduct } });
    req.session.errorMsg = 'Gagal memproses penarikan. Silakan coba lagi.';
    console.error(err);
    if (botManager) botManager.notifyError('/withdraw/request', err.message);
  }
  res.redirect('/withdraw');
});

app.post('/withdraw/instant', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const { amount, paymentId } = req.body;
  if (!paymentId || !amount) { req.session.errorMsg = 'Pilih payment dan isi nominal.'; return res.redirect('/withdraw'); }
  const amt = parseInt(amount);
  if (isNaN(amt) || amt <= 0) { req.session.errorMsg = 'Nominal tidak valid.'; return res.redirect('/withdraw'); }
  const pa = await PaymentAccount.findOne({ _id: String(paymentId), userId: req.session.userId }).lean();
  if (!pa) { req.session.errorMsg = 'Payment tidak ditemukan. Pilih payment yang sudah terdaftar di profil.'; return res.redirect('/withdraw'); }
  const destination = pa.accountNumber;

  const usingXendit = settings.paymentGateway === 'xendit';
  if (settings.withdrawHolidayManualOnly && isWithdrawHoliday(settings)) {
    req.session.errorMsg = 'Hari ini libur penarikan otomatis. Silakan gunakan penarikan manual.';
    return res.redirect('/withdraw');
  }

  const method = (settings.instantWithdrawMethods || []).find(m => m.name.toLowerCase() === pa.provider.toLowerCase() && m.active);
  if (!method) { req.session.errorMsg = 'Metode withdraw instan untuk payment ini tidak tersedia.'; return res.redirect('/withdraw'); }
  if (amt < method.minAmount) { 
    req.session.errorMsg = `Minimal penarikan instan ${method.name} adalah Rp ${method.minAmount.toLocaleString('id-ID')}`; 
    return res.redirect('/withdraw'); 
  }
  const maxInstant = method.maxAmount || 1000000;
  if (amt > maxInstant) {
    req.session.errorMsg = `Maksimal penarikan instan ${method.name} adalah Rp ${maxInstant.toLocaleString('id-ID')}`;
    return res.redirect('/withdraw');
  }
  const fee = method.fee || 0;
  const totalDeduct = amt + fee;
  if (usingXendit) {
    if (!settings.xenditSecretKey) { req.session.errorMsg = 'Fitur withdraw instan Xendit belum dikonfigurasi oleh admin.'; return res.redirect('/withdraw'); }
  } else if (!settings.h2hIdMerchant || !settings.h2hPin || !settings.h2hPassword) {
    req.session.errorMsg = 'Fitur withdraw instan belum dikonfigurasi oleh admin.'; return res.redirect('/withdraw');
  }
  const updatedUser = await User.findOneAndUpdate(
    { _id: req.session.userId, balance: { $gte: totalDeduct } },
    { $inc: { balance: -totalDeduct } },
    { new: true }
  );
  if (!updatedUser) { req.session.errorMsg = 'Saldo tidak cukup (termasuk biaya admin Rp ' + fee.toLocaleString('id-ID') + ')'; return res.redirect('/withdraw'); }
  const ref = 'W' + Date.now().toString(36).toUpperCase();
  try {
    if (usingXendit) {
      await createXenditPayout(ref, amt, method.code, destination, settings);
    } else {
      const h2hUrl = `https://h2h.okeconnect.com/trx?memberID=${settings.h2hIdMerchant}&product=${method.code}&dest=${destination}&qty=${amt}&refID=${ref}&pin=${settings.h2hPin}&password=${settings.h2hPassword}`;
      await axios.get(h2hUrl, { timeout: 15000 });
    }
    const wd = await createWithRetry(Transaction, {
      _id: generateCustomId(startId.withdraw),
      userId: req.session.userId,
      type: 'withdraw',
      amount: amt,
      fee,
      method: method.name,
      methodCode: method.code,
      accountNumber: destination,
      accountName: pa.accountName,
      instant: true,
      destination,
      h2hRefId: ref,
      gateway: settings.paymentGateway,
      status: 'pending',
      ...reqMeta.fromReq(req)
    }, 5, () => generateCustomId(startId.withdraw));

    const userAfter = await User.findById(req.session.userId);
    wd.balanceAfter = userAfter.balance;
    await wd.save();

    req.session.successMsg = 'Permintaan withdraw instan sedang diproses. Silakan cek status secara berkala.';
  } catch (err) {
    await User.findByIdAndUpdate(req.session.userId, { $inc: { balance: totalDeduct } });
    console.error('Withdraw instan request error:', err.response?.data || err.message);
    req.session.errorMsg = 'Gagal mengirim permintaan withdraw instan. Saldo dikembalikan.';
    if (botManager) botManager.notifyError('/withdraw/instant (request)', err.response?.data?.message || err.message);
  }
  res.redirect('/withdraw');
});

// ================== INSTANT WITHDRAW CHECKER ==================
async function checkXenditPayoutStatus(wd, settings) {
  const { data } = await xenditClient(settings).get(`/v3/payouts?reference_id=${encodeURIComponent(wd.h2hRefId)}`);
  const payout = Array.isArray(data?.data) ? data.data[0] : null;
  return payout?.status || null;
}

let lastH2hLowBalanceNotifAt = 0;
function notifyH2hLowBalance(detail) {
  // Throttle 30 menit supaya owner tidak dispam tiap siklus pengecekan.
  if (!botManager || Date.now() - lastH2hLowBalanceNotifAt < 30 * 60 * 1000) return;
  lastH2hLowBalanceNotifAt = Date.now();
  botManager.notifyError('H2H Orderkuota', 'Saldo Orderkuota tidak cukup. Silakan isi saldo dulu di Orderkuota agar pengguna dapat withdraw instan. (' + detail + ')');
}

async function checkInstantWithdrawals() {
  try {
    const settings = await getSettings();

    if (settings.xenditSecretKey) {
      const pendingXendit = await Transaction.find({ type: 'withdraw', instant: true, status: 'pending', gateway: 'xendit' });
      for (const wd of pendingXendit) {
        try {
          const status = await checkXenditPayoutStatus(wd, settings);
          if (status === 'SUCCEEDED') await succeedInstantWithdrawal(wd, 'Berhasil dikirim via Xendit');
          else if (status === 'FAILED') await rejectInstantWithdrawal(wd, 'Payout Xendit gagal', status);
        } catch (err) {
          console.error('Cek payout Xendit error:', err.response?.data || err.message);
          if (botManager) botManager.notifyError('checkInstantWithdrawals (xendit)', err.response?.data?.message || err.message);
        }
      }
    }

    if (!settings.h2hIdMerchant) return;

    const pendingInstants = await Transaction.find({
      type: 'withdraw',
      instant: true,
      status: 'pending',
      gateway: { $ne: 'xendit' }
    });

    for (const wd of pendingInstants) {
      const h2hUrl = `https://h2h.okeconnect.com/trx?memberID=${settings.h2hIdMerchant}&product=${wd.methodCode}&dest=${wd.destination}&qty=${wd.amount}&refID=${wd.h2hRefId}&pin=${settings.h2hPin}&password=${settings.h2hPassword}&check=1`;

      try {
        const response = await axios.get(h2hUrl, { timeout: 15000 });

const responseText = (
  typeof response.data === "string"
    ? response.data
    : JSON.stringify(response.data)
).toLowerCase();

if (responseText.includes("status sukses") || responseText == "ok") {
  await succeedInstantWithdrawal(wd, "Berhasil Dikirim");
  continue;
}
if (responseText.includes("saldo kamu kurang")) notifyH2hLowBalance(responseText);
if (responseText.includes("saldo kamu kurang") || responseText.includes("gagal. ip tidak sesuai") || responseText.includes("tidak ada transaksi tujuan")) {
  await rejectInstantWithdrawal(wd, "Terjadi kesalahan sistem", responseText);
  console.log(`Err WD: ${responseText}`)
  continue;
}
if (responseText.includes("nomor hp tidak benar")) {
  await rejectInstantWithdrawal(wd, "Nomor ewallet tidak valid");
  continue;
}
console.log(`Log WD: ${responseText}`)
continue;

      } catch (err) {
        console.error(`Cek status WD instan ${wd._id} gagal:`, err.message);
      }
    }
  } catch (err) {
    console.error("checkInstantWithdrawals error:", err);
    if (botManager) {
      botManager.notifyError("checkInstantWithdrawals", err.message);
    }
  }
}

async function succeedInstantWithdrawal(wd, responseText) {
  wd.status = 'success'; wd.completedAt = new Date(); wd.h2hResponse = responseText; await wd.save();
  if (botManager) {
    const user = await User.findById(wd.userId).lean();
    botManager.notifyInstantWithdraw(wd, user);
  }
}
async function rejectInstantWithdrawal(wd, reason, err) {
  wd.status = 'rejected'; wd.adminNote = reason; wd.completedAt = new Date();
  await User.findByIdAndUpdate(wd.userId, { $inc: { balance: wd.amount + wd.fee } });
  const userAfter = await User.findById(wd.userId);
  wd.balanceAfter = userAfter.balance;
  await wd.save();
  if (botManager) {
    const user = await User.findById(wd.userId).lean();
    botManager.notifyInstantWithdraw(wd, user, true, err);
  }
}

// ================== MUTASI CHECKER ==================
let checkerInterval;

const providerGateways = ['pakasir', 'xendit', 'midtrans', 'casaku', 'klikqris', 'agw'];
const providerCheckers = { pakasir: checkPakasirStatus, xendit: checkXenditStatus, midtrans: checkMidtransStatus, casaku: checkCasakuStatus, klikqris: checkKlikqrisStatus, agw: checkAgwStatus };
const providerLastCheck = new Map();

async function markDepositPaid(dep, settings, extra = {}, fromStatuses = ['pending']) {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: dep._id, type: 'deposit', status: { $in: fromStatuses } },
    { status: 'paid', completedAt: new Date(), ...extra },
    { new: true }
  );
  if (!claimed) return null;
  await creditDepositAmount(claimed, settings);
  if (botManager) {
    const fresh = await Transaction.findById(claimed._id).lean();
    const user = await User.findById(claimed.userId).lean();
    if (user) botManager.notifyDeposit(fresh || claimed, user);
  }
  return claimed;
}

async function verifyProviderDeposit(dep, settings) {
  const checker = providerCheckers[dep.gateway];
  if (!checker || dep.status !== 'pending') return false;
  const paid = await checker(dep, settings);
  if (!paid) return false;
  return !!(await markDepositPaid(dep, settings));
}

async function checkMutasi() {
  try {
    const settings = await getSettings();
    const now = new Date();
    await checkInstantWithdrawals();

    await Transaction.updateMany(
      { type: 'deposit', status: 'pending', expiredAt: { $lt: now } },
      { status: 'expired' }
    );

    await Transaction.deleteMany({
      type: 'deposit',
      status: 'expired',
      expiredAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) }
    });

    const pendingDeposits = await Transaction.find({ type: 'deposit', status: 'pending' }).lean();
    const legacyDeposits = pendingDeposits.filter(d => !providerGateways.includes(d.gateway));
    const providerDeposits = pendingDeposits.filter(d => providerGateways.includes(d.gateway));
    const expiredMinutes = settings.qrisExpiredMinutes || 30;

    const runLegacyMutasi = async () => {
    { // Legacy mutasi: GoPay Merchant
      if (!settings.gopayToken) return;
      const gopayBase = settings.gopayDomain || 'gomerch.vercel.app';
      const apiUrl = `https://${gopayBase}/api/history?token=${encodeURIComponent(settings.gopayToken)}`;
      try {
        const data = await callGopayApiWithRetry(apiUrl);
        if (!data.success || !Array.isArray(data.data)) return;
        const mutations = data.data.filter(tx => tx.status === 'success');
        const usedMutationIds = await Transaction.find({ type: 'deposit', mutationId: { $ne: null } }).distinct('mutationId');
        const availableMutations = mutations.filter(tx => !usedMutationIds.includes(String(tx.id)));
        for (const dep of legacyDeposits) {
          const match = availableMutations.find(tx => {
            if (tx.amount !== dep.total) return false;
            const txTime = new Date(tx.time);
            if (isNaN(txTime.getTime())) return false;
            const diffMinutes = Math.abs(txTime.getTime() - dep.createdAt.getTime()) / 1000 / 60;
            return diffMinutes <= expiredMinutes;
          });
          if (!match) continue;
          await Transaction.findByIdAndUpdate(dep._id, { status: 'paid', mutationId: String(match.id), completedAt: new Date() });
          await creditDepositAmount(dep, settings);
          if (botManager) { const user = await User.findById(dep.userId).lean(); if (user) botManager.notifyDeposit(dep, user); }
          const idx = availableMutations.findIndex(tx => String(tx.id) === String(match.id));
          if (idx !== -1) availableMutations.splice(idx, 1);
        }
      } catch (err) { console.error('Mutasi error:', err.response?.data || err.message); if (botManager) botManager.notifyError('checkMutasi', err.response?.data?.error || err.message); }
    }
    };
    if (legacyDeposits.length > 0) await runLegacyMutasi();

    for (const dep of providerDeposits) {
      try {
        await verifyProviderDeposit(dep, settings);
      } catch (err) {
        console.error(`Cek status ${dep.gateway} error:`, err.response?.data || err.message);
        if (botManager) botManager.notifyError(`checkMutasi (${dep.gateway})`, err.response?.data?.message || err.message);
      }
    }
  } catch (err) { console.error('Mutasi error:', err.response?.data || err.message); if (botManager) botManager.notifyError('checkMutasi global', err.message); }
}

async function updateStatsOnStartup() {
  const [depositAgg, withdrawAgg, totalUsers, totalTrx, balanceAgg] = await Promise.all([
    Transaction.aggregate([{ $match: { type: 'deposit', status: 'paid' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    Transaction.aggregate([{ $match: { type: 'withdraw', status: 'success' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    User.countDocuments({ role: 'user' }),
    Transaction.countDocuments(),
    User.aggregate([{ $match: { role: 'user' } }, { $group: { _id: null, totalBalance: { $sum: '$balance' } } }])
  ]);
  await Stats.deleteMany({});
  await Stats.create({
    totalDepositAmount: depositAgg[0]?.totalAmount || 0,
    totalDepositFee: depositAgg[0]?.totalFee || 0,
    totalWithdrawAmount: withdrawAgg[0]?.totalAmount || 0,
    totalWithdrawFee: withdrawAgg[0]?.totalFee || 0,
    totalUsers,
    totalTransactions: totalTrx,
    totalUserBalance: balanceAgg[0]?.totalBalance || 0
  });
}

function startChecker() {}
function startPendingBalanceReleaser() {}

// Dipanggil oleh Vercel Cron / pinger eksternal (cron-job.org) tiap 1 menit
app.get('/api/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'CRON_SECRET belum diisi' });
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.key || '');
  if (given !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const out = {};
  for (const [name, fn] of [['mutasi', checkMutasi], ['pending', releasePendingBalances], ['stats', updateStatsOnStartup]]) {
    try { await fn(); out[name] = 'ok'; } catch (e) { out[name] = e.message; }
  }
  res.json({ ok: true, ...out });
});

// ================== PUBLIC PAYMENT PAGE ==================
app.get('/payment/:id', async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id).populate('userId', 'username projectName callbackUrl merchantLogoUrl');
    if (!transaction || transaction.type !== 'deposit') return res.status(404).send('Invoice tidak ditemukan');
    const settings = await getSettings();
    res.render('payment', {
      invoice: transaction,
      settings,
      projectName: transaction.userId?.projectName || '',
      callbackUrl: transaction.userId?.callbackUrl || '',
      merchantLogoUrl: transaction.userId?.merchantLogoUrl || ''
    });
  } catch (err) {
    console.error('Payment page error:', err);
    res.status(500).send('Terjadi kesalahan server');
  }
});

app.get('/payment/status/:id', async (req, res) => {
  try {
    let transaction = await Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
    if (transaction.status === 'pending' && providerGateways.includes(transaction.gateway)) {
      const last = providerLastCheck.get(String(transaction._id)) || 0;
      if (Date.now() - last > 5000) {
        if (providerLastCheck.size > 5000) providerLastCheck.clear();
        providerLastCheck.set(String(transaction._id), Date.now());
        try {
          await verifyProviderDeposit(transaction.toObject(), await getSettings());
          transaction = await Transaction.findById(req.params.id);
        } catch (e) {
          console.error('Payment status check error:', e.response?.data || e.message);
        }
      }
    }
    res.json({ status: transaction.status });
  } catch (err) {
    console.error('Payment status error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server' });
  }
});

async function cancelDepositById(id, ownerId) {
  const filter = { _id: id, type: 'deposit' };
  if (ownerId) filter.userId = ownerId;
  const dep = await Transaction.findOne(filter);
  if (!dep) return { ok: false, code: 404, error: 'Invoice tidak ditemukan' };
  if (dep.status !== 'pending') {
    return { ok: false, code: 400, error: `Invoice berstatus ${dep.status} tidak bisa dibatalkan`, status: dep.status };
  }

  if (providerGateways.includes(dep.gateway)) {
    try {
      const settings = await getSettings();
      const alreadyPaid = await verifyProviderDeposit(dep.toObject(), settings);
      if (alreadyPaid) return { ok: false, code: 400, error: 'Invoice sudah dibayar dan tidak bisa dibatalkan', status: 'paid' };
    } catch (e) {
      console.error('Cek status sebelum batal error:', e.response?.data || e.message);
    }
  }

  const cancelled = await Transaction.findOneAndUpdate(
    { _id: dep._id, type: 'deposit', status: 'pending' },
    { status: 'cancelled', adminNote: 'Dibatalkan dari website' },
    { new: true }
  );
  if (!cancelled) {
    const latest = await Transaction.findById(dep._id).lean();
    return { ok: false, code: 400, error: `Invoice berstatus ${latest?.status || 'tidak diketahui'} tidak bisa dibatalkan`, status: latest?.status };
  }

  providerLastCheck.delete(String(cancelled._id));
  if (cancelled.gateway === 'pakasir') {
    getSettings()
      .then(settings => cancelPakasirTransaction(cancelled, settings))
      .catch(e => console.error('Pakasir cancel error:', e.response?.data || e.message));
  }
  if (cancelled.gateway === 'agw') {
    getSettings()
      .then(settings => cancelAgwInvoice(cancelled, settings))
      .catch(e => console.error('Admin Gateway cancel error:', e.message));
  }
  const owner = await User.findById(cancelled.userId).lean();
  sendWebhook(owner, 'deposit.cancelled', { invoice_id: cancelled._id, amount: cancelled.amount, fee: cancelled.fee, total: cancelled.total, status: 'cancelled' });
  return { ok: true, deposit: cancelled };
}

app.post('/payment/cancel/:id', async (req, res) => {
  try {
    const result = await cancelDepositById(req.params.id, null);
    if (!result.ok) return res.status(result.code).json({ success: false, error: result.error, status: result.status });
    res.json({ success: true, status: 'cancelled' });
  } catch (err) {
    console.error('Payment cancel error:', err);
    res.status(500).json({ success: false, error: 'Terjadi kesalahan server' });
  }
});

app.post('/invoice/cancel/:id', isAuth, async (req, res) => {
  try {
    const result = await cancelDepositById(req.params.id, req.session.userId);
    if (!result.ok) return res.status(result.code).json({ success: false, error: result.error, status: result.status });
    res.json({ success: true, status: 'cancelled' });
  } catch (err) {
    console.error('Invoice cancel error:', err);
    res.status(500).json({ success: false, error: 'Terjadi kesalahan server' });
  }
});


// ================== WEBHOOK ADMIN GATEWAY (AGW) ==================
// Daftarkan https://DOMAINMU/agw/webhook di panel Admin Gateway. Tanda tangan: sha256=HMAC(<timestamp>.<body mentah>), kunci = Webhook Secret.
app.post('/agw/webhook', async (req, res) => {
  try {
    const settings = await getSettings();
    const secret = settings.agwWebhookSecret;
    if (!secret) return res.status(503).json({ success: false, message: 'Webhook secret belum diisi di pengaturan admin' });

    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    const ts = String(req.get('X-AGW-Timestamp') || '');
    const sig = String(req.get('X-AGW-Signature') || '');
    const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
    const sigOk = sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
    if (!sigOk || !raw || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
      return res.status(401).json({ success: false, message: 'Signature tidak valid' });
    }

    const ev = req.body || {};
    if (ev.event === 'webhook.test') return res.json({ success: true, message: 'pong' });
    if (ev.event !== 'invoice.paid') return res.json({ success: true, ignored: true });

    const dep = await Transaction.findOne({ type: 'deposit', gateway: 'agw', trxid: String(ev.invoice_id || '') }).lean();
    if (!dep) return res.json({ success: true, ignored: true }); // tidak dikenal: balas 2xx agar tidak diulang terus
    if (dep.status === 'paid') return res.json({ success: true, duplicate: true });

    if (parseProviderAmount(ev.total_pay) !== Number(dep.total)) {
      console.error('AGW webhook: nominal tidak cocok', ev.invoice_id, ev.total_pay, dep.total);
      if (botManager) botManager.notifyError('/agw/webhook', `Nominal tidak cocok untuk ${ev.invoice_id}: ${ev.total_pay} vs ${dep.total}`);
      return res.json({ success: true, ignored: true });
    }

    // Admin Gateway tetap menganggap lunas jika dibayar <20 menit setelah kedaluwarsa, jadi 'expired' ikut diklaim.
    await markDepositPaid(dep, settings, {}, ['pending', 'expired']);
    return res.json({ success: true });
  } catch (e) {
    console.error('AGW webhook error:', e.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
});

// ================== ADMIN ROUTES ==================
app.post('/admin/stats', isAuth, isAdmin, async (req, res) => {
  const n = (v) => Math.max(0, Math.min(1e13, Math.floor(Number(String(v || '').replace(/[^0-9]/g, '')) || 0)));
  try {
    await Setting.updateOne({}, {
      statsOverrideEnabled: req.body.statsOverrideEnabled === '1',
      statDeposit24h: n(req.body.statDeposit24h),
      statWithdraw24h: n(req.body.statWithdraw24h),
      statTotalUsers: n(req.body.statTotalUsers)
    });
    publicStatsCache = { at: 0, data: null };
    req.session.successMsg = 'Statistik Terkini berhasil diperbarui.';
  } catch (e) { req.session.errorMsg = 'Gagal menyimpan statistik.'; }
  res.redirect('/admin/dashboard');
});

app.get('/admin/dashboard', isAuth, isAdmin, async (req, res) => {
  const stats = await computeStats();
  const withdrawals = await Transaction.find({ type: 'withdraw', instant: false }).populate('userId', 'username email').sort({ createdAt: -1 }).lean();
  res.render('admin_dashboard', { stats, withdrawals });
});

app.get('/admin/users', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  const filter = { role: 'user' };
  if (search) filter.$or = [{ email: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } }];
  const users = await User.find(filter).sort({ balance: -1 }).lean();
  res.render('admin_users', { users, search });
});

app.get('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const targetUser = await User.findById(req.params.id).lean();
  if (!targetUser) return res.status(404).send('Tidak ditemukan');
  res.render('admin_user_edit', { users: targetUser });
});

app.post('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const { username, email, password, balance, suspended, projectName, callbackUrl, merchantLogoUrl } = req.body;

  if (username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) { req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)'; return res.redirect(`/admin/users/${req.params.id}/edit`); }
    if (username.length > 15) { req.session.errorMsg = 'Username maksimal 15 karakter'; return res.redirect(`/admin/users/${req.params.id}/edit`); }
  }

  let finalProjectName = '';
  if (projectName !== undefined) {
    let trimmed = projectName.trim();
    if (trimmed.length > 25) trimmed = trimmed.substring(0, 25);
    finalProjectName = trimmed;
  }

  let finalCallbackUrl = '';
  if (callbackUrl !== undefined) {
    const trimmedUrl = callbackUrl.trim();
    if (trimmedUrl === '') {
      finalCallbackUrl = '';
    } else {
      try {
        const parsed = new URL(trimmedUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
        finalCallbackUrl = trimmedUrl;
      } catch (err) {
        req.session.errorMsg = 'Callback URL tidak valid. Gunakan URL lengkap (https://...).';
        return res.redirect(`/admin/users/${req.params.id}/edit`);
      }
    }
  }

  let finalMerchantLogoUrl = '';
  if (merchantLogoUrl !== undefined) {
    const trimmedLogo = merchantLogoUrl.trim();
    if (trimmedLogo === '') {
      finalMerchantLogoUrl = '';
    } else {
      try {
        new URL(trimmedLogo);
        finalMerchantLogoUrl = trimmedLogo;
      } catch (err) {
        req.session.errorMsg = 'URL Logo tidak valid. Gunakan URL lengkap (https://...).';
        return res.redirect(`/admin/users/${req.params.id}/edit`);
      }
    }
  }

  const upd = {
    username: username?.toLowerCase(),
    email,
    balance: parseInt(balance) || 0,
    suspended: suspended === 'on',
    projectName: finalProjectName,
    callbackUrl: finalCallbackUrl,
    merchantLogoUrl: finalMerchantLogoUrl
  };
  if (!upd.username) delete upd.username;
  if (password && password.trim()) upd.password = hashPassword(password);
  try {
    await User.findByIdAndUpdate(req.params.id, upd, { runValidators: true });
    req.session.successMsg = 'Data pengguna berhasil diperbarui';
    res.redirect('/admin/users');
  } catch (err) {
    if (err.code === 11000) req.session.errorMsg = 'Username atau email sudah digunakan oleh pengguna lain';
    else if (err.name === 'ValidationError') req.session.errorMsg = Object.values(err.errors).map(e => e.message).join(', ');
    else req.session.errorMsg = 'Gagal memperbarui data pengguna';
    if (botManager) botManager.notifyError('/admin/users/edit', err.message);
    res.redirect(`/admin/users/${req.params.id}/edit`);
  }
});

app.post('/admin/users/:id/delete', isAuth, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const userToDelete = await User.findById(userId);
    if (!userToDelete) { req.session.errorMsg = 'User tidak ditemukan.'; return res.redirect('/admin/users'); }
    if (userToDelete.role === 'admin') { req.session.errorMsg = 'Tidak dapat menghapus akun admin.'; return res.redirect('/admin/users'); }
    await Transaction.deleteMany({ userId });
    await ApiKey.deleteMany({ userId });
    const proofs = await PaymentRequest.find({ userId }).select('screenshot').lean();
    FileBlob.deleteMany({ _id: { $in: proofs.map(r => String(r.screenshot)) } }).catch(() => {});
    await PaymentRequest.deleteMany({ userId });
    await PaymentAccount.deleteMany({ userId });
    await User.findByIdAndDelete(userId);
    req.session.successMsg = 'User berhasil dihapus beserta seluruh data terkait.';
    res.redirect('/admin/users');
  } catch (err) { console.error(err); if (botManager) botManager.notifyError('/admin/users/delete', err.message); req.session.errorMsg = 'Gagal menghapus user.'; res.redirect('/admin/users'); }
});

app.post('/admin/transactions/:id/edit', isAuth, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, error: 'Status baru diperlukan.' });

    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.type !== 'deposit')
      return res.status(404).json({ success: false, error: 'Transaksi deposit tidak ditemukan.' });

    const prevStatus = transaction.status;
    const allowedMap = {
      pending: ['paid', 'expired'],
      paid: ['expired'],
      expired: ['paid']
    };
    const allowedStatuses = allowedMap[prevStatus] || [];
    if (!allowedStatuses.includes(status))
      return res.status(400).json({ success: false, error: 'Perubahan status tidak diizinkan.' });

    const userId = transaction.userId;
    const amount = transaction.amount;
    if (status === 'paid') {
      if (prevStatus !== 'paid') {
        await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
        const userAfter = await User.findById(userId);
        transaction.balanceAfter = userAfter.balance;
      }
      transaction.completedAt = new Date();
    } else if (status === 'expired') {
      if (prevStatus === 'paid') {
        await User.findByIdAndUpdate(userId, { $inc: { balance: -amount } });
        const userAfter = await User.findById(userId);
        transaction.balanceAfter = userAfter.balance;
      }
    }

    transaction.status = status;
    await transaction.save();
    if (status === 'paid' && botManager) {
      const user = await User.findById(userId).lean();
      if (user) {
        await botManager.notifyDeposit(transaction, user);
      }
    }

    return res.json({ success: true, message: `Status berhasil diubah menjadi ${status}.` });
  } catch (err) {
    console.error('Edit deposit status error:', err);
    if (botManager) botManager.notifyError('/admin/transactions/edit', err.message);
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan server.' });
  }
});

app.get('/admin/withdraw', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let filter = { type: 'withdraw', instant: false };
  if (search) {
    const users = await User.find({ $or: [{ email: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } }] }).select('_id');
    filter.userId = { $in: users.map(u => u._id) };
  }
  const withdrawals = await Transaction.find(filter).populate('userId', 'username email').sort({ createdAt: -1 }).lean();
  res.render('admin_withdraw', { withdrawals, search });
});

app.post('/admin/withdraw/success/:id', isAuth, isAdmin, async (req, res) => {
  const trx = await Transaction.findOne({ _id: req.params.id, type: 'withdraw' });
  if (trx && trx.status === 'pending' && !trx.instant) {
    trx.status = 'success'; trx.completedAt = new Date(); await trx.save();
    req.session.successMsg = 'Penarikan berhasil disetujui.';
    if (botManager) {
      const user = await User.findById(trx.userId).lean();
      if (user) {
        botManager.notifyWithdrawSuccessToChannel(trx, user);
        sendWebhook(user, 'withdraw.success', { withdraw_id: trx._id, amount: trx.amount, fee: trx.fee, method: trx.method, account_number: trx.accountNumber, status: 'success', balance_after: trx.balanceAfter || user.balance });
      }
    }
  }
  res.redirect('/admin/withdraw');
});

app.post('/admin/withdraw/reject/:id', isAuth, isAdmin, async (req, res) => {
  const trx = await Transaction.findOne({ _id: req.params.id, type: 'withdraw' });
  if (trx && trx.status === 'pending' && !trx.instant) {
    trx.status = 'rejected'; trx.adminNote = req.body.note || ''; trx.completedAt = new Date();
    await User.findByIdAndUpdate(trx.userId, { $inc: { balance: trx.amount + trx.fee } });
    const userAfter = await User.findById(trx.userId);
    trx.balanceAfter = userAfter.balance;
    await trx.save();
    req.session.successMsg = 'Penarikan ditolak dan saldo dikembalikan.';
    const user = await User.findById(trx.userId).lean();
    if (user) sendWebhook(user, 'withdraw.rejected', { withdraw_id: trx._id, amount: trx.amount, fee: trx.fee, method: trx.method, reason: req.body.note || '', status: 'rejected', balance_after: trx.balanceAfter || user.balance });
  }
  res.redirect('/admin/withdraw');
});

app.get('/admin/payments', isAuth, isAdmin, async (req, res) => {
  const pending = await PaymentRequest.find({ status: 'pending' }).populate('userId', 'username email loginIps').sort({ createdAt: 1 }).lean();
  const history = await PaymentRequest.find({ status: { $ne: 'pending' } }).populate('userId', 'username email').sort({ processedAt: -1 }).limit(30).lean();
  pending.forEach(r => {
    const known = ((r.userId && r.userId.loginIps) || []).find(i => i.ip === r.reqIp);
    if (!known) r.ipStatus = 'unknown';
    else r.ipStatus = (new Date(r.createdAt) - new Date(known.firstSeen)) < 48 * 60 * 60 * 1000 ? 'new' : 'known';
  });
  res.render('admin_payments', { pending, history });
});

app.get('/admin/payments/:id/screenshot', isAuth, isAdmin, async (req, res) => {
  const r = await PaymentRequest.findById(req.params.id).select('screenshot').lean();
  if (!r) return res.status(404).send('Tidak ditemukan');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const blob = await FileBlob.findById(path.basename(String(r.screenshot)));
  if (!blob) return res.status(404).send('File tidak ada');
  res.set('Content-Type', blob.mime || 'image/jpeg');
  res.send(toBuf(blob.data));
});

app.post('/admin/payments/:id/approve', isAuth, isAdmin, async (req, res) => {
  try {
    const result = await processPaymentRequest(req.params.id, 'approve');
    if (result.ok) req.session.successMsg = 'Payment disetujui.';
    else req.session.errorMsg = result.message;
  } catch (e) {
    console.error(e);
    if (botManager) botManager.notifyError('/admin/payments/approve', e.message);
    req.session.errorMsg = 'Gagal menyetujui payment.';
  }
  res.redirect('/admin/payments');
});

app.post('/admin/payments/:id/reject', isAuth, isAdmin, async (req, res) => {
  try {
    const result = await processPaymentRequest(req.params.id, 'reject', req.body.note || 'Ditolak admin');
    if (result.ok) req.session.successMsg = 'Permintaan payment ditolak.';
    else req.session.errorMsg = result.message;
  } catch (e) {
    console.error(e);
    if (botManager) botManager.notifyError('/admin/payments/reject', e.message);
    req.session.errorMsg = 'Gagal menolak payment.';
  }
  res.redirect('/admin/payments');
});

app.get('/admin/transactions', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let filter = {};
  if (search) {
    const users = await User.find({ $or: [{ email: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } }] }).select('_id');
    filter = { $or: [{ userId: { $in: users.map(u => u._id) } }, { reference: { $regex: search, $options: 'i' } }] };
  }
  const transactions = await Transaction.find(filter).populate('userId', 'username email').sort({ createdAt: -1 }).lean();
  res.render('admin_transactions', { transactions, search });
});

app.get('/admin/account', isAuth, isAdmin, async (req, res) => {
  const admin = await User.findById(req.session.userId).lean();
  res.render('admin_account', { admin });
});

app.post('/admin/account', isAuth, isAdmin, async (req, res) => {
  const { username, password, newPassword } = req.body;
  const admin = await User.findById(req.session.userId).lean();
  if (!password || !verifyPassword(password, admin.password)) { req.session.errorMsg = 'Password saat ini salah'; return res.redirect('/admin/account'); }
  if (username && username !== admin.username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) { req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)'; return res.redirect('/admin/account'); }
    if (username.length > 15) { req.session.errorMsg = 'Username maksimal 15 karakter'; return res.redirect('/admin/account'); }
    const exist = await User.findOne({ username: username.toLowerCase(), _id: { $ne: admin._id } });
    if (exist) { req.session.errorMsg = 'Username sudah digunakan oleh pengguna lain'; return res.redirect('/admin/account'); }
  }
  try {
    const update = {};
    if (username && username !== admin.username) update.username = username.toLowerCase();
    if (newPassword && newPassword.trim()) update.password = hashPassword(newPassword);
    if (Object.keys(update).length > 0) { await User.findByIdAndUpdate(req.session.userId, update); req.session.successMsg = 'Data akun berhasil diperbarui'; }
    else req.session.errorMsg = 'Tidak ada perubahan yang dilakukan';
  } catch (e) { if (botManager) botManager.notifyError('/admin/account', e.message); req.session.errorMsg = 'Gagal memperbarui akun'; }
  res.redirect('/admin/account');
});

app.post('/admin/settings/withdraw-methods', isAuth, isAdmin, async (req, res) => {
  try {
    const { withdrawMethods } = req.body;
    if (!Array.isArray(withdrawMethods) || withdrawMethods.length === 0) return res.status(400).json({ success: false, error: 'Data tidak valid' });
    const cleaned = withdrawMethods
      .filter(m => m.name && typeof m.name === 'string' && m.name.trim() !== '')
      .map(m => ({
        name: m.name.trim(),
        fee: typeof m.fee === 'number' && !isNaN(m.fee) ? m.fee : 0,
        min: typeof m.min === 'number' && !isNaN(m.min) && m.min > 0 ? m.min : 0,
        max: typeof m.max === 'number' && !isNaN(m.max) && m.max > 0 ? m.max : 1000000
      }));
    if (cleaned.length === 0) return res.status(400).json({ success: false, error: 'Minimal satu metode harus valid' });
    await Setting.updateOne({}, { withdrawMethods: cleaned });
    return res.json({ success: true });
  } catch (err) { console.error(err); if (botManager) botManager.notifyError('/admin/settings/withdraw-methods', err.message); return res.status(500).json({ success: false, error: 'Gagal menyimpan metode withdraw' }); }
});

app.post('/admin/settings/reset', isAuth, isAdmin, async (req, res) => {
  try {
    await User.deleteMany({ role: 'user' });
    await Transaction.deleteMany({});
    await ApiKey.deleteMany({});
    await Stats.deleteMany({});
    await Stats.create({ totalDepositAmount: 0, totalDepositFee: 0, totalWithdrawAmount: 0, totalWithdrawFee: 0, totalUsers: 0, totalTransactions: 0, totalUserBalance: 0 });
    req.session.successMsg = 'Database berhasil direset. Semua data pengguna dan transaksi telah dihapus.';
  } catch (error) { console.error('Reset database error:', error); if (botManager) botManager.notifyError('/admin/settings/reset', error.message); req.session.errorMsg = 'Gagal mereset database. Silakan coba lagi.'; }
  res.redirect('/admin/settings');
});

app.post('/admin/settings/toggle-bot', isAuth, isAdmin, async (req, res) => {
  try {
    const settings = await Setting.findOne();
    if (!settings.telegramBotToken || !settings.telegramOwnerId) return res.json({ success: false, error: 'Token Bot atau Owner ID belum diisi.' });
    const newStatus = !settings.telegramBotEnabled;
    settings.telegramBotEnabled = newStatus;
    await settings.save();
    if (botManager) await botManager.updateSettings(settings);
    const botRunning = botManager ? botManager.isRunning() : false;
    return res.json({ success: true, botRunning, message: botRunning ? 'Bot berhasil disambungkan.' : 'Bot berhasil diputuskan.' });
  } catch (err) { console.error('Toggle bot error:', err); if (botManager) botManager.notifyError('/admin/settings/toggle-bot', err.message); return res.json({ success: false, error: 'Gagal mengubah status bot.' }); }
});

app.post('/admin/settings/restart-bot', isAuth, isAdmin, async (req, res) => {
  try {
    if (!botManager) return res.status(500).json({ success: false, message: 'Bot Manager belum diinisialisasi. Harap tunggu beberapa saat.' });
    await botManager.restartBot();
    return res.json({ success: true, message: '✅ Bot Telegram berhasil direstart.' });
  } catch (err) {
    console.error('Gagal restart bot:', err);
    return res.status(500).json({ success: false, message: '❌ Gagal merestart bot: ' + err.message });
  }
});

app.get('/admin/settings', isAuth, isAdmin, async (req, res) => {
  const settings = await getSettings();
  const botStatus = botManager ? (botManager.isRunning() ? 'Running' : 'Stopped') : 'Not initialized';
  res.render('admin_settings', { settings, botStatus });
});

app.post('/admin/settings/instant-withdraw-methods', isAuth, isAdmin, async (req, res) => {
  try {
    const { instantWithdrawMethods } = req.body;
    if (!Array.isArray(instantWithdrawMethods)) return res.status(400).json({ success: false, error: 'Data tidak valid' });
    const cleaned = instantWithdrawMethods.map(m => ({
      name: m.name || '', code: m.code || '', fee: parseInt(m.fee) || 0,
      minAmount: parseInt(m.minAmount) || 10000, maxAmount: parseInt(m.maxAmount) || 1000000,
      active: m.active === true || m.active === 'true' || m.active === 'on'
    })).filter(m => m.name.trim() !== '' && m.code.trim() !== '');
    await Setting.updateOne({}, { instantWithdrawMethods: cleaned });
    return res.json({ success: true });
  } catch (err) { console.error(err); if (botManager) botManager.notifyError('/admin/settings/instant-withdraw-methods', err.message); return res.status(500).json({ success: false, error: 'Gagal menyimpan metode instan' }); }
});

app.post('/admin/settings', isAuth, isAdmin, (req, res, next) => {
  logoUpload.single('logo')(req, res, function(err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') req.session.errorMsg = 'Ukuran file logo maksimal 2MB.';
      else if (err.message) req.session.errorMsg = 'Gagal upload logo: ' + err.message;
      else req.session.errorMsg = 'Gagal upload logo.';
      if (botManager) botManager.notifyError('/admin/settings (logo upload)', err.message);
      return res.redirect('/admin/settings');
    }
    next();
  });
}, async (req, res) => {
  let withdrawMethods = [];
  const raw = req.body.withdrawMethodsJson;
  if (raw) {
    try { withdrawMethods = JSON.parse(raw); if (!Array.isArray(withdrawMethods)) withdrawMethods = []; } catch (e) { withdrawMethods = []; }
  }
  withdrawMethods = withdrawMethods
    .filter(m => m.name && typeof m.name === 'string' && m.name.trim() !== '')
    .map(m => ({
      name: m.name.trim(),
      fee: typeof m.fee === 'number' && !isNaN(m.fee) ? m.fee : 0,
      min: typeof m.min === 'number' && !isNaN(m.min) && m.min > 0 ? m.min : 0,
      max: typeof m.max === 'number' && !isNaN(m.max) && m.max > 0 ? m.max : 1000000
    }));
  if (withdrawMethods.length === 0) withdrawMethods = [
    { name: 'Dana', fee: 1000, min: 10000, max: 1000000 },
    { name: 'GoPay', fee: 2000, min: 10000, max: 1000000 }
  ];

  let instantWithdrawMethods = [];
  const instantRaw = req.body.instantWithdrawMethodsJson;
  if (instantRaw) {
    try { instantWithdrawMethods = JSON.parse(instantRaw); if (!Array.isArray(instantWithdrawMethods)) instantWithdrawMethods = []; } catch (e) { instantWithdrawMethods = []; }
  }
  instantWithdrawMethods = instantWithdrawMethods.map(m => ({
    name: m.name || '', code: m.code || '', fee: parseInt(m.fee) || 0,
    minAmount: parseInt(m.minAmount) || 10000, maxAmount: parseInt(m.maxAmount) || 1000000,
    active: m.active === true || m.active === 'true' || m.active === 'on'
  })).filter(m => m.name.trim() !== '' && m.code.trim() !== '');
  if (instantWithdrawMethods.length === 0) instantWithdrawMethods = [
    { name: 'Dana', code: 'BBSD', fee: 1000, minAmount: 10000, maxAmount: 1000000, active: true },
    { name: 'GoPay', code: 'BBSGOP', fee: 2000, minAmount: 10000, maxAmount: 1000000, active: true }
  ];

  let withdrawHolidayDays = [];
  const holidayRaw = req.body.withdrawHolidayDays;
  if (holidayRaw) {
    const arr = Array.isArray(holidayRaw) ? holidayRaw : [holidayRaw];
    withdrawHolidayDays = arr.map(d => parseInt(d)).filter(d => !isNaN(d) && d >= 0 && d <= 6);
  }

  const parseNumber = (val, def) => { const n = parseInt(val); return isNaN(n) ? def : n; };
  const {
    name, title, description, channelInformation, contactDeveloper, minDeposit, minWithdraw, maxFee, minFee,
    checkInterval, smtpUser, smtpPass, qrisExpiredMinutes,
    gopayDomain, gopayToken, gopayStaticQr, gopayRefreshToken,
    paymentGateway,
    pakasirSlug, pakasirApiKey, xenditSecretKey, midtransServerKey, midtransClientKey, midtransProduction,
    casakuLicenseKey, casakuQrId, casakuPackageIds, casakuPrefix, klikqrisApiKey, klikqrisMerchantId, klikqrisCallbackUrl,
    agwBaseUrl, agwApiKey, agwApiSecret, agwWebhookSecret,
    pendingBalanceEnabled, pendingBalanceCutoffHour, pendingBalanceReleaseHour, withdrawHolidayManualOnly,
    telegramBotToken, telegramOwnerId, telegramChannelId, telegramBotEnabled,
    h2hIdMerchant, h2hPin, h2hPassword,
    socialPopupEnabled, socialWhatsappUrl, socialYoutubeUrl, socialTiktokUrl, socialInstagramUrl
  } = req.body;

  const previousLogoUrl = (res.locals.settings && res.locals.settings.logoUrl) || req.body.existingLogoUrl || '';
  let logoUrl = previousLogoUrl;
  if (req.file) {
    logoUrl = '/uploads/' + await saveBlob(req.file.buffer, req.file.mimetype, 'logo');
  }

  try {
    await Setting.updateOne({}, {
      name, title, description, channelInformation, contactDeveloper,
      minDeposit: parseNumber(minDeposit, 1000), minWithdraw: parseNumber(minWithdraw, 5000),
      minFee: parseNumber(minFee, 0),
      maxFee: parseNumber(maxFee, 500),
      checkInterval: parseNumber(checkInterval, 30), smtpUser, smtpPass,
      logoUrl, qrisExpiredMinutes: parseNumber(qrisExpiredMinutes, 30),
      withdrawMethods,
      gopayDomain: gopayDomain || 'gomerch.vercel.app', gopayToken: gopayToken || '',
      gopayStaticQr: gopayStaticQr || '', gopayRefreshToken: gopayRefreshToken || '',
      paymentGateway: paymentGateway || 'gopaymerchant',
      pakasirSlug: pakasirSlug || '', pakasirApiKey: pakasirApiKey || '',
      xenditSecretKey: xenditSecretKey || '',
      midtransServerKey: midtransServerKey || '', midtransClientKey: midtransClientKey || '',
      midtransProduction: midtransProduction === 'on' || midtransProduction === true,
      casakuLicenseKey: String(casakuLicenseKey || '').trim(),
      casakuQrId: String(casakuQrId || '').trim(),
      casakuPackageIds: String(casakuPackageIds || 'id.dana').trim(),
      casakuPrefix: String(casakuPrefix || 'CSK').trim().slice(0, 8),
      klikqrisApiKey: String(klikqrisApiKey || '').trim(),
      klikqrisMerchantId: String(klikqrisMerchantId || '').trim(),
      klikqrisCallbackUrl: String(klikqrisCallbackUrl || '').trim(),
      // Kredensial Admin Gateway dipertahankan bila field tidak terkirim (gateway lain sedang aktif)
      agwBaseUrl: agwBaseUrl === undefined ? (res.locals.settings.agwBaseUrl || '') : String(agwBaseUrl).trim(),
      agwApiKey: agwApiKey === undefined ? (res.locals.settings.agwApiKey || '') : String(agwApiKey).trim(),
      agwApiSecret: agwApiSecret === undefined ? (res.locals.settings.agwApiSecret || '') : String(agwApiSecret).trim(),
      agwWebhookSecret: agwWebhookSecret === undefined ? (res.locals.settings.agwWebhookSecret || '') : String(agwWebhookSecret).trim(),
      telegramBotToken: telegramBotToken || '', telegramOwnerId: telegramOwnerId || '',
      telegramChannelId: String(telegramChannelId || '').trim(),
      telegramBotEnabled: telegramBotEnabled === 'on' || telegramBotEnabled === true,
      h2hIdMerchant: h2hIdMerchant || '', h2hPin: h2hPin || '', h2hPassword: h2hPassword || '',
      instantWithdrawMethods,
      pendingBalanceEnabled: pendingBalanceEnabled === 'on' || pendingBalanceEnabled === true,
      pendingBalanceCutoffHour: parseNumber(pendingBalanceCutoffHour, 9),
      pendingBalanceReleaseHour: parseNumber(pendingBalanceReleaseHour, 12),
      withdrawHolidayDays: withdrawHolidayDays.length ? withdrawHolidayDays : [],
      withdrawHolidayManualOnly: withdrawHolidayManualOnly === 'on' || withdrawHolidayManualOnly === true,
      socialPopupEnabled: socialPopupEnabled === 'on' || socialPopupEnabled === true,
      socialWhatsappUrl: cleanSocialUrl(socialWhatsappUrl),
      socialYoutubeUrl: cleanSocialUrl(socialYoutubeUrl),
      socialTiktokUrl: cleanSocialUrl(socialTiktokUrl),
      socialInstagramUrl: cleanSocialUrl(socialInstagramUrl)
    });
    if (req.file && previousLogoUrl.startsWith('/uploads/') && previousLogoUrl !== logoUrl) {
      FileBlob.deleteOne({ _id: path.basename(previousLogoUrl) }).catch(() => {});
    }
    const updatedSettings = await Setting.findOne();
    if (botManager) await botManager.updateSettings(updatedSettings);
    startChecker();
    req.session.successMsg = 'Pengaturan berhasil diperbarui.';
  } catch (err) {
    console.error('Gagal menyimpan pengaturan:', err);
    if (botManager) botManager.notifyError('/admin/settings (save)', err.message);
    req.session.errorMsg = 'Gagal menyimpan pengaturan.';
  }
  res.redirect('/admin/settings');
});

// ================== PUBLIC API / DOCS ==================
app.get('/docs', async (req, res) => {
  let userApiKey = '';
  if (req.session.userId) { const key = await ApiKey.findOne({ userId: req.session.userId }); if (key) userApiKey = key.key; }
  res.render('docs', { userApiKey });
});

app.get('/privacy-policy', async (req, res) => res.render('privacy_policy'));
app.get('/terms-of-service', async (req, res) => res.render('terms_of_service'));

// ================== API AUTH MIDDLEWARE ==================
async function apiAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey;
  if (!apiKey) return res.status(401).json({ error: 'API key diperlukan' });
  const keyDoc = await ApiKey.findOne({ key: apiKey });
  if (!keyDoc) return res.status(401).json({ error: 'API key tidak valid' });
  req.apiUser = keyDoc.userId;
  next();
}

// ================== API ROUTES ==================
app.get('/api/balance', ApiLimiter, apiAuth, async (req, res) => {
  const user = await User.findById(req.apiUser);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ username: user.username, email: user.email, balance: user.balance });
});

app.get('/api/invoice', ApiLimiter, apiAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const amount = parseInt(req.query.amount);
    if (isNaN(amount) || amount < settings.minDeposit || amount > 1_000_000) {
      const message = isNaN(amount)
        ? 'Jumlah deposit tidak valid'
        : amount < settings.minDeposit
          ? `Minimal deposit Rp ${settings.minDeposit.toLocaleString('id-ID')}`
          : 'Maksimal deposit Rp 1.000.000';
      return res.status(400).json({ error: message });
    }
    const deposit = await createDepositTransaction(req.apiUser, amount, settings, reqMeta.fromReq(req));
    const user = await User.findById(req.apiUser).lean();
    const payment_link = `${req.protocol}://${req.get('host')}/payment/${deposit._id}`;
    return res.json({
      success: true,
      invoice_id: deposit._id,
      amount: deposit.amount,
      fee: deposit.fee,
      total: deposit.total,
      qris_image: deposit.qris_image,
      payment_link,
      expired_at: deposit.expiredAt,
      callback_url: user.callbackUrl || ''
    });
  } catch (e) { console.error('API create invoice error:', e.message); if (botManager) botManager.notifyError('/api/invoice', e.message); return res.status(400).json({ error: e.message }); }
});

app.get('/api/invoice/status', ApiLimiter, apiAuth, async (req, res) => {
  const invoiceId = req.query.id || req.query.invoice_id;
  if (!invoiceId) return res.status(400).json({ error: 'Invoice ID diperlukan' });
  const deposit = await Transaction.findOne({ _id: invoiceId, type: 'deposit' });
  if (!deposit || deposit.userId.toString() !== req.apiUser.toString()) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
  const payment_link = `${req.protocol}://${req.get('host')}/payment/${deposit._id}`;

  const response = {
    invoice_id: deposit._id,
    amount: deposit.amount,
    fee: deposit.fee,
    total: deposit.total,
    status: deposit.status,
    qris_image: deposit.qris_image,
    payment_link,
    expired_at: deposit.expiredAt,
    created_at: deposit.createdAt
  };

  if (deposit.status === 'paid' || deposit.status === 'success') {
    response.balance_after = deposit.balanceAfter || null;
    response.completed_at = deposit.completedAt;
  }

  res.json(response);
});

async function apiCancelInvoice(req, res) {
  try {
    const invoiceId = req.query.id || req.query.invoice_id || req.body?.id || req.body?.invoice_id;
    if (!invoiceId) return res.status(400).json({ success: false, error: 'Invoice ID diperlukan' });
    const result = await cancelDepositById(String(invoiceId), req.apiUser);
    if (!result.ok) return res.status(result.code).json({ success: false, error: result.error, status: result.status });
    return res.json({
      success: true,
      invoice_id: result.deposit._id,
      amount: result.deposit.amount,
      fee: result.deposit.fee,
      total: result.deposit.total,
      status: 'cancelled'
    });
  } catch (e) {
    console.error('API cancel invoice error:', e.message);
    if (botManager) botManager.notifyError('/api/invoice/cancel', e.message);
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan server' });
  }
}

app.get('/api/invoice/cancel', ApiLimiter, apiAuth, apiCancelInvoice);
app.post('/api/invoice/cancel', ApiLimiter, apiAuth, apiCancelInvoice);

// ================== API WITHDRAW ENDPOINTS ==================
app.get('/api/withdraw/methods', ApiLimiter, apiAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const manual = (settings.withdrawMethods || []).map(m => ({
      name: m.name,
      method: m.name.toLowerCase(),
      fee: m.fee,
      min: m.min,
      max: m.max || 1000000
    }));
    const instant = getInstantWithdrawMethods(settings)
      .map(m => ({
        name: m.name,
        method: m.name.toLowerCase(),
        fee: m.fee,
        min: m.minAmount,
        max: m.maxAmount || 1000000
      }));
    res.json({ manual_methods: manual, instant_methods: instant });
  } catch (e) {
    console.error(e);
    if (botManager) botManager.notifyError('/api/withdraw/methods', e.message);
    res.status(500).json({ error: 'Gagal memuat metode withdraw' });
  }
});

app.get('/api/withdraw/payments', ApiLimiter, apiAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const list = await PaymentAccount.find({ userId: req.apiUser }).sort({ createdAt: 1 }).lean();
    const instantAvailable = getInstantWithdrawMethods(settings);
    const payments = list.map(pa => {
      const key = pa.provider.toLowerCase();
      const mm = (settings.withdrawMethods || []).find(m => m.name.toLowerCase() === key);
      const im = instantAvailable.find(m => m.name.toLowerCase() === key);
      return {
        id: pa._id,
        provider: pa.provider,
        account_name: pa.accountName,
        account_number: pa.accountNumber,
        manual: mm ? { available: true, fee: mm.fee || 0, min: mm.min || 0, max: mm.max || 1000000 } : { available: false },
        instant: im ? { available: true, fee: im.fee || 0, min: im.minAmount || 0, max: im.maxAmount || 1000000 } : { available: false }
      };
    });
    res.json({ success: true, total: payments.length, payments });
  } catch (e) {
    console.error(e);
    if (botManager) botManager.notifyError('/api/withdraw/payments', e.message);
    res.status(500).json({ error: 'Gagal memuat daftar payment' });
  }
});

app.get('/api/withdraw', ApiLimiter, apiAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const { amount, payment_id, instant } = req.query;

    if (!amount || !payment_id) return res.status(400).json({ error: 'amount dan payment_id diperlukan' });

    const amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount tidak valid' });

    const isInstant = instant == true || instant == 'true';
    const userId = req.apiUser;

    const pa = await PaymentAccount.findOne({ _id: String(payment_id), userId }).lean();
    if (!pa) return res.status(404).json({ error: 'payment_id tidak ditemukan. Cek daftar payment lewat /api/withdraw/payments' });
    const method = pa.provider;
    const account_number = pa.accountNumber;

    if (isInstant) {
      if (!account_number) return res.status(400).json({ error: 'account_number diperlukan untuk instant withdrawal' });

      if (settings.withdrawHolidayManualOnly && isWithdrawHoliday(settings)) {
        return res.status(400).json({ error: 'Hari ini libur penarikan otomatis. Gunakan penarikan manual.' });
      }

      const usingXendit = settings.paymentGateway === 'xendit';
      const methodLower = method.toLowerCase();
      const instantMethod = (settings.instantWithdrawMethods || []).find(
        m => m.name.toLowerCase() === methodLower && m.active
      );

      if (!instantMethod) return res.status(400).json({ error: 'Metode instant withdrawal tidak tersedia atau tidak aktif' });
      if (amt < instantMethod.minAmount) return res.status(400).json({ error: `Minimal penarikan instan ${instantMethod.name} adalah Rp ${instantMethod.minAmount}` });
      const maxInstant = instantMethod.maxAmount || 1000000;
      if (amt > maxInstant) return res.status(400).json({ error: `Maksimal penarikan instan ${instantMethod.name} adalah Rp ${maxInstant}` });

      if (usingXendit) {
        if (!settings.xenditSecretKey) return res.status(400).json({ error: 'Fitur instant withdrawal Xendit belum dikonfigurasi oleh admin.' });
      } else if (!settings.h2hIdMerchant || !settings.h2hPin || !settings.h2hPassword) {
        return res.status(400).json({ error: 'Fitur instant withdrawal belum dikonfigurasi oleh admin.' });
      }

      const fee = instantMethod.fee || 0;
      const totalDeduct = amt + fee;

      const updatedUser = await User.findOneAndUpdate(
        { _id: userId, balance: { $gte: totalDeduct } },
        { $inc: { balance: -totalDeduct } },
        { new: true }
      );

      if (!updatedUser) return res.status(400).json({ error: 'Saldo tidak mencukupi (termasuk biaya admin)' });

      const ref = 'W' + Date.now().toString(36).toUpperCase();

      try {
        if (usingXendit) {
          await createXenditPayout(ref, amt, instantMethod.code, account_number, settings);
        } else {
          const h2hUrl = `https://h2h.okeconnect.com/trx?memberID=${settings.h2hIdMerchant}&product=${instantMethod.code}&dest=${account_number}&qty=${amt}&refID=${ref}&pin=${settings.h2hPin}&password=${settings.h2hPassword}`;
          await axios.get(h2hUrl, { timeout: 15000 });
        }
      } catch (err) {
        await User.findByIdAndUpdate(userId, { $inc: { balance: totalDeduct } });
        console.error('Instant withdraw request error:', err.response?.data || err.message);
        if (botManager) botManager.notifyError('/api/withdraw (instant request)', err.response?.data?.message || err.message);
        return res.status(500).json({ error: 'Gagal memproses permintaan instant withdrawal. Saldo dikembalikan.' });
      }

      const trx = await createWithRetry(Transaction, {
        _id: generateCustomId(startId.withdraw),
        userId,
        type: 'withdraw',
        amount: amt,
        fee,
        method: instantMethod.name,
        methodCode: instantMethod.code,
        accountNumber: account_number,
        accountName: pa.accountName,
        instant: true,
        destination: account_number,
        h2hRefId: ref,
        gateway: settings.paymentGateway,
        status: 'pending',
        ...reqMeta.fromReq(req)
      }, 5, () => generateCustomId(startId.withdraw));

      const userAfter = await User.findById(userId);
      trx.balanceAfter = userAfter.balance;
      await trx.save();

      return res.json({
        success: true,
        message: 'Permintaan withdraw instan sedang diproses.',
        data: {
          id: trx._id,
          amount: trx.amount,
          fee: trx.fee,
          payment_id: pa._id,
          method: trx.method,
          account_name: trx.accountName,
          accountNumber: trx.destination,
          status: trx.status,
          created_at: trx.createdAt,
          balance_after: trx.balanceAfter
        }
      });
    }

    // Manual withdrawal
    if (!account_number) return res.status(400).json({ error: 'account_number diperlukan untuk manual withdrawal' });

    const methodLower = method.toLowerCase();
    const manualMethod = (settings.withdrawMethods || []).find(
      m => m.name.toLowerCase() === methodLower
    );

    if (!manualMethod) return res.status(400).json({ error: 'Metode penarikan manual tidak valid' });

    const minAmount = manualMethod.min || 0;
    if (minAmount > 0 && amt < minAmount) return res.status(400).json({ error: `Minimal penarikan untuk ${manualMethod.name} adalah Rp ${minAmount}` });
    const maxManual = manualMethod.max || 1000000;
    if (maxManual && amt > maxManual) return res.status(400).json({ error: `Maksimal penarikan untuk ${manualMethod.name} adalah Rp ${maxManual}` });

    const fee = manualMethod.fee || 0;
    const totalDeduct = amt + fee;

    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: totalDeduct } },
      { $inc: { balance: -totalDeduct } },
      { new: true }
    );

    if (!updatedUser) return res.status(400).json({ error: 'Saldo tidak mencukupi (termasuk biaya admin)' });

    const ref = 'W' + Date.now().toString(36).toUpperCase();
    const wd = await createWithRetry(Transaction, {
      _id: generateCustomId(startId.withdraw),
      userId,
      type: 'withdraw',
      amount: amt,
      fee,
      method: manualMethod.name,
      accountNumber: account_number,
      accountName: pa.accountName,
      status: 'pending',
      reference: ref,
      instant: false,
      ...reqMeta.fromReq(req)
    }, 5, () => generateCustomId(startId.withdraw));

    const userAfter = await User.findById(userId);
    wd.balanceAfter = userAfter.balance;
    await wd.save();

    if (botManager) {
      const user = await User.findById(userId).lean();
      botManager.notifyWithdrawRequest(wd, user);
    }

    return res.json({
      success: true,
      message: 'Permintaan penarikan berhasil diajukan.',
      data: {
        id: wd._id,
        amount: wd.amount,
        fee: wd.fee,
        payment_id: pa._id,
        method: wd.method,
        account_name: wd.accountName,
        account_number: wd.accountNumber,
        status: wd.status,
        created_at: wd.createdAt,
        balance_after: wd.balanceAfter
      }
    });
  } catch (e) {
    console.error('/api/withdraw error:', e);
    if (botManager) botManager.notifyError('/api/withdraw', e.message);
    return res.status(500).json({ error: 'Terjadi kesalahan internal' });
  }
});

app.get('/api/withdraw/status', ApiLimiter, apiAuth, async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'ID withdraw diperlukan' });

    const withdraw = await Transaction.findOne({
      _id: id,
      type: 'withdraw',
      userId: req.apiUser
    });

    if (!withdraw) return res.status(404).json({ error: 'Data withdraw tidak ditemukan' });

    const response = {
      id: withdraw._id,
      amount: withdraw.amount,
      fee: withdraw.fee,
      method: withdraw.method,
      account_number: withdraw.accountNumber,
      instant: withdraw.instant,
      status: withdraw.status,
      admin_note: withdraw.adminNote,
      created_at: withdraw.createdAt,
      completed_at: withdraw.completedAt
    };

    if (withdraw.status === 'paid' || withdraw.status === 'success') {
      response.balance_after = withdraw.balanceAfter || null;
    }

    res.json(response);
  } catch (e) {
    console.error(e);
    if (botManager) botManager.notifyError('/api/withdraw/status', e.message);
    res.status(500).json({ error: 'Gagal memeriksa status withdraw' });
  }
});

// ================== TELEGRAM WEBHOOK ==================
app.post('/telegram/webhook/:secret', async (req, res) => {
  try {
    if (!botManager || !botManager.bot || !botManager.settings) return res.sendStatus(200);
    if (req.params.secret !== webhookSecret(botManager.settings.telegramBotToken)) return res.sendStatus(403);
    await botManager.bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (e) { console.error('Webhook error:', e.message); res.sendStatus(200); }
});

process.on('unhandledRejection', (reason) => { console.error('⚠️ Unhandled rejection:', reason?.message || reason); });

module.exports = app;
