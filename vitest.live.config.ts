import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/vendor/**",
      "dist/Clawdbot.app/**",
    ],
  },
});
