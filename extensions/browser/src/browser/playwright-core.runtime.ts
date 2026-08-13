/**
 * Playwright runtime loader.
 *
 * Loads playwright-core through CommonJS require so the browser plugin can use
 * the dependency from the packaged runtime boundary.
 */
import { createRequire } from "node:module";
import type * as PlaywrightCore from "playwright-core";

const require = createRequire(import.meta.url);
const playwrightCoreBundle = require("playwright-core/lib/coreBundle") as {
  getUserAgent: () => string;
};

/** Runtime playwright-core module instance. */
export const playwrightCore = require("playwright-core") as typeof PlaywrightCore;

/** Dependency-owned User-Agent used by Playwright's native CDP WebSocket transport. */
export const getPlaywrightUserAgent = playwrightCoreBundle.getUserAgent;
