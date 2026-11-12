import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DigiAnchorZ Voice CRM · Tanglish AI Enquiry Assistant (Nila)',
  description:
    'Supabase Auth & Postgres CRM with Tanglish AI Voice Qualification (Agent Nila) and Google Sheets Sync.',
  icons: {
    icon: '/brand/digianchorz-symbol.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#F7F9F6] text-[#0B1220] antialiased">
        {children}
      </body>
    </html>
  );
}

