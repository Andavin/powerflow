import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle for the Docker image only; plain
  // `next start` (used by tests/local) is incompatible with standalone output.
  output: process.env.POWERFLOW_STANDALONE === "1" ? "standalone" : undefined,
  // Dev-only: allow HMR / dev resources when the app is opened via these hosts
  // (Next 16 blocks cross-origin dev requests by default). Extend via the
  // POWERFLOW_DEV_ORIGINS env (comma-separated) for other hostnames/IPs.
  allowedDevOrigins: [
    "nas",
    ...(process.env.POWERFLOW_DEV_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
  ],
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
