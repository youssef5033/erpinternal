import type { NextConfig } from "next";

// Internal, authenticated application: every screen reads the session and live
// records, so Cache Components / partial prefetching are intentionally disabled.
// LOW_MEMORY_BUILD=true (set on small hosts such as Render's free tier): build with one
// worker and skip the in-build type check. Types are still checked by `npm run typecheck`
// and the test suite before code is pushed.
const lowMemoryBuild = process.env.LOW_MEMORY_BUILD === "true";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "pg-boss"],
  poweredByHeader: false,
  typedRoutes: false,
  typescript: { ignoreBuildErrors: lowMemoryBuild },
  experimental: {
    serverActions: { bodySizeLimit: "15mb" },
    authInterrupts: true,
    ...(lowMemoryBuild ? { cpus: 1 } : {}),
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
