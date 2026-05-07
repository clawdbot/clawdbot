import { playwright } from "@vitest/browser-playwright";
import { defineConfig, defineProject } from "vitest/config";
import {
  jsdomOptimizedDeps,
  resolveDefaultVitestPool,
} from "../test/vitest/vitest.shared.config.ts";

const sharedUiTestConfig = {
  isolate: false,
  pool: resolveDefaultVitestPool(),
} as const;
const nodeDrivenBrowserLayoutTests = [
  "src/ui/chat/chat-responsive.browser.test.ts",
  "src/ui/views/sessions.browser.test.ts",
] as const;

export default defineConfig({
  test: {
    ...sharedUiTestConfig,
    projects: [
      defineProject({
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts", "src/**/*.node.test.ts"],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        test: {
          ...sharedUiTestConfig,
          deps: jsdomOptimizedDeps,
          name: "unit-node",
          include: ["src/**/*.node.test.ts", ...nodeDrivenBrowserLayoutTests],
          environment: "jsdom",
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
        },
      }),
      defineProject({
        test: {
          ...sharedUiTestConfig,
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          exclude: [...nodeDrivenBrowserLayoutTests],
          setupFiles: ["./src/test-helpers/lit-warnings.setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium", name: "chromium" }],
            headless: true,
            ui: false,
          },
        },
      }),
    ],
  },
});
