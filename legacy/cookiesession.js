// Session berbasis cookie bertanda tangan (HMAC). Cocok untuk serverless (Vercel) karena tanpa memori server.
const crypto = require('crypto');

module.exports = function cookieSession({ secret, name = 'sid', maxAge = 86400000 }) {
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const parse = (h) => Object.fromEntries(String(h || '').split(/;\s*/).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i), p.slice(i + 1)];
  }));

  return (req, res, next) => {
    let data = {};
    const raw = parse(req.headers.cookie)[name];
    if (raw) {
      const i = raw.lastIndexOf('.');
      const payload = raw.slice(0, i);
      const sig = raw.slice(i + 1);
      if (i > 0 && eq(sig, sign(payload))) {
        try {
          const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
          if (o.exp > Date.now()) data = o.d || {};
        } catch (e) { /* cookie rusak, abaikan */ }
      }
    }
    const initial = JSON.stringify(data);
    let destroyed = false;
    Object.defineProperty(data, 'destroy', { enumerable: false, value: (cb) => { destroyed = true; Object.keys(data).forEach((k) => delete data[k]); if (cb) cb(); } });
    Object.defineProperty(data, 'save', { enumerable: false, value: (cb) => { if (cb) cb(); } });
    req.session = data;

    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!res.headersSent) {
        const now = JSON.stringify(data);
        if (destroyed || now !== initial) {
          const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
          let cookie;
          if (destroyed || Object.keys(data).length === 0) {
            cookie = `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
          } else {
            const p = Buffer.from(JSON.stringify({ d: data, exp: Date.now() + maxAge })).toString('base64url');
            cookie = `${name}=${p}.${sign(p)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${secure}`;
          }
          const prev = res.getHeader('Set-Cookie');
          res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
        }
      }
      return writeHead.apply(this, args);
    };
    next();
  };
};
