import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CloudSwitch",
  description: "Private dashboard to view status and start/stop two WireGuard VPN VMs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
