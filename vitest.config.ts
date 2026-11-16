import fs from "fs";
import os from "os";
import path from "path";
import { defineConfig } from "vitest/config";

// Model calls read Admin Console settings from the SQLite store. Point every test run at a
// throwaway data directory so nothing touches ./data; tests that write data or settings
// stub DATA_DIR to their own temporary directory.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerpulse-vitest-"));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { DATA_DIR: testDataDir },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
