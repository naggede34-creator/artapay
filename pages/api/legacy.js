// Menjalankan seluruh backend lama (pembayaran, withdraw, admin, API, bot) di dalam Next.js.
// Semua URL yang tidak ditangani halaman Next.js diarahkan ke sini lewat rewrites di next.config.js.
import app from '../../legacy/server';

export const config = {
  api: { bodyParser: false, externalResolver: true },
  maxDuration: 60,
};

export default function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const original = u.searchParams.get('__p') || '/';
  u.searchParams.delete('__p');
  const qs = u.searchParams.toString();
  req.url = (original.startsWith('/') ? original : '/' + original) + (qs ? '?' + qs : '');
  // Pakai method bawaan Express (bukan helper Next.js) supaya res.render/redirect/send berperilaku normal
  for (const k of ['status', 'send', 'json', 'redirect']) { try { delete res[k]; } catch (e) {} }
  try { delete req.query; } catch (e) {}
  return app(req, res);
}
