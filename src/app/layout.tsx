import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { auth } from "@/auth";
import Nav from "./Nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Sahajta Ads Launcher",
  description: "Launch Meta ads in bulk, paused, from a folder of creatives.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const mock = process.env.META_MOCK === "1";
  const dev = process.env.NODE_ENV === "development" ? process.env.DEV_LOGIN_EMAIL : undefined;
  const email = dev ?? (await auth().catch(() => null))?.user?.email ?? null;
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Nav mock={mock} email={email} />
        <main>{children}</main>
      </body>
    </html>
  );
}
