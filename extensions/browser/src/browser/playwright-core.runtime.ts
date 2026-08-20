/**
 * Playwright runtime loader.
 *
 * Static package imports keep the worker deploy build's executable closure visible
 * to the bundler while normal package builds may still externalize the dependency.
 */
import playwrightCoreDefault from "playwright-core";
import type * as PlaywrightCore from "playwright-core";
import coreBundle from "./playwright-core-bundle.runtime.mjs";

/** Runtime playwright-core module instance. */
export const playwrightCore = playwrightCoreDefault as typeof PlaywrightCore;

/** Dependency-owned User-Agent used by Playwright's native CDP WebSocket transport. */
export const getPlaywrightUserAgent = (coreBundle as { getUserAgent: () => string }).getUserAgent;
