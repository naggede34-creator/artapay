/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: [
    'express', 'mongoose', 'ejs', 'axios', 'multer', 'nodemailer', 'telegraf', 'express-rate-limit',
  ],
  outputFileTracingIncludes: {
    '/api/legacy': ['./legacy/**/*'],
  },
  async rewrites() {
    return {
      // Halaman Next.js (mis. "/") diprioritaskan; sisanya (login, dashboard, admin, API, dll) ke backend lama.
      fallback: [{ source: '/:path*', destination: '/api/legacy?__p=/:path*' }],
    };
  },
};
