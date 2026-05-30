import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    runner: undefined,
    projects: [
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.unit-fast-fake-timers.config.ts",
    ],
  },
});
