/**
 * Test helpers for subagent registry persistence scenarios. They seed minimal
 * SQLite-backed session entries and runtime dependency mocks without loading
 * the production embedded-agent stack.
 */
import path from "node:path";
import { vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";

type SessionStore = Record<string, Record<string, unknown>>;

function resolveSubagentSessionStorePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

/** Reads test session entries through the active SQLite accessor. */
export async function readSubagentSessionStore(storePath: string): Promise<SessionStore> {
  return Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  ) as SessionStore;
}

/** Writes or updates one SQLite-backed subagent session entry for persistence tests. */
export async function writeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  sessionId?: string;
  updatedAt?: number;
  abortedLastRun?: boolean;
  agentId: string;
  defaultSessionId: string;
}): Promise<string> {
  const storePath = resolveSubagentSessionStorePath(params.stateDir, params.agentId);
  const current = loadSessionEntry({ storePath, sessionKey: params.sessionKey });
  const entry: SessionEntry = {
    ...current,
    sessionId: params.sessionId ?? params.defaultSessionId,
    updatedAt: params.updatedAt ?? Date.now(),
    ...(typeof params.abortedLastRun === "boolean"
      ? { abortedLastRun: params.abortedLastRun }
      : {}),
  };
  await replaceSessionEntry({ storePath, sessionKey: params.sessionKey }, entry);
  return storePath;
}

/** Removes one SQLite-backed subagent session entry for persistence tests. */
export async function removeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  agentId: string;
}): Promise<string> {
  const storePath = resolveSubagentSessionStorePath(params.stateDir, params.agentId);
  await applySessionEntryLifecycleMutation({
    storePath,
    removals: [{ sessionKey: params.sessionKey }],
    skipMaintenance: true,
  });
  return storePath;
}

/** Builds default dependency mocks used by subagent registry persistence tests. */
export function createSubagentRegistryTestDeps(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
    captureSubagentCompletionReply: vi.fn(async () => undefined),
    ensureContextEnginesInitialized: vi.fn(),
    ensureRuntimePluginsLoaded: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    getGatewayRecoveryRuntime: vi.fn(() => ({
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    })),
    resolveAgentTimeoutMs: vi.fn(() => 100),
    resolveContextEngine: vi.fn(async () => ({
      info: { id: "test", name: "Test", version: "0.0.1" },
      ingest: vi.fn(async () => ({ ingested: false })),
      assemble: vi.fn(async ({ messages }) => ({ messages, estimatedTokens: 0 })),
      compact: vi.fn(async () => ({ ok: false, compacted: false })),
    })),
    ...extra,
  };
}
