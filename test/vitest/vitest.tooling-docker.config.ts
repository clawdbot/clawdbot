// Vitest tooling Docker config isolates the slow Docker helper contract tests.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export const toolingDockerTestFiles = ["test/scripts/docker-build-helper.test.ts"];

export function createToolingDockerVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(toolingDockerTestFiles, {
    env,
    fileParallelism: false,
    name: "tooling-docker",
    passWithNoTests: true,
  });
}

export default createToolingDockerVitestConfig();
