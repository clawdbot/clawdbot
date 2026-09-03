/**
 * Test helpers for subagent registry persistence scenarios. They seed minimal
 * SQLite-backed session entries and runtime dependency mocks without loading
 * the production embedded-agent stack.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SessionStore = Record<string, Record<string, unknown>>;

export function expectDeferredSubagentAnnouncement(
  entry: SubagentRunRecord | undefined,
  runId: string,
) {
  expect(entry, "deferred announcement committed").toMatchObject({
    cleanupHandled: false,
    delivery: { status: "pending", attemptCount: 1, payload: { childRunId: runId } },
  });
  expect(entry?.cleanupCompletedAt, "deferred cleanup remains unfinished").toBeUndefined();
  expect(Number.isFinite(entry?.delivery?.nextAttemptAt), "durable retry deadline").toBe(true);
}

/** Hold the real lazy settlement dependency without replacing its completion policy. */
export function gateSubagentRequesterSettlement(
  settle: SubagentRegistryDeps["maybeWakeRequesterAfterAllChildrenSettled"],
) {
  const released = createDeferred();
  let pending: Promise<boolean> | undefined;
  const run = vi.fn<SubagentRegistryDeps["maybeWakeRequesterAfterAllChildrenSettled"]>((params) => {
    pending = (async () => {
      await released.promise;
      return await settle(params);
    })();
    return pending;
  });
  return {
    run,
    async release() {
      released.resolve();
      await pending;
    },
  };
}

/** Gates owned by a test must be released before waiting for imports and detached tails. */
export async function settleSubagentRegistryPersistenceWork() {
  await vi.dynamicImportSettled();
  await vi.waitFor(() =>
    expect(getActiveGatewayRootWorkCount(), "residual registry roots").toBe(0),
  );
}

type PersistenceCleanup = {
  stateDir: string;
  resetRegistry: () => void;
  resetDeps: () => void;
  closeDatabases?: () => void | Promise<void>;
};

export async function cleanupSubagentRegistryPersistenceTest(params: PersistenceCleanup) {
  await settleSubagentRegistryPersistenceWork();
  params.resetRegistry();
  await cleanupSessionStateForTest({ stateDir: params.stateDir });
  await params.closeDatabases?.();
  params.resetDeps();
  await fs.rm(params.stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Finish fixture-owned writes before withEnvAsync restores their database location. */
export async function withSubagentRegistryPersistenceState<T>(
  params: PersistenceCleanup,
  run: () => Promise<T>,
): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: params.stateDir }, async () => {
    try {
      return await run();
    } finally {
      await cleanupSubagentRegistryPersistenceTest(params);
    }
  });
}

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
  lifecycleRevision?: string;
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
    ...(params.lifecycleRevision ? { lifecycleRevision: params.lifecycleRevision } : {}),
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
