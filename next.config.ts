import type { NextConfig } from "next";

// Internal, authenticated application: every screen reads the session and live
// records, so Cache Components / partial prefetching are intentionally disabled.
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "pg-boss"],
  poweredByHeader: false,
  typedRoutes: false,
  experimental: {
    serverActions: { bodySizeLimit: "15mb" },
    authInterrupts: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
