import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The monorepo root, so the standalone build includes packages/core.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  transpilePackages: ["@debrief/core"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Settings pages that moved.
  async redirects() {
    return [
      { source: "/settings/claude", destination: "/settings/ai", permanent: true },
      { source: "/settings/recordings", destination: "/settings/storage", permanent: true },
      { source: "/settings/sign-in", destination: "/settings/account", permanent: true },
    ];
  },
};

export default nextConfig;
