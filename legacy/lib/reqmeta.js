const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

const OWNER_ONLY = '\u2063';
const IP_PATTERN = /^[0-9a-f:.]{3,45}$/i;

function cleanIp(raw) {
  let ip = String(raw || '').trim().replace(/%.*$/, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  return IP_PATTERN.test(ip) ? ip : '';
}

function rawIp(req) {
  let raw = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (process.env.BEHIND_CLOUDFLARE === 'true') {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) raw = String(cf).split(',')[0].trim();
  }
  return cleanIp(raw);
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u2063]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function describeDevice(userAgent) {
  const ua = cleanText(userAgent, 300);
  if (!ua) return 'Tidak diketahui';
  let os = '';
  if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/cros/i.test(ua)) os = 'ChromeOS';
  else if (/linux|x11/i.test(ua)) os = 'Linux';
  let client = '';
  if (/telegram/i.test(ua)) client = 'Telegram';
  else if (/edg(e|a|ios)?\//i.test(ua)) client = 'Edge';
  else if (/opr\/|opera/i.test(ua)) client = 'Opera';
  else if (/samsungbrowser/i.test(ua)) client = 'Samsung Browser';
  else if (/firefox|fxios/i.test(ua)) client = 'Firefox';
  else if (/chrome|crios/i.test(ua)) client = 'Chrome';
  else if (/safari/i.test(ua)) client = 'Safari';
  else if (/axios/i.test(ua)) client = 'axios';
  else if (/curl/i.test(ua)) client = 'curl';
  else if (/python/i.test(ua)) client = 'Python';
  else if (/node|undici|got|fetch/i.test(ua)) client = 'Node.js';
  else if (/postman/i.test(ua)) client = 'Postman';
  else if (/okhttp/i.test(ua)) client = 'OkHttp';
  else if (/php|guzzle/i.test(ua)) client = 'PHP';
  const model = ua.match(/;\s*([^;()]+?)\s+Build\//i);
  const parts = [os, client].filter(Boolean);
  let label = parts.join(' • ');
  if (model && os === 'Android') label += ` (${cleanText(model[1], 30)})`;
  return label || cleanText(ua, 60);
}

function fromReq(req) {
  if (!req) return { reqIp: '', reqDevice: '' };
  return { reqIp: rawIp(req), reqDevice: describeDevice(req.headers['user-agent']) };
}

function middleware(req, res, next) {
  store.run(fromReq(req), next);
}

function current() {
  return store.getStore() || { reqIp: '', reqDevice: '' };
}

module.exports = { middleware, current, fromReq, rawIp, describeDevice, cleanText, OWNER_ONLY };
