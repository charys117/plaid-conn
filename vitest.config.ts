import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
    maxWorkers: 2,
    coverage: {
      reporter: ["text", "json", "html"]
    }
  }
});
