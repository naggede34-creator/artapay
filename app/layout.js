import { Barlow_Condensed, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

const display = Barlow_Condensed({ weight: ['600', '700', '800'], subsets: ['latin'], variable: '--f-display' });
const body = Plus_Jakarta_Sans({ weight: ['400', '500', '600', '700'], subsets: ['latin'], variable: '--f-body' });

export const metadata = {
  title: 'ARTA PEDIA PAY – Payment Gateway QRIS',
  description: 'Payment gateway otomatis untuk bisnis digital. Cepat, aman, dan biaya rendah.',
};

export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0A1128' };

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body className={`${display.variable} ${body.variable}`}>{children}</body>
    </html>
  );
}
