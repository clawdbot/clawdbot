import type { Server } from "node:http";
import { getPwAiModule } from "./pw-ai-module.js";
import { isPwAiLoaded } from "./pw-ai-state.js";
import type { BrowserServerState } from "./server-context.js";
import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.js";
import { startTrackedBrowserTabCleanupTimer } from "./session-tab-cleanup.js";

export async function createBrowserRuntimeState(params: {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  const state: BrowserServerState = {
    server: params.server ?? null,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  };
  state.stopTrackedTabCleanup = startTrackedBrowserTabCleanupTimer({
    onWarn: params.onWarn,
  });

  await ensureExtensionRelayForProfiles({
    resolved: params.resolved,
    onWarn: params.onWarn,
  });

  return state;
}

export async function stopBrowserRuntime(params: {
  current: BrowserServerState | null;
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<void> {
  if (!params.current) {
    return;
  }
  params.current.stopTrackedTabCleanup?.();

  await stopKnownBrowserProfiles({
    getState: params.getState,
    onWarn: params.onWarn,
  });

  if (params.closeServer && params.current.server) {
    await new Promise<void>((resolve) => {
      params.current?.server?.close(() => resolve());
    });
  }

  params.clearState();

  if (!isPwAiLoaded()) {
    return;
  }
  try {
    const mod = await getPwAiModule({ mode: "soft" });
    await mod?.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
