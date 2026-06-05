/**
 * Test helpers for subagent registry persistence scenarios. They create
 * minimal session-store files and runtime dependency mocks without loading
 * the production embedded-agent stack.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

type SessionStore = Record<string, Record<string, unknown>>;

function resolveSubagentSessionStorePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

/** Reads a test session-store JSON file, returning an empty store on missing/invalid input. */
export async function readSubagentSessionStore(storePath: string): Promise<SessionStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SessionStore;
    }
  } catch {
    // ignore
  }
  return {};
}

/** Writes or updates one subagent session-store entry for persistence tests. */
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
  const store = await readSubagentSessionStore(storePath);
  store[params.sessionKey] = {
    ...store[params.sessionKey],
    sessionId: params.sessionId ?? params.defaultSessionId,
    updatedAt: params.updatedAt ?? Date.now(),
    ...(typeof params.abortedLastRun === "boolean"
      ? { abortedLastRun: params.abortedLastRun }
      : {}),
  };
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, "utf8");
  return storePath;
}

/** Removes one subagent session-store entry for persistence tests. */
export async function removeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  agentId: string;
}): Promise<string> {
  const storePath = resolveSubagentSessionStorePath(params.stateDir, params.agentId);
  const store = await readSubagentSessionStore(storePath);
  delete store[params.sessionKey];
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, "utf8");
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
