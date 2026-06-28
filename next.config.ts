import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle for the Docker image only; plain
  // `next start` (used by tests/local) is incompatible with standalone output.
  output: process.env.POWERFLOW_STANDALONE === "1" ? "standalone" : undefined,
  // Energy data is small and changes constantly; never statically cache API output.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
