import { defineConfig } from "vitest/config";
import { resolveDefaultVitestPool } from "../test/vitest/vitest.shared.config.ts";

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  test: {
    isolate: false,
    pool: resolveDefaultVitestPool(),
    testTimeout: 120_000,
    include: [
      "src/**/*.node.test.ts",
      "src/ui/chat/chat-responsive.browser.test.ts",
      "src/ui/views/sessions.browser.test.ts",
    ],
    environment: "node",
  },
});
