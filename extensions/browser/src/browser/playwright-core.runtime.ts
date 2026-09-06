/**
 * Playwright runtime loader.
 *
 * Loads playwright-core only when browser behavior needs it. The worker deploy
 * build declares its static dependency closure in worker-deploy-build-plugin.mts.
 */
import { createRequire } from "node:module";
import type * as PlaywrightCore from "playwright-core";

const require = createRequire(import.meta.url);

/** Loads the Playwright runtime on first Browser use. */
export function getPlaywrightCore(): typeof PlaywrightCore {
  return require("playwright-core") as typeof PlaywrightCore;
}

/** Dependency-owned User-Agent used by Playwright's native CDP WebSocket transport. */
export function getPlaywrightUserAgent(): string {
  return (
    require("playwright-core/lib/coreBundle") as { getUserAgent: () => string }
  ).getUserAgent();
}
