import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace from this project even if a lockfile exists in a parent directory, so the
  // standalone server always lands at .next/standalone/server.js.
  outputFileTracingRoot: path.join(__dirname),
  // store.ts resolves `<cwd>/data`, so tracing would otherwise copy a local SQLite database
  // (snapshots, encrypted OAuth tokens) into .next/standalone. Runtime data never ships.
  // The key must be "/**" (app routes only): a key that also matches Next's internal
  // "next-server" entry applies the pattern unanchored and drops next/dist/lib/metadata.
  outputFileTracingExcludes: { "/**": ["data/**", "reports/**"] },
  serverExternalPackages: ["better-sqlite3", "unpdf", "googleapis"],
};

export default nextConfig;
