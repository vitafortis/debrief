import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The monorepo root, so the standalone build includes packages/core.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  transpilePackages: ["@debrief/core"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
