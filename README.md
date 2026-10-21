# ARTA PEDIA PAY (Next.js + Vercel)

Payment gateway QRIS dengan tema "Noir Manga": biru, putih, hitam — outline tegas, bayangan 3D halus, elegan dan profesional.

## Deploy ke Vercel
1. Upload folder ini ke GitHub, lalu **Add New Project** di Vercel (Framework: Next.js).
2. Isi Environment Variables (lihat `.env.example`). Wajib: `MONGO_URI`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `CRON_SECRET`.
3. Di MongoDB Atlas, buka Network Access dan izinkan `0.0.0.0/0`.
4. Deploy. Login admin di `/login` memakai `ADMIN_USERNAME` dan `ADMIN_PASSWORD` (dibuat otomatis saat pertama jalan jika belum ada admin).

## Edit angka Statistik Terkini
Login admin, buka **Admin Dashboard**, kartu "Edit Statistik Terkini". Ubah Nominal Transaksi, Pencairan Dana, dan Total Pengguna, lalu simpan.

## Pengecek otomatis (wajib untuk deposit GoPay Merchant, withdraw instan, saldo tertunda)
Vercel Hobby hanya mengizinkan cron 1x sehari. Agar jalan tiap menit, daftar gratis di cron-job.org, lalu buat job tiap 1 menit ke:
`https://DOMAINMU/api/cron?key=ISI_CRON_SECRET`

## Bot Telegram
Isi token dan owner ID di Pengaturan Admin. Bot memakai webhook otomatis (tidak perlu server polling). Perintah `/backup` tidak tersedia di Vercel.

## Catatan teknis
- Session memakai cookie bertanda tangan (bukan memori server).
- Logo dan bukti payment disimpan di MongoDB (disk Vercel tidak permanen).
- Halaman depan adalah React (Next.js); halaman lain dirender oleh backend lama di `legacy/` yang dijalankan di dalam Next.js lewat `pages/api/legacy.js`.

## Provider Deposit: Admin Gateway (SMP Payment)
Pilih **Admin Gateway** di Admin → Settings → Payment Gateway, lalu isi Base URL (`https://domain/api/agw`), API Key, API Secret (opsional, bila HMAC aktif) dan Webhook Secret.
- Deposit user di dashboard dan API developer (`/api/invoice`, `/api/invoice/status`, `/api/invoice/cancel`) otomatis memakai provider yang dipilih; dokumentasi developer tidak berubah.
- Kode unik ditentukan Admin Gateway (`total_pay`), disimpan sebagai fee deposit.
- Daftarkan `https://DOMAINMU/agw/webhook` (event `invoice.paid`) di panel Admin Gateway. Tanpa webhook, status tetap dicek lewat polling (halaman payment tiap 5 detik dan cron tiap menit).
- Provider bisa diganti kapan saja dari menu admin; kredensial Admin Gateway tidak terhapus saat provider lain aktif.
