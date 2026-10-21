const mongoose = require('mongoose');

const envNumber = (key, fallback) => {
  const value = parseInt(process.env[key]);
  return Number.isNaN(value) ? fallback : value;
};

const MINUTE = 60 * 1000;

const CONFIG = {
  windowMs: envNumber('IPGUARD_WINDOW_MS', 10000),
  softLimit: envNumber('IPGUARD_SOFT_LIMIT', 60),
  hardLimit: envNumber('IPGUARD_HARD_LIMIT', 150),
  strikeLimit: 3,
  strikeTtlMs: 10 * MINUTE,
  offenseTtlMs: 7 * 24 * 60 * MINUTE,
  maxTracked: 100000,
  notifyDelayMs: 5000,
  ladder: [15, 60, 360, 1440, 10080].map(m => m * MINUTE)
};

const SUSPICIOUS_PATH = new RegExp(
  '(^|/)(\\.env|\\.git|\\.svn|\\.ds_store|\\.aws|\\.ssh|\\.htaccess|\\.htpasswd|wp-admin|wp-login|wp-content|wp-includes|xmlrpc|phpmyadmin|pma|adminer|cgi-bin|server-status|boaform|actuator|solr|jenkins|vendor/phpunit|etc/passwd|proc/self)' +
  '|\\.(php|asp|aspx|jsp|cgi|sql|bak|old|swp|ini|yml|yaml)(/|$)' +
  '|\\.\\./'
);

const blockedIpSchema = new mongoose.Schema({
  ip: { type: String, unique: true, index: true },
  reason: { type: String, default: '' },
  offenses: { type: Number, default: 0 },
  hits: { type: Number, default: 0 },
  permanent: { type: Boolean, default: false },
  manual: { type: Boolean, default: false },
  blockedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null }
});

const BlockedIP = mongoose.models.BlockedIP || mongoose.model('BlockedIP', blockedIpSchema);

const states = new Map();
const blocked = new Map();
const offenses = new Map();
const trusted = new Map();
const pending = [];
const whitelist = new Set();
let flushTimer = null;
let onBlock = null;

function expandV6(ip) {
  const hasGap = ip.includes('::');
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = hasGap && tail ? tail.split(':') : [];
  const full = hasGap
    ? [...headParts, ...Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0'), ...tailParts]
    : ip.split(':');
  return full.map(part => (parseInt(part || '0', 16) || 0).toString(16));
}

function normalizeIp(raw) {
  const ip = String(raw || '').trim().replace(/%.*$/, '').replace(/\/\d+$/, '');
  if (!ip) return '';
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  return `${expandV6(ip).slice(0, 4).join(':')}::/64`;
}

function isValidKey(key) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(key)) return key.split('.').every(part => Number(part) <= 255);
  return /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::\/64$/.test(key);
}

function getIp(req) {
  let raw = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (process.env.BEHIND_CLOUDFLARE === 'true') {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) raw = String(cf).split(',')[0].trim();
  }
  return normalizeIp(raw);
}

String(process.env.IPGUARD_WHITELIST || '')
  .split(',')
  .map(item => normalizeIp(item))
  .filter(Boolean)
  .forEach(item => whitelist.add(item));

function isTrusted(ip) {
  if (!ip) return true;
  if (whitelist.has(ip)) return true;
  const until = trusted.get(ip);
  if (until && until > Date.now()) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip)) return true;
  const private172 = ip.match(/^172\.(\d+)\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  if (ip.startsWith('0:0:0:0::') || /^fe80:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

function trust(ip, ttlMs = 30 * MINUTE) {
  if (ip) trusted.set(ip, Date.now() + ttlMs);
}

function getState(ip, now) {
  let state = states.get(ip);
  if (state) return state;
  if (states.size >= CONFIG.maxTracked) return null;
  state = { windowStart: now, count: 0, total: 0, flagged: false, strikes: [], lastSeen: now };
  states.set(ip, state);
  return state;
}

function isApiRequest(req) {
  return req.path.startsWith('/api/');
}

function deny(req, res, entry, now) {
  entry.denied = (entry.denied || 0) + 1;
  if (entry.denied > 30 && req.socket) return req.socket.destroy();
  const retry = entry.until === Infinity ? 86400 : Math.max(1, Math.ceil((entry.until - now) / 1000));
  res.set('Retry-After', String(retry));
  if (isApiRequest(req)) return res.status(403).json({ success: false, message: 'IP kamu diblokir sementara karena aktivitas mencurigakan.' });
  return res.status(403).type('text/plain').send('Akses ditolak. IP kamu diblokir sementara karena aktivitas mencurigakan.');
}

function tooMany(req, res) {
  res.set('Retry-After', String(Math.ceil(CONFIG.windowMs / 1000)));
  if (isApiRequest(req)) return res.status(429).json({ success: false, message: 'Terlalu banyak request. Perlambat request kamu.' });
  return res.status(429).type('text/plain').send('Terlalu banyak request. Perlambat request kamu.');
}

function persist(entry) {
  BlockedIP.findOneAndUpdate(
    { ip: entry.ip },
    {
      ip: entry.ip,
      reason: entry.reason,
      offenses: entry.offenses,
      hits: entry.hits,
      permanent: entry.permanent,
      manual: entry.manual,
      blockedAt: new Date(entry.blockedAt),
      expiresAt: entry.permanent ? null : new Date(entry.until)
    },
    { upsert: true }
  ).exec().catch(err => console.error('IPGuard gagal menyimpan blokir:', err.message));
}

async function flush() {
  flushTimer = null;
  const batch = pending.splice(0, pending.length);
  if (!batch.length || !onBlock) return;
  try {
    await onBlock(batch);
  } catch (err) {
    console.error('IPGuard gagal mengirim notifikasi:', err.message);
  }
}

function enqueue(entry) {
  if (pending.length >= 500) pending.shift();
  pending.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flush, CONFIG.notifyDelayMs);
}

function block(ip, reason, options = {}) {
  const now = Date.now();
  const previous = offenses.get(ip);
  const alive = previous && now - previous.at < CONFIG.offenseTtlMs;
  const count = options.manual ? (alive ? previous.count : 0) : (alive ? previous.count + 1 : 1);
  const permanent = Boolean(options.permanent);
  const until = permanent ? Infinity : now + CONFIG.ladder[Math.min(Math.max(count, 1) - 1, CONFIG.ladder.length - 1)];
  const entry = {
    ip,
    reason,
    offenses: count,
    hits: options.hits || 0,
    permanent,
    manual: Boolean(options.manual),
    blockedAt: now,
    until,
    denied: 0
  };
  offenses.set(ip, { count, at: now });
  blocked.set(ip, entry);
  states.delete(ip);
  persist(entry);
  if (!entry.manual) enqueue(entry);
  return entry;
}

function addStrike(ip, weight, reason) {
  if (isTrusted(ip)) return null;
  const now = Date.now();
  if (blocked.has(ip)) return null;
  const state = getState(ip, now);
  if (!state) return null;
  state.strikes = state.strikes.filter(item => now - item.at < CONFIG.strikeTtlMs);
  state.strikes.push({ at: now, weight, reason });
  const total = state.strikes.reduce((sum, item) => sum + item.weight, 0);
  if (total < CONFIG.strikeLimit) return null;
  const reasons = [...new Set(state.strikes.map(item => item.reason))].slice(0, 3).join(' + ');
  return block(ip, reasons, { hits: state.total });
}

function strike(req, weight, reason) {
  const ip = req.clientIp || getIp(req);
  return addStrike(ip, weight, reason);
}

function isSuspiciousPath(req) {
  let target = req.originalUrl.split('?')[0];
  try { target = decodeURIComponent(target); } catch {}
  return SUSPICIOUS_PATH.test(target.toLowerCase());
}

function middleware(req, res, next) {
  const ip = getIp(req);
  req.clientIp = ip;
  if (isTrusted(ip)) return next();
  const now = Date.now();
  const entry = blocked.get(ip);
  if (entry) {
    if (entry.until === Infinity || entry.until > now) return deny(req, res, entry, now);
    blocked.delete(ip);
  }
  const state = getState(ip, now);
  if (!state) return next();
  if (now - state.windowStart >= CONFIG.windowMs) {
    state.windowStart = now;
    state.count = 0;
    state.flagged = false;
  }
  state.count++;
  state.total++;
  state.lastSeen = now;
  if (isSuspiciousPath(req)) {
    const hit = addStrike(ip, 1.5, 'Probing path mencurigakan');
    if (hit) return deny(req, res, hit, now);
  }
  if (state.count > CONFIG.hardLimit) {
    const hit = block(ip, `Flood request (${state.count} req dalam ${Math.round(CONFIG.windowMs / 1000)} detik)`, { hits: state.total });
    return deny(req, res, hit, now);
  }
  if (state.count > CONFIG.softLimit) {
    if (!state.flagged) {
      state.flagged = true;
      const hit = addStrike(ip, 1, `Request berlebihan (lebih dari ${CONFIG.softLimit} req per ${Math.round(CONFIG.windowMs / 1000)} detik)`);
      if (hit) return deny(req, res, hit, now);
    }
    return tooMany(req, res);
  }
  return next();
}

function cleanup() {
  const now = Date.now();
  for (const [ip, state] of states) {
    state.strikes = state.strikes.filter(item => now - item.at < CONFIG.strikeTtlMs);
    if (now - state.lastSeen > CONFIG.windowMs * 2 && state.strikes.length === 0) states.delete(ip);
  }
  for (const [ip, entry] of blocked) {
    if (entry.until !== Infinity && entry.until <= now) blocked.delete(ip);
  }
  for (const [ip, until] of trusted) {
    if (until <= now) trusted.delete(ip);
  }
}

function purge() {
  const cutoff = new Date(Date.now() - CONFIG.offenseTtlMs);
  BlockedIP.deleteMany({ permanent: false, expiresAt: { $lt: cutoff } }).exec()
    .catch(err => console.error('IPGuard gagal membersihkan data lama:', err.message));
}

async function init(options = {}) {
  onBlock = options.onBlock || null;
  try {
    const docs = await BlockedIP.find({}).lean();
    const now = Date.now();
    for (const doc of docs) {
      const blockedAt = new Date(doc.blockedAt).getTime();
      if (now - blockedAt < CONFIG.offenseTtlMs) offenses.set(doc.ip, { count: doc.offenses, at: blockedAt });
      const until = doc.permanent ? Infinity : (doc.expiresAt ? new Date(doc.expiresAt).getTime() : 0);
      if (until > now) {
        blocked.set(doc.ip, {
          ip: doc.ip,
          reason: doc.reason,
          offenses: doc.offenses,
          hits: doc.hits,
          permanent: doc.permanent,
          manual: doc.manual,
          blockedAt,
          until,
          denied: 0
        });
      }
    }
    console.log(`🛡️ IPGuard aktif, ${blocked.size} IP sedang diblokir`);
  } catch (err) {
    console.error('IPGuard gagal memuat daftar blokir:', err.message);
  }
  setInterval(cleanup, MINUTE).unref();
  setInterval(purge, 6 * 60 * MINUTE).unref();
}

function list() {
  const now = Date.now();
  return [...blocked.values()]
    .filter(entry => entry.until === Infinity || entry.until > now)
    .sort((a, b) => b.blockedAt - a.blockedAt);
}

function blockManual(input, reason) {
  const ip = normalizeIp(input);
  if (!isValidKey(ip)) return null;
  return block(ip, reason || 'Diblokir manual oleh owner', { permanent: true, manual: true });
}

async function unblock(input) {
  const ip = normalizeIp(input);
  if (!ip) return false;
  const existed = blocked.delete(ip);
  states.delete(ip);
  offenses.delete(ip);
  try {
    const result = await BlockedIP.deleteOne({ ip });
    return existed || result.deletedCount > 0;
  } catch (err) {
    console.error('IPGuard gagal menghapus blokir:', err.message);
    return existed;
  }
}

function formatDuration(ms) {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} menit`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} jam`;
  return `${Math.round(hours / 24)} hari`;
}

function durationOf(entry) {
  return entry.permanent ? 'Permanen' : formatDuration(entry.until - entry.blockedAt);
}

function remainingOf(entry) {
  return entry.permanent ? 'Permanen' : formatDuration(Math.max(0, entry.until - Date.now()));
}

module.exports = {
  middleware,
  init,
  strike,
  trust,
  list,
  blockManual,
  unblock,
  normalizeIp,
  getIp,
  durationOf,
  remainingOf
};
