// Control UI config module wires vitest behavior.
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
      "src/pages/chat/chat-responsive.browser.test.ts",
      "src/pages/sessions/view.browser.test.ts",
    ],
    environment: "node",
  },
});
