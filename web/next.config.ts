import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The monorepo root, so the standalone build includes packages/core.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  transpilePackages: ["@debrief/core"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Pages that moved.
  async redirects() {
    return [
      { source: "/settings/claude", destination: "/settings/ai", permanent: true },
      { source: "/settings/recordings", destination: "/settings/storage", permanent: true },
      { source: "/settings/sign-in", destination: "/settings/account", permanent: true },
      // Links in Slack, notes and task tools from before Meetings became Recordings.
      { source: "/meetings", destination: "/recordings", permanent: true },
      { source: "/meetings/:id", destination: "/recordings/:id", permanent: true },
    ];
  },
};

export default nextConfig;
