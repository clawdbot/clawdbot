/**
 * Confirms provisionally admitted Codex apps against the effective config of a
 * newly started thread before OpenClaw persists or turns on that thread.
 */
import type { CodexAppServerClient } from "./client.js";
import type { v2 } from "./protocol.js";

/** Raised when a fresh thread does not expose every provisionally admitted app. */
class CodexPluginThreadAppAttestationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexPluginThreadAppAttestationError";
  }
}

/** Reads thread-scoped runtime state directly so it never enters the account cache. */
export async function attestCodexPluginThreadApps(params: {
  client: CodexAppServerClient;
  threadId: string;
  appIds: readonly string[];
  signal?: AbortSignal;
}): Promise<void> {
  const appIds = Array.from(new Set(params.appIds.filter(Boolean))).toSorted();
  if (appIds.length === 0) {
    return;
  }

  let response: v2.AppsInstalledResponse;
  try {
    response = await params.client.request(
      "app/installed",
      {
        threadId: params.threadId,
        forceRefresh: true,
      },
      { signal: params.signal },
    );
  } catch (error) {
    throw new CodexPluginThreadAppAttestationError(
      `Codex could not confirm provisional apps for thread ${params.threadId}`,
      { cause: error },
    );
  }

  const installedById = new Map(response.apps.map((app) => [app.id, app] as const));
  const failures = appIds.flatMap((appId): string[] => {
    const app = installedById.get(appId);
    if (!app) {
      return [`${appId}:missing`];
    }
    if (!app.enabled) {
      return [`${appId}:disabled`];
    }
    return app.callable ? [] : [`${appId}:not-callable`];
  });
  if (failures.length > 0) {
    throw new CodexPluginThreadAppAttestationError(
      `Codex thread ${params.threadId} did not expose provisional apps: ${failures.join(", ")}`,
    );
  }
}
