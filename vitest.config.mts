import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // DB-backed tests share one database; run files sequentially for determinism.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
