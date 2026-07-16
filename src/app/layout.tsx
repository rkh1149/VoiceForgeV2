import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "VoiceForge V2",
  description:
    "Describe an app. VoiceForge V2 builds it, tests it, and deploys it.",
  applicationName: "VoiceForge V2",
  appleWebApp: {
    capable: true,
    title: "VoiceForge V2",
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
