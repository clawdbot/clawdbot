import { createHash } from "node:crypto";
import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread } from "./app-server/protocol.js";
import { importCodexThreadHistoryToTranscript } from "./app-server/transcript-mirror.js";
import {
  boundedCatalogString,
  CatalogParamsError,
  MAX_SESSION_ID_LENGTH,
} from "./session-catalog-parsing.js";
import type { CodexSessionCatalogSession } from "./session-catalog-types.js";

const CODEX_NODE_SESSION_KEY_PREFIX = "harness:codex:node-session:";

type CatalogSessionEntry = ReturnType<
  PluginRuntime["agent"]["session"]["listSessionEntries"]
>[number]["entry"];

type CodexNodeSessionMarker = {
  sourceHostId: string;
  sourceThreadId: string;
  nodeId: string;
  initializing?: true;
};

export type AdoptedSessionEntry = {
  key: string;
  sessionId: string;
  agentId: string;
  initializing?: true;
  /** Bound canonical thread for local supervision adoptions; absent for node entries. */
  boundThreadId?: string;
};

export type CodexNodeHistory = {
  thread: CodexThread;
  throughTurnId: string | null;
};

export type CodexSessionDisposition = "existing" | "forked";

export const continueOperations = new Map<
  string,
  Promise<{ sessionKey: string; disposition: CodexSessionDisposition }>
>();
const sessionActionTails = new Map<string, Promise<void>>();

export async function runSessionActionExclusive<T>(
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = sessionActionTails.get(threadId) ?? Promise.resolve();
  const operation = previous.then(run);
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  sessionActionTails.set(threadId, tail);
  try {
    return await operation;
  } finally {
    if (sessionActionTails.get(threadId) === tail) {
      sessionActionTails.delete(threadId);
    }
  }
}

// Session creation persists this plugin-owned suffix under an agent-qualified key.
// Restart discovery must compare the parsed suffix, not the returned canonical key.
export function adoptionSessionKeyRest(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  return parseAgentSessionKey(trimmed)?.rest ?? trimmed;
}

export function listSupervisionAgentIds(config: OpenClawConfig): string[] {
  const defaultAgentId = resolveDefaultAgentId(config);
  return [defaultAgentId, ...listAgentIds(config).filter((agentId) => agentId !== defaultAgentId)];
}

export function adoptedSourceKey(hostId: string, threadId: string): string {
  return `${hostId}\u0000${threadId}`;
}

export function lastTerminalTurnId(thread: CodexThread): string | undefined {
  for (let index = (thread.turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    const turn = thread.turns?.[index];
    const turnId = boundedCatalogString(turn?.id, MAX_SESSION_ID_LENGTH);
    if (!turnId) {
      continue;
    }
    if (
      turn?.status === "completed" ||
      turn?.status === "interrupted" ||
      turn?.status === "failed"
    ) {
      return turnId;
    }
  }
  return undefined;
}

function nodeAdoptionSessionKey(hostId: string, threadId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([hostId, threadId]))
    .digest("hex");
  return `${CODEX_NODE_SESSION_KEY_PREFIX}${digest}`;
}

function readNodeSessionMarker(entry: CatalogSessionEntry): CodexNodeSessionMarker | undefined {
  const codex = isRecord(entry.pluginExtensions?.codex) ? entry.pluginExtensions.codex : undefined;
  const marker = codex && isRecord(codex.sessionCatalog) ? codex.sessionCatalog : undefined;
  if (
    !marker ||
    typeof marker.sourceHostId !== "string" ||
    !marker.sourceHostId.startsWith("node:") ||
    typeof marker.sourceThreadId !== "string" ||
    !marker.sourceThreadId.trim() ||
    typeof marker.nodeId !== "string" ||
    !marker.nodeId.trim()
  ) {
    return undefined;
  }
  return {
    sourceHostId: marker.sourceHostId,
    sourceThreadId: marker.sourceThreadId,
    nodeId: marker.nodeId,
    ...(marker.initializing === true ? { initializing: true } : {}),
  };
}

export function listNodeAdoptedSessionEntries(params: {
  config?: OpenClawConfig;
  runtime: PluginRuntime;
  includeInitializing?: boolean;
}): Map<string, AdoptedSessionEntry> {
  const adopted = new Map<string, AdoptedSessionEntry>();
  for (const agentId of listSupervisionAgentIds(params.config ?? {})) {
    for (const { entry, sessionKey } of params.runtime.agent.session.listSessionEntries({
      agentId,
      readOnly: true,
    })) {
      const marker = readNodeSessionMarker(entry);
      const sessionId = entry.sessionId?.trim();
      if (
        !marker ||
        (marker.initializing === true && params.includeInitializing !== true) ||
        entry.initializationPending === true ||
        entry.agentHarnessId !== "codex" ||
        entry.modelSelectionLocked !== true ||
        !sessionId ||
        adoptionSessionKeyRest(sessionKey) !==
          nodeAdoptionSessionKey(marker.sourceHostId, marker.sourceThreadId) ||
        marker.sourceHostId !== `node:${marker.nodeId}`
      ) {
        continue;
      }
      const sourceKey = adoptedSourceKey(marker.sourceHostId, marker.sourceThreadId);
      if (adopted.has(sourceKey)) {
        throw new Error(
          `multiple OpenClaw sessions adopt Codex thread ${marker.sourceThreadId} on ${marker.sourceHostId}`,
        );
      }
      adopted.set(sourceKey, {
        key: sessionKey,
        sessionId,
        agentId,
        ...(marker.initializing === true ? { initializing: true } : {}),
      });
    }
  }
  return adopted;
}

export function findNodeAdoptedSessionEntry(params: {
  config: OpenClawConfig;
  runtime: PluginRuntime;
  hostId: string;
  threadId: string;
  includeInitializing?: boolean;
}): AdoptedSessionEntry | undefined {
  return listNodeAdoptedSessionEntries(params).get(
    adoptedSourceKey(params.hostId, params.threadId),
  );
}

export function nodeSessionMarker(params: {
  hostId: string;
  threadId: string;
  nodeId: string;
  initializing?: true;
}): CodexNodeSessionMarker {
  return {
    sourceHostId: params.hostId,
    sourceThreadId: params.threadId,
    nodeId: params.nodeId,
    ...(params.initializing === true ? { initializing: true } : {}),
  };
}

export async function finalizeNodeAdoptedSession(params: {
  api: OpenClawPluginApi;
  adopted: AdoptedSessionEntry;
  marker: CodexNodeSessionMarker;
}): Promise<void> {
  const changedError = () =>
    new CatalogParamsError("Codex OpenClaw session changed before it could be bound. Retry.");
  let finalized: CatalogSessionEntry | null;
  try {
    finalized = await params.api.runtime.agent.session.patchSessionEntry({
      sessionKey: params.adopted.key,
      readConsistency: "latest",
      preserveActivity: true,
      update: (entry) => {
        const current = readNodeSessionMarker(entry);
        if (
          entry.sessionId?.trim() !== params.adopted.sessionId ||
          entry.initializationPending === true ||
          entry.agentHarnessId !== "codex" ||
          entry.modelSelectionLocked !== true ||
          !current ||
          current.sourceHostId !== params.marker.sourceHostId ||
          current.sourceThreadId !== params.marker.sourceThreadId ||
          current.nodeId !== params.marker.nodeId
        ) {
          throw changedError();
        }
        if (current.initializing !== true) {
          return { archivedAt: undefined };
        }
        const codex = isRecord(entry.pluginExtensions?.codex) ? entry.pluginExtensions.codex : {};
        return {
          archivedAt: undefined,
          pluginExtensions: {
            ...entry.pluginExtensions,
            codex: { ...codex, sessionCatalog: params.marker },
          },
        };
      },
    });
  } catch (error) {
    const currentEntry = params.api.runtime.agent.session.getSessionEntry({
      sessionKey: params.adopted.key,
      readConsistency: "latest",
    });
    const current = currentEntry ? readNodeSessionMarker(currentEntry) : undefined;
    if (
      currentEntry?.sessionId?.trim() === params.adopted.sessionId &&
      current?.initializing !== true &&
      current?.sourceHostId === params.marker.sourceHostId &&
      current.sourceThreadId === params.marker.sourceThreadId &&
      current.nodeId === params.marker.nodeId
    ) {
      return;
    }
    throw error;
  }
  if (!finalized) {
    throw changedError();
  }
}

export async function createOrReuseNodeAdoptedSession(params: {
  api: OpenClawPluginApi;
  config: OpenClawConfig;
  hostId: string;
  nodeId: string;
  record: CodexSessionCatalogSession;
  history: CodexNodeHistory;
}): Promise<AdoptedSessionEntry> {
  const existing = findNodeAdoptedSessionEntry({
    config: params.config,
    runtime: params.api.runtime,
    hostId: params.hostId,
    threadId: params.record.threadId,
    includeInitializing: true,
  });
  if (existing) {
    return existing;
  }
  const marker = nodeSessionMarker({
    hostId: params.hostId,
    threadId: params.record.threadId,
    nodeId: params.nodeId,
  });
  const initializingMarker = { ...marker, initializing: true as const };
  try {
    const created = await params.api.runtime.agent.session.createSessionEntry({
      cfg: params.config,
      key: nodeAdoptionSessionKey(params.hostId, params.record.threadId),
      agentId: resolveDefaultAgentId(params.config),
      recoverMatchingInitialEntry: true,
      ...(params.record.name?.trim() ? { label: params.record.name.trim() } : {}),
      ...(params.record.cwd?.trim() ? { spawnedCwd: params.record.cwd.trim() } : {}),
      initialEntry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: {
            sessionCatalog: initializingMarker,
          },
        },
      },
      afterCreate: async (entry) => {
        const storePath = resolveStorePath(params.config.session?.store, {
          agentId: entry.agentId,
        });
        await importCodexThreadHistoryToTranscript({
          thread: params.history.thread,
          throughTurnId: params.history.throughTurnId,
          storePath,
          sessionId: entry.sessionId,
          sessionKey: entry.key,
          agentId: entry.agentId,
          ...(params.record.cwd?.trim() ? { cwd: params.record.cwd.trim() } : {}),
          modelProvider: params.record.modelProvider,
          config: params.config,
        });
        return { pluginExtensions: { codex: { sessionCatalog: initializingMarker } } };
      },
    });
    return {
      key: created.key,
      sessionId: created.sessionId,
      agentId: created.agentId,
      initializing: true,
    };
  } catch (error) {
    const raced = findNodeAdoptedSessionEntry({
      config: params.config,
      runtime: params.api.runtime,
      hostId: params.hostId,
      threadId: params.record.threadId,
      includeInitializing: true,
    });
    if (raced) {
      return raced;
    }
    throw error;
  }
}
