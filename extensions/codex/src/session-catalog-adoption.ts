import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  listSessionCatalogEntries,
  sessionCatalogAdoptedSessionKey,
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogEntrySnapshot,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread } from "./app-server/protocol.js";
import {
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import { createImportedCodexSession } from "./app-server/session-history-import.js";
import {
  adoptionSessionKeyRest,
  continueOperations,
  runSessionActionExclusive,
  type AdoptedSessionEntry,
  type CodexSessionDisposition,
} from "./session-catalog-node-adoption.js";
import {
  boundedCatalogString,
  CatalogParamsError,
  CODEX_LOCAL_SESSION_HOST_ID,
  MAX_SESSION_ID_LENGTH,
  requireBoundThread,
} from "./session-catalog-parsing.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  codexLastTerminalTurnId,
  codexUpstreamBaseline,
  type CodexUpstreamBaseline,
} from "./session-upstream-marker.js";

const CODEX_SUPERVISION_SESSION_KEY_PREFIX = "harness:codex:supervision:";

const boundCatalogSessionId = (value: unknown) =>
  boundedCatalogString(value, MAX_SESSION_ID_LENGTH);

export function requireIdleThread(thread: CodexThread, action: "continue" | "archive"): void {
  if (
    thread.status?.type === "idle" ||
    (action === "archive" && thread.status?.type === "notLoaded")
  ) {
    return;
  }
  if (thread.status?.type === "active") {
    throw new CatalogParamsError(
      `Codex session is active in this App Server; wait for it to finish before ${action === "continue" ? "starting a branch" : "archiving"}`,
    );
  }
  throw new CatalogParamsError(
    action === "archive"
      ? "Codex session cannot be archived in its current state"
      : "Codex session cannot start a branch in its current state",
  );
}

function adoptionSessionKey(threadId: string, sourceHomeId?: string): string {
  const source = sourceHomeId ? JSON.stringify([sourceHomeId, threadId]) : threadId;
  return sessionCatalogAdoptedSessionKey(CODEX_SUPERVISION_SESSION_KEY_PREFIX, source);
}

export function isAdoptionSessionKeyForThread(
  sessionKey: string,
  threadId: string,
  sourceHomeId?: string,
): boolean {
  return adoptionSessionKeyRest(sessionKey) === adoptionSessionKey(threadId, sourceHomeId);
}

type CodexSupervisionMarker = { sourceThreadId: string; sourceHomeId?: string };

function readCodexSupervisionMarker(entry: {
  pluginExtensions?: Record<string, unknown>;
}): CodexSupervisionMarker | undefined {
  const codex = isRecord(entry.pluginExtensions?.codex) ? entry.pluginExtensions.codex : undefined;
  const marker = codex && isRecord(codex.supervision) ? codex.supervision : undefined;
  const sourceThreadId = marker?.sourceThreadId;
  const sourceHomeId = marker?.sourceHomeId;
  if (
    typeof sourceThreadId !== "string" ||
    !sourceThreadId.trim() ||
    (sourceHomeId !== undefined && (typeof sourceHomeId !== "string" || !sourceHomeId.trim()))
  ) {
    return undefined;
  }
  return {
    sourceThreadId: sourceThreadId.trim(),
    ...(typeof sourceHomeId === "string" ? { sourceHomeId: sourceHomeId.trim() } : {}),
  };
}

export async function listAdoptedSessionEntries(params: {
  agentId?: string;
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
  sessionEntries?: SessionCatalogEntrySnapshot;
}): Promise<Map<string, AdoptedSessionEntry>> {
  const adopted = new Map<string, AdoptedSessionEntry>();
  for (const { agentId, entry, sessionKey } of listSessionCatalogEntries({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    config: params.config ?? {},
    runtime: params.runtime,
    sessionEntries: params.sessionEntries,
  })) {
    const sessionKeyRest = adoptionSessionKeyRest(sessionKey);
    const marker = readCodexSupervisionMarker(entry);
    if (
      !sessionKeyRest.startsWith(CODEX_SUPERVISION_SESSION_KEY_PREFIX) ||
      !marker ||
      entry.initializationPending === true ||
      entry.agentHarnessId !== "codex" ||
      entry.modelSelectionLocked !== true
    ) {
      continue;
    }
    const sessionId = entry.sessionId?.trim();
    if (!sessionId) {
      continue;
    }
    const binding = params.bindingStore.read(
      sessionBindingIdentity({ sessionId, sessionKey, config: params.config }),
    );
    const sourceThreadId = binding?.supervisionSourceThreadId?.trim();
    const boundThreadId = binding?.threadId.trim();
    if (
      binding?.connectionScope !== "supervision" ||
      !sourceThreadId ||
      !boundThreadId ||
      sessionKeyRest !== adoptionSessionKey(sourceThreadId, marker.sourceHomeId)
    ) {
      continue;
    }
    const sourceKey = sessionCatalogAdoptedSourceKey(
      marker.sourceHomeId ?? CODEX_LOCAL_SESSION_HOST_ID,
      sourceThreadId,
    );
    if (adopted.has(sourceKey)) {
      throw new Error(
        `multiple OpenClaw sessions adopt Codex thread ${sourceThreadId} from the same home`,
      );
    }
    adopted.set(sourceKey, { key: sessionKey, sessionId, agentId, boundThreadId });
  }
  return adopted;
}

async function findAdoptedSessionEntry(params: {
  agentId?: string;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  threadId: string;
  sourceHomeId?: string;
  allowLegacy?: boolean;
}): Promise<AdoptedSessionEntry | undefined> {
  const adopted = await listAdoptedSessionEntries(params);
  const exact = adopted.get(
    sessionCatalogAdoptedSourceKey(
      params.sourceHomeId ?? CODEX_LOCAL_SESSION_HOST_ID,
      params.threadId,
    ),
  );
  return (
    exact ??
    (params.sourceHomeId && params.allowLegacy === true
      ? adopted.get(sessionCatalogAdoptedSourceKey(CODEX_LOCAL_SESSION_HOST_ID, params.threadId))
      : undefined)
  );
}

function matchesPendingAdoptionBinding(
  binding: CodexAppServerThreadBinding | undefined,
  expected: {
    sourceThreadId: string;
    connectionFingerprint: string;
    cwd: string;
    lastTurnId?: string;
  },
): boolean {
  const historyCoveredThrough = binding?.historyCoveredThrough;
  return (
    binding?.threadId === expected.sourceThreadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    binding.cwd === expected.cwd &&
    binding.conversationSourceTransferComplete === true &&
    binding.preserveNativeModel === true &&
    binding.pendingSupervisionBranch?.sourceThreadId === expected.sourceThreadId &&
    binding.pendingSupervisionBranch.connectionFingerprint === expected.connectionFingerprint &&
    binding.pendingSupervisionBranch.lastTurnId === expected.lastTurnId &&
    (binding.pendingSupervisionBranch.cleanupThreadIds?.length ?? 0) === 0 &&
    typeof historyCoveredThrough === "string" &&
    Number.isFinite(Date.parse(historyCoveredThrough))
  );
}

async function ensurePendingAdoptionBinding(params: {
  initialization: Parameters<Parameters<typeof createImportedCodexSession>[0]["afterImport"]>[1];
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  identity: ReturnType<typeof sessionBindingIdentity>;
  sourceThreadId: string;
  connectionFingerprint: string;
  cwd: string;
  lastTurnId?: string;
}): Promise<void> {
  const pending: CodexAppServerPendingSupervisionBranch = {
    sourceThreadId: params.sourceThreadId,
    connectionFingerprint: params.connectionFingerprint,
    ...(params.lastTurnId ? { lastTurnId: params.lastTurnId } : {}),
  };
  const ownsGeneration = await reclaimCurrentCodexSessionGeneration({
    assertCurrent: params.initialization.assertCurrent,
    bindingStore: params.bindingStore,
    identity: params.identity,
    config: params.config,
  });
  params.initialization.assertCurrent();
  if (!ownsGeneration) {
    throw new Error(`failed to claim the OpenClaw session generation for ${params.sourceThreadId}`);
  }
  const existing = params.bindingStore.read(params.identity);
  params.initialization.assertCurrent();
  if (existing) {
    if (matchesPendingAdoptionBinding(existing, params)) {
      return;
    }
    throw new Error(`OpenClaw session is already bound to Codex thread ${existing.threadId}`);
  }
  const binding = {
    threadId: params.sourceThreadId,
    connectionScope: "supervision" as const,
    supervisionSourceThreadId: params.sourceThreadId,
    cwd: params.cwd,
    historyCoveredThrough: new Date().toISOString(),
    conversationSourceTransferComplete: true as const,
    preserveNativeModel: true as const,
    pendingSupervisionBranch: pending,
  };
  await params.initialization.bind(binding);
}

async function createOrReuseAdoptedSession(params: {
  agentId: string;
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  sourceThread: CodexThread;
  connectionFingerprint: string;
  sourceHomeId?: string;
  allowLegacy?: boolean;
}): Promise<AdoptedSessionEntry> {
  const runtime = params.api.runtime;
  const lookup = { ...params, runtime, threadId: params.sourceThread.id };
  const existing = await findAdoptedSessionEntry(lookup);
  if (existing) {
    return existing;
  }
  try {
    const spawnedCwd = params.sourceThread.cwd?.trim() || undefined;
    const pendingLastTurnId = codexLastTerminalTurnId(params.sourceThread, boundCatalogSessionId);
    const marker: CodexSupervisionMarker = {
      sourceThreadId: params.sourceThread.id,
      ...(params.sourceHomeId ? { sourceHomeId: params.sourceHomeId } : {}),
    };
    const created = await createImportedCodexSession({
      runtime: params.api.runtime,
      bindingStore: params.bindingStore,
      config: params.config,
      key: adoptionSessionKey(params.sourceThread.id, params.sourceHomeId),
      agentId: params.agentId,
      displayName: params.sourceThread.name ?? undefined,
      thread: params.sourceThread,
      throughTurnId: pendingLastTurnId ?? null,
      recoverMatchingInitialEntry: true,
      initialEntry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: {
            supervision: {
              ...marker,
              initializing: true,
              modelLocked: true,
            },
          },
        },
      },
      afterImport: async (entry, initialization) => {
        const identity = sessionBindingIdentity({
          sessionId: entry.sessionId,
          sessionKey: entry.key,
          config: params.config,
        });
        await ensurePendingAdoptionBinding({
          bindingStore: params.bindingStore,
          config: params.config,
          identity,
          initialization,
          sourceThreadId: params.sourceThread.id,
          connectionFingerprint: params.connectionFingerprint,
          cwd: spawnedCwd ?? "",
          ...(pendingLastTurnId ? { lastTurnId: pendingLastTurnId } : {}),
        });
        return {
          pluginExtensions: {
            codex: {
              supervision: { ...marker, modelLocked: true },
            },
          },
        };
      },
    });
    return {
      key: created.key,
      sessionId: created.sessionId,
      agentId: created.agentId,
      boundThreadId: params.sourceThread.id,
    };
  } catch (error) {
    // Concurrent/retried Continue calls converge on the same trusted marker.
    // An unrelated entry at the deterministic key is never overwritten.
    const raced = await findAdoptedSessionEntry(lookup);
    if (raced) {
      return raced;
    }
    throw error;
  }
}

type ContinueLocalCodexSessionParams = {
  agentId: string;
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  threadId: string;
  hostId?: string;
  sourceHomeId?: string;
  allowLegacy?: boolean;
  onContinued?: (upstream: CodexUpstreamBaseline & { connectionFingerprint: string }) => void;
};

async function continueLocalCodexSessionInner(
  params: ContinueLocalCodexSessionParams,
): Promise<{ sessionKey: string; disposition: CodexSessionDisposition }> {
  await params.control.requireEligibleThread(params.threadId);
  const existing = await findAdoptedSessionEntry({ ...params, runtime: params.api.runtime });
  if (existing) {
    const boundThreadId = requireBoundThread(existing);
    const boundThread = await params.control.readThread(boundThreadId, true);
    if (boundThread.id !== boundThreadId) {
      throw new Error("Codex app-server returned a different thread than requested");
    }
    // Catalog state can race archive/reset. Restore only the same locked generation
    // under the session-store write lock so a stale Open Chat cannot revive a replacement.
    const changedError = () =>
      new CatalogParamsError("Codex OpenClaw session changed before it could be opened. Retry.");
    const restored = await params.api.runtime.agent.session.patchSessionEntry({
      sessionKey: existing.key,
      readConsistency: "latest",
      preserveActivity: true,
      update: (entry) => {
        if (
          entry.sessionId?.trim() !== existing.sessionId ||
          entry.initializationPending === true ||
          entry.agentHarnessId !== "codex" ||
          entry.modelSelectionLocked !== true
        ) {
          throw changedError();
        }
        return { archivedAt: undefined, archivedBy: undefined, archiveReason: undefined };
      },
    });
    if (!restored) {
      throw changedError();
    }
    const connectionFingerprint = params.control.connectionFingerprint;
    if (connectionFingerprint) {
      params.onContinued?.({
        connectionFingerprint,
        ...codexUpstreamBaseline(boundThread, boundCatalogSessionId),
      });
    }
    return { sessionKey: existing.key, disposition: "existing" };
  }

  const sourceThread = await params.control.readThread(params.threadId, true);
  if (sourceThread.id !== params.threadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  if (sourceThread.status?.type !== "notLoaded") {
    requireIdleThread(sourceThread, "continue");
  }
  const connectionFingerprint = params.control.connectionFingerprint;
  if (!connectionFingerprint) {
    throw new Error("Codex Continue requires a pinned app-server connection");
  }
  const adopted = await createOrReuseAdoptedSession({
    ...params,
    sourceThread,
    connectionFingerprint,
  });
  const boundThreadId = requireBoundThread(adopted);
  const baselineThread =
    boundThreadId === sourceThread.id
      ? sourceThread
      : await params.control.readThread(boundThreadId, true);
  if (baselineThread.id !== boundThreadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  params.onContinued?.({
    connectionFingerprint,
    ...codexUpstreamBaseline(baselineThread, boundCatalogSessionId),
  });
  return { sessionKey: adopted.key, disposition: "forked" };
}

/** Creates one locked OpenClaw branch whose first harness run forks the Codex source. */
export async function continueLocalCodexSession(params: ContinueLocalCodexSessionParams): Promise<{
  sessionKey: string;
  disposition: CodexSessionDisposition;
}> {
  const sourceKey = sessionCatalogAdoptedSourceKey(
    params.hostId ?? CODEX_LOCAL_SESSION_HOST_ID,
    params.threadId,
  );
  const operationKey = sessionCatalogAdoptedSourceKey(params.agentId, sourceKey);
  // Memoization is agent-qualified while the native action lock is source-qualified,
  // so different agents serialize on one thread without joining one adoption result.
  const current = continueOperations.get(operationKey);
  if (current) {
    return await current;
  }
  const run = async (control: CodexSessionCatalogControl) =>
    await continueLocalCodexSessionInner({ ...params, control });
  const operation = runSessionActionExclusive(sourceKey, async () =>
    params.control.withPinnedConnection(run),
  );
  continueOperations.set(operationKey, operation);
  try {
    return await operation;
  } finally {
    if (continueOperations.get(operationKey) === operation) {
      continueOperations.delete(operationKey);
    }
  }
}
