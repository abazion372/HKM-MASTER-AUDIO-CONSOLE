import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HKM Audio System — Church Audio Intelligence & DSP Platform",
  description:
    "Cross-platform church sound engineering, DSP management, acoustic measurement, livestream studio, and evidence-based AI diagnostics platform.",
  keywords: [
    "HKM Audio System",
    "Church Audio Intelligence",
    "live sound",
    "DSP",
    "CamillaDSP",
    "FOH console",
    "audio engineering",
  ],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { type: "image/svg+xml", url: "/favicon.svg" },
      { type: "image/png", sizes: "192x192", url: "/icon-192.png" },
      { type: "image/png", sizes: "512x512", url: "/icon-512.png" },
    ],
    apple: [{ type: "image/png", sizes: "192x192", url: "/companion-icon-192.png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "HKM FOH Companion",
  },
  openGraph: {
    title: "HKM Audio System — Church Audio Intelligence & DSP Platform",
    description:
      "Cross-platform church sound engineering, DSP management, acoustic measurement, livestream studio, and evidence-based AI diagnostics platform.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#080B10",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
