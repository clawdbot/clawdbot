// Vitest global setup builds and serves the shipped UI once per serial E2E shard.
import { chromium } from "playwright";
import type { TestProject } from "vitest/node";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startBundledControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createTempDirTracker } from "../helpers/temp-dir.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eChromium: { executablePath: string; available: boolean };
    controlUiE2eServerBaseUrl: string | null;
  }
}

export default async function setup(project: TestProject) {
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const available = canRunPlaywrightChromium(executablePath);
  project.provide("controlUiE2eChromium", { executablePath, available });
  if (!available) {
    project.provide("controlUiE2eServerBaseUrl", null);
    // No-op teardown keeps both paths value-returning for Vitest's setup contract.
    return () => {};
  }

  // Local full-suite runs can fan shards into separate processes in one checkout.
  // Keep every build out of canonical dist so those processes cannot clobber it.
  const tempDirs = createTempDirTracker();
  const outDir = tempDirs.make("openclaw-ui-e2e-");
  const server = await startBundledControlUiE2eServer(outDir).catch(async (error: unknown) => {
    try {
      tempDirs.cleanup();
    } catch {}
    throw error;
  });
  try {
    project.provide("controlUiE2eServerBaseUrl", server.baseUrl);
    return async () => {
      try {
        await server.close();
      } finally {
        tempDirs.cleanup();
      }
    };
  } catch (error) {
    await server.close().catch(() => {});
    try {
      tempDirs.cleanup();
    } catch {}
    throw error;
  }
}
