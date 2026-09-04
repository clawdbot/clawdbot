// All UI E2E projects provide Chromium metadata without acquiring a UI server.
import { chromium } from "playwright";
import type { TestProject } from "vitest/node";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eChromium: { executablePath: string; available: boolean };
  }
}

export default function setup(project: TestProject) {
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const available = canRunPlaywrightChromium(executablePath);
  project.provide("controlUiE2eChromium", { executablePath, available });
}
