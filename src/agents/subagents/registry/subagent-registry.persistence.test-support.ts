/**
 * Test helpers for subagent registry persistence scenarios. They seed minimal
 * SQLite-backed session entries and runtime dependency mocks without loading
 * the production embedded-agent stack.
 */
import path from "node:path";
import { vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SessionStore = Record<string, Record<string, unknown>>;
export type SubagentRunFixture = Omit<SubagentRunRecord, "execution"> & {
  execution?: SubagentRunRecord["execution"];
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
};

function resolveSubagentSessionStorePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

/** Expands shorthand test records into the canonical nested persistence shape. */
export function createCanonicalSubagentRunFixture(run: SubagentRunFixture): SubagentRunRecord {
  const { startedAt, endedAt, outcome, ...record } = run;
  const terminal = typeof endedAt === "number";
  return {
    ...record,
    execution:
      run.execution ??
      (terminal
        ? { status: "terminal", startedAt, endedAt, outcome }
        : { status: "running", startedAt }),
    completion: run.completion ?? { required: run.expectsCompletionMessage === true },
    delivery: run.delivery ?? {
      status:
        run.expectsCompletionMessage === false
          ? "not_required"
          : terminal
            ? "pending"
            : "not_required",
    },
  };
}

export function canonicalSubagentRunFixtures(
  runs: ReadonlyMap<string, SubagentRunFixture>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs].map(([runId, run]) => [runId, createCanonicalSubagentRunFixture(run)]));
}

export function createFailedLaunchCleanupOwnerFixture(): SubagentRunRecord {
  return {
    runId: "run-failed-launch-owner",
    childSessionKey: "agent:main:subagent:failed-launch-owner",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "persist exact cleanup ownership",
    cleanup: "delete",
    createdAt: 1,
    execution: { status: "queued" },
    launchCleanupPending: true,
    launchCleanupSessionOutcome: "deleted",
    acceptedRunTermination: {
      kind: "launch",
      phase: "termination-pending",
      gatewayRunId: "gateway-failed-launch-owner",
      lifecycleGeneration: "generation-1",
      expectedSessionId: "session-1",
      expectedLifecycleRevision: "revision-1",
    },
    attachmentsSandboxIdentity: {
      backendId: "ssh",
      runtimeId: "runtime-1",
      fsCleanupLocator: {
        version: 1,
        backend: "ssh",
        settings: {
          command: "ssh",
          target: "host.example",
          workspaceRoot: "/remote/openclaw",
          strictHostKeyChecking: true,
          updateHostKeys: false,
        },
        generation: "0123456789abcdef0123456789abcdef",
        runtimeRootDir: "/remote/openclaw/runtime-1",
      },
    },
  };
}

export function createPersistedEndedRunFixture(params: {
  runId: string;
  childSessionKey: string;
  task: string;
  cleanup: "keep" | "delete";
}) {
  const now = Date.now();
  return {
    version: 2,
    runs: {
      [params.runId]: {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: params.task,
        cleanup: params.cleanup,
        createdAt: now - 2,
        startedAt: now - 1,
        endedAt: now,
      },
    },
  };
}

/** Reads test session entries through the active SQLite accessor. */
export async function readSubagentSessionStore(storePath: string): Promise<SessionStore> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  ) as unknown as SessionStore;
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
    loadAgentRuntimePluginRegistryHandle: vi.fn(),
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
