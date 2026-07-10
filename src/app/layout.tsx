import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "VoiceForge",
  description: "Describe an app. VoiceForge builds it, tests it, and deploys it.",
  applicationName: "VoiceForge",
  appleWebApp: {
    capable: true,
    title: "VoiceForge",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#4f5dd3",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
