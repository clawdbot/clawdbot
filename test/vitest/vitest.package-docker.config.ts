// The package-builder contract does not launch the packaged CLI or private QA.
// Keep its process tests on the E2E runtime without the unrelated dist build.
import { defineConfig } from "vitest/config";
import e2eConfig from "./vitest.e2e.config.ts";

export default defineConfig({
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    fileParallelism: false,
    globalSetup: [],
    include: ["test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts"],
    maxWorkers: 1,
    name: "package-docker",
  },
});
