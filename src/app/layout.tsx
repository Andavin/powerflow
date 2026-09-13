import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jbMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Powerflow",
  description:
    "Real-time and historical energy monitoring for your home power panel.",
  applicationName: "Powerflow",
  // Lets iOS run the home-screen save as a standalone web app, which is a
  // prerequisite for push on iPhone.
  appleWebApp: { capable: true, title: "Powerflow", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#050608",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jbMono.variable} h-full antialiased`}
    >
      <body className="bg-bg text-fg min-h-full">{children}</body>
    </html>
  );
}
