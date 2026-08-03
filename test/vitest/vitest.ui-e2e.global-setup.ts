// Vitest global setup builds and serves the shipped UI once per serial E2E shard.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  // Local full-suite runs can fan shards into separate processes in one checkout.
  // Keep every build out of canonical dist so those processes cannot clobber it.
  const outDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-ui-e2e-"));
  const server = await startBundledControlUiE2eServer(outDir).catch(async (error) => {
    await rm(outDir, { force: true, recursive: true }).catch(() => {});
    throw error;
  });
  try {
    project.provide("controlUiE2eServerBaseUrl", server.baseUrl);
    return async () => {
      try {
        await server.close();
      } finally {
        await rm(outDir, { force: true, recursive: true });
      }
    };
  } catch (error) {
    await server.close().catch(() => {});
    await rm(outDir, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}
