import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'cURL Perf Tester',
  description: 'HTTP performance testing via curl commands',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
