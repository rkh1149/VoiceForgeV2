import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Never expose server secrets to the client bundle.
  // All OpenAI / GitHub / Vercel API calls happen in server code only.
  reactStrictMode: true,
  // Silence the multiple-lockfiles warning by anchoring the workspace root here.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
