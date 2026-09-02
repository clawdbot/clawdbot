/**
 * Confirms admitted plugin and account apps against their actual Codex thread before
 * OpenClaw commits a binding or starts a turn.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject, v2 } from "./protocol.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { attestCodexRestrictedToolSurfaceMcpServersDisabled } from "./thread-mcp-attestation.js";

/** Every admission path checks the same surface; its lifecycle owner keeps the claim fenced. */
export async function attestCodexThreadToolSurface(
  params: Parameters<typeof attestCodexPluginThreadApps>[0] & {
    threadConfig?: JsonObject;
    restrictedToolSurface: boolean;
    lifecycleTiming: CodexThreadLifecycleTimingTracker;
    assertCurrent: () => void;
  },
): Promise<void> {
  params.assertCurrent();
  if (params.appIds.length > 0) {
    await params.lifecycleTiming.measure("plugin-app-attestation", () =>
      attestCodexPluginThreadApps(params),
    );
    params.assertCurrent();
  }
  if (params.restrictedToolSurface) {
    // Codex exposes admitted account apps through its built-in codex_apps server.
    await params.lifecycleTiming.measure("restricted-tool-surface-mcp-attestation", () =>
      attestCodexRestrictedToolSurfaceMcpServersDisabled(
        params.client,
        params.threadId,
        params.threadConfig,
        params.signal,
        params.appIds.length > 0 ? ["codex_apps"] : [],
      ),
    );
    params.assertCurrent();
  }
}

class CodexPluginThreadAppAttestationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexPluginThreadAppAttestationError";
  }
}

/** Reads the existing runtime snapshot with the started thread's effective app policy. */
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
      { threadId: params.threadId, forceRefresh: false },
      { signal: params.signal },
    );
  } catch (error) {
    throw new CodexPluginThreadAppAttestationError(
      `Codex could not confirm admitted apps for thread ${params.threadId}`,
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
      `Codex thread ${params.threadId} did not expose admitted apps: ${failures.join(", ")}`,
    );
  }
}

/** Deletes a persistent pre-turn thread; ephemeral threads can only be unsubscribed. */
export async function discardUnattestedCodexPluginThread(params: {
  client: CodexAppServerClient;
  threadId: string;
  ephemeral: boolean;
}): Promise<boolean> {
  if (params.ephemeral) {
    return await unsubscribeCodexThreadBestEffort(params.client, {
      threadId: params.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
  }

  try {
    await params.client.request(
      "thread/delete",
      { threadId: params.threadId },
      { timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    embeddedAgentLog.debug("codex plugin app attestation thread deletion failed", {
      threadId: params.threadId,
      error,
    });
    await unsubscribeCodexThreadBestEffort(params.client, {
      threadId: params.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    return false;
  }
}
