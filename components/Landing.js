'use client';
import { useEffect, useMemo, useState } from 'react';

const fmt = (n) => String(Math.floor(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const rp = (n) => 'Rp ' + fmt(n);

const DEFAULT = {
  depositAmount24h: 2000,
  withdrawAmount24h: 49000,
  totalUsers: 95,
  site: {
    name: 'ARTA PEDIA PAY',
    title: 'Platform Pembayaran QRIS Super Cepat!',
    description: 'Payment gateway otomatis untuk bisnis digital. Cepat, aman, dan biaya rendah.',
  },
};

/* Ikon garis (SVG) — pengganti emoji */
const P = {
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  percent: <><path d="M19 5 5 19" /><circle cx="7" cy="7" r="2" /><circle cx="17" cy="17" r="2" /></>,
  out: <path d="M7 17 17 7M8 7h9v9" />,
  trend: <path d="m3 17 6-6 4 4 8-8M15 7h6v6" />,
  up: <path d="M12 19V5M5 12l7-7 7 7" />,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M21 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
  book: <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM6.5 17H20v4H6.5a2.5 2.5 0 0 1 0-4z" />,
  check: <path d="m5 12 5 5 9-10" />,
  shield: <><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};
function Icon({ n }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[n]}
    </svg>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true">
      <rect x="18" y="18" width="104" height="104" rx="24" fill="#2563EB" />
      <rect x="6" y="6" width="104" height="104" rx="24" fill="#0A1128" stroke="#fff" strokeWidth="5" />
      <path fill="#fff" fillRule="evenodd" d="M28 92 64 26l36 66H84l-6-12H50l-6 12zM58 66h12l-6-11z" />
    </svg>
  );
}

function Qr() {
  const cells = useMemo(() => {
    const N = 21;
    let s = 11;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const finder = (x, y) => (x < 8 && y < 8) || (x >= 13 && y < 8) || (x < 8 && y >= 13);
    const out = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!finder(x, y) && rnd() > 0.5) out.push([x, y]);
    return out;
  }, []);
  return (
    <svg viewBox="0 0 21 21" shapeRendering="crispEdges" aria-hidden="true">
      {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />)}
      {[[0, 0], [14, 0], [0, 14]].map(([x, y]) => (
        <g key={`f${x}${y}`}>
          <rect x={x} y={y} width="7" height="7" />
          <rect x={x + 1} y={y + 1} width="5" height="5" fill="#fff" />
          <rect x={x + 2} y={y + 2} width="3" height="3" />
        </g>
      ))}
    </svg>
  );
}

const FEATS = [
  ['bolt', 'Pendaftaran Instan', 'Langsung terima pembayaran setelah registrasi tanpa menunggu berhari-hari.'],
  ['code', 'Integrasi Mudah', 'Satu halaman dokumentasi lengkap dan mudah dipahami untuk pemula.'],
  ['percent', 'Biaya Rendah', 'Biaya sangat rendah untuk memaksimalkan keuntungan bisnis kamu.'],
  ['out', 'Penarikan Instan', 'Penarikan diproses cepat dalam hitungan detik tanpa menunggu lama.'],
];

export default function Landing() {
  const [d, setD] = useState(DEFAULT);

  useEffect(() => {
    let off = false;
    const load = async () => {
      try {
        const r = await fetch('/api/public/stats', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!off) setD((p) => ({ ...p, ...j, site: { ...p.site, ...(j.site || {}) } }));
      } catch {}
    };
    load();
    const t = setInterval(load, 20000);
    return () => { off = true; clearInterval(t); };
  }, []);

  const name = (d.site.name || 'ARTA PEDIA PAY').toUpperCase();
  const words = name.split(' ');
  const last = words.length > 1 ? words.pop() : '';
  const first = words.join(' ');

  return (
    <>
      <header className="nav dark">
        <div className="container">
          <a href="/" className="logo disp"><Mark /><span>{name}</span></a>
          <nav className="nav-links">
            <a href="#statistik">Statistik</a>
            <a href="#fitur">Fitur</a>
            <a href="/docs">Panduan API</a>
          </nav>
          <div className="nav-actions">
            <a className="btn ghost sm" href="/login">Masuk</a>
            <a className="btn sm" href="/register">Daftar</a>
          </div>
        </div>
      </header>

      <section className="hero dark">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow"><i /> Payment Gateway QRIS</span>
            <h1 className="disp">{first}{last && <em>{last}</em>}</h1>
            <p className="lead"><strong>{d.site.title}</strong>{d.site.description}</p>
            <div className="cta">
              <a className="btn" href="/register">Mulai Sekarang <Icon n="arrow" /></a>
              <a className="btn light" href="/docs"><Icon n="book" /> Panduan API</a>
            </div>
            <div className="trust">
              <span><Icon n="check" /> Pendaftaran instan</span>
              <span><Icon n="check" /> Penarikan instan</span>
              <span><Icon n="check" /> Biaya rendah</span>
            </div>
          </div>

          <div className="stage" aria-hidden="true">
            <div className="stage-inner">
              <div className="plate" />
              <div className="qcard">
                <div className="qhead"><span>Scan &amp; Bayar</span><b>QRIS</b></div>
                <div className="qr"><Qr /></div>
                <div className="qamt disp">Rp 150.000</div>
                <div className="qsub">Otomatis terverifikasi</div>
              </div>
              <div className="chip"><i><Icon n="check" /></i> Pembayaran berhasil</div>
            </div>
          </div>
        </div>
      </section>

      <main className="container">
        <section className="sec" id="statistik">
          <div className="sec-head">
            <div>
              <span className="kicker">Real-time</span>
              <h2 className="disp">Statistik Terkini</h2>
            </div>
            <span className="live"><span className="dot" /> Live</span>
          </div>
          <div className="stats">
            <div className="panel stat">
              <div className="ico"><Icon n="trend" /></div>
              <small>Nominal Transaksi (24 jam terakhir)</small>
              <div className="val disp">{rp(d.depositAmount24h)}</div>
            </div>
            <div className="panel stat">
              <div className="ico"><Icon n="up" /></div>
              <small>Pencairan Dana (24 jam terakhir)</small>
              <div className="val disp">{rp(d.withdrawAmount24h)}</div>
            </div>
            <div className="panel stat">
              <div className="ico"><Icon n="users" /></div>
              <small>Total Pengguna</small>
              <div className="val disp">{fmt(d.totalUsers)}</div>
            </div>
          </div>
        </section>

        <section className="sec" id="fitur">
          <div className="sec-head">
            <div>
              <span className="kicker">Keunggulan</span>
              <h2 className="disp">Mengapa Pakai {name}?</h2>
            </div>
          </div>
          <div className="feats">
            {FEATS.map(([ico, t, x], i) => (
              <div key={t} className="panel feat">
                <span className="no disp">{String(i + 1).padStart(2, '0')}</span>
                <div className="ico"><Icon n={ico} /></div>
                <h3 className="disp">{t}</h3>
                <p>{x}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <section className="band dark">
        <div className="container">
          <div>
            <h3 className="disp">Siap menerima pembayaran QRIS?</h3>
            <p>Daftar sekarang dan mulai terima pembayaran di bisnis digital kamu.</p>
          </div>
          <a className="btn light" href="/register">Daftar Gratis <Icon n="arrow" /></a>
        </div>
      </section>

      <footer className="foot">
        <div className="container">
          <span>© {new Date().getFullYear()} {name}</span>
          <nav>
            <a href="/privacy-policy">Privasi</a>
            <a href="/terms-of-service">Syarat</a>
            <a href="/docs">Docs</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
