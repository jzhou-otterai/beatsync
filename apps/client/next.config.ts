import type { NextConfig } from "next";

// Static build the Beatsync Speaker desktop app serves from its bundled server (apps/desktop)
const isStaticExport = process.env.BEATSYNC_STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isStaticExport && { output: "export", images: { unoptimized: true } }),
  reactCompiler: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "i.scdn.co",
      },
      {
        protocol: "https",
        hostname: "is1-ssl.mzstatic.com",
      },
      {
        protocol: "https",
        hostname: "lastfm.freetls.fastly.net",
      },
      {
        protocol: "https",
        hostname: "static.qobuz.com",
      },
      {
        protocol: "https",
        hostname: "i.ytimg.com",
      },
    ],
  },
  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
  // Private network ranges let phones on the local network load dev resources
  allowedDevOrigins: ["local.beatsync.gg", "10.*.*.*", "192.168.*.*", "172.*.*.*"],
};

export default nextConfig;
