/**
 * In-process browser bridge registry keyed by sandbox session.
 *
 * The prune path uses this table to stop bridge servers when backing containers expire.
 */
import { type BrowserBridge, stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";

type CachedBrowserBridge = {
  bridge: BrowserBridge;
  containerName: string;
  authToken?: string;
  authPassword?: string;
};

export const BROWSER_BRIDGES = new Map<string, CachedBrowserBridge>();

/** Stop and remove only the cached bridge instance the caller inspected. */
export async function stopCachedBrowserBridge(
  sessionKey: string,
  expected: CachedBrowserBridge,
): Promise<void> {
  if (BROWSER_BRIDGES.get(sessionKey) !== expected) {
    return;
  }
  await stopBrowserBridgeServer(expected.bridge.server);
  if (BROWSER_BRIDGES.get(sessionKey) === expected) {
    BROWSER_BRIDGES.delete(sessionKey);
  }
}

/** Drain every cached bridge that still owns one sandbox container. */
export async function stopCachedBrowserBridgesForContainer(containerName: string): Promise<void> {
  for (;;) {
    const match = [...BROWSER_BRIDGES].find(([, cached]) => cached.containerName === containerName);
    if (!match) {
      return;
    }
    await stopCachedBrowserBridge(match[0], match[1]);
  }
}
