// Vitest global setup builds and serves the shipped UI once per serial E2E shard.
import { chromium } from "playwright";
import type { TestProject } from "vitest/node";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startBundledControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eServerBaseUrl: string | null;
  }
}

export default async function setup(project: TestProject) {
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  if (!canRunPlaywrightChromium(executablePath)) {
    project.provide("controlUiE2eServerBaseUrl", null);
    return;
  }

  const server = await startBundledControlUiE2eServer();
  project.provide("controlUiE2eServerBaseUrl", server.baseUrl);
  return async () => {
    await server.close();
  };
}
