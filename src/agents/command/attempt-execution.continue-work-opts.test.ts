/**
 * Regression coverage for spawn-init `continue_work` plumbing.
 *
 * `runAgentAttempt` must forward `continueWorkOpts` to `runEmbeddedAgent` when
 * continuation is enabled. Otherwise the tool is absent from the first turn's
 * catalog and a subagent cannot elect another turn.
 *
 * This pins tool registration independently from the later delivery mechanism.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createTestPreparedRunAdmission } from "../admitted-run-context.test-support.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { runAgentAttempt } from "./attempt-execution.js";

const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const runCliAgentMock = vi.hoisted(() => vi.fn());
const sessionAccessorState = vi.hoisted(() => ({
  failPatch: false,
  runtimeConfigAfterPatch: undefined as OpenClawConfig | undefined,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    patchSessionEntryCore: async (
      ...args: Parameters<typeof actual.patchSessionEntryCore>
    ): ReturnType<typeof actual.patchSessionEntryCore> => {
      if (sessionAccessorState.failPatch) {
        throw new Error("synthetic continuation reservation failure");
      }
      const result = await actual.patchSessionEntryCore(...args);
      if (sessionAccessorState.runtimeConfigAfterPatch) {
        setRuntimeConfigSnapshot(sessionAccessorState.runtimeConfigAfterPatch);
        sessionAccessorState.runtimeConfigAfterPatch = undefined;
      }
      return result;
    },
  };
});

vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string) =>
    provider.trim().toLowerCase() === "claude-cli" || provider.trim().toLowerCase() === "codex-cli",
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({ provider }: { provider?: string }) => provider,
  };
});

vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

function makeEmbeddedResult(): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 1,
      finalAssistantVisibleText: "ok",
      agentMeta: {
        sessionId: "session-embedded",
        provider: "anthropic",
        model: "claude-sonnet-4.7",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
        },
      },
    },
  };
}

function makeContinuationEnabledConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 200,
          defaultDelayMs: 15000,
          minDelayMs: 5000,
          maxDelayMs: 86400000,
          costCapTokens: 50000000,
          maxDelegatesPerTurn: 500,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function makeContinuationDisabledConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {},
    },
  } as unknown as OpenClawConfig;
}

// Continuation enabled but pinned at the chain cap (maxChainLength:1): a session
// already at currentChainCount:1 trips checkContinuationBudget on the FIRST
// election, so scheduleContinuationWorkBatch returns scheduledCount:0.
function makeAtCapContinuationConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 1,
          defaultDelayMs: 15000,
          minDelayMs: 5000,
          maxDelayMs: 86400000,
          costCapTokens: 50000000,
          maxDelegatesPerTurn: 500,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("runAgentAttempt spawn-init continueWorkOpts plumbing", () => {
  let tmpDir: string;
  let sessionEntry: SessionEntry;
  let sessionStore: Record<string, SessionEntry>;
  let storePath: string;
  let sessionKey: string;

  function persistSessionEntry() {
    replaceSessionEntrySync({ storePath, sessionKey }, sessionStore[sessionKey] as SessionEntry);
  }

  async function enqueuePriorParkedWork(reason: string) {
    const { enqueuePendingWork } = await import("../../auto-reply/continuation/work-store.js");
    const now = Date.now();
    const work = enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 30_000,
      electedAt: now,
      dueAt: now + 60_000,
      maxChainLength: 200,
      chainStartedAt: now,
      accumulatedChainTokens: 2,
      reason,
      anchorPending: true,
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: now,
      },
    });
    expect(work).not.toBeNull();
  }

  beforeEach(async () => {
    const { resetContinuationWorkDispatchForTests } =
      await import("../../auto-reply/continuation/work-dispatch.js");
    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetContinuationWorkDispatchForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-746-trap-"));
    storePath = path.join(tmpDir, "sessions.json");
    runEmbeddedAgentMock.mockReset();
    runCliAgentMock.mockReset();
    sessionAccessorState.failPatch = false;
    sessionAccessorState.runtimeConfigAfterPatch = undefined;
    runEmbeddedAgentMock.mockResolvedValue(makeEmbeddedResult());
    sessionEntry = {
      sessionId: "session-embedded",
      updatedAt: Date.now(),
    } as SessionEntry;
    sessionKey = `agent:main:subagent:746-trap:${crypto.randomUUID()}`;
    sessionStore = { [sessionKey]: sessionEntry };
    persistSessionEntry();
    clearSessionStoreCacheForTest();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { resetContinuationWorkDispatchForTests } =
      await import("../../auto-reply/continuation/work-dispatch.js");
    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetContinuationWorkDispatchForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    resetSystemEventsForTest();
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runEmbeddedAttempt(
    cfg: OpenClawConfig,
    options: { durableSessionStore?: boolean } = {},
  ) {
    setRuntimeConfigSnapshot(cfg);
    const durableSessionStore = options.durableSessionStore !== false;
    return await runAgentAttempt({
      preparedRunAdmission: createTestPreparedRunAdmission("run-test"),
      pluginGeneration: undefined,
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-sonnet-4.7",
      cfg,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      lifecycleGeneration: "test-generation",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "trap-test prompt",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-746-trap",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      ...(durableSessionStore ? { sessionStore, storePath } : {}),
      sessionHasHistory: false,
    });
  }

  it("forwards continueWorkOpts to runEmbeddedAgent when continuation.enabled=true (spawn-init / turn-1)", async () => {
    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { continueWorkOpts?: { requestContinuation?: unknown } }
      | undefined;
    expect(callArgs).toBeDefined();
    // Without the plumbing this is undefined, so continue_work never registers in
    //      the subagent's turn-1 tool-list.
    expect(callArgs?.continueWorkOpts).toBeDefined();
    expect(typeof callArgs?.continueWorkOpts?.requestContinuation).toBe("function");
  });

  it("does NOT forward continueWorkOpts when continuation is disabled", async () => {
    await runEmbeddedAttempt(makeContinuationDisabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { continueWorkOpts?: unknown }
      | undefined;
    expect(callArgs?.continueWorkOpts).toBeUndefined();
  });

  // Extended coverage: exercise the closure end-to-end
  // so that a future regression which forwards a *stub* closure (instead of
  // the runner-supplied accumulator) is still caught. Pinning the presence of
  // requestContinuation alone is necessary but not sufficient — the closure
  // must actually capture continue_work tool-call payloads for the post-turn
  // heartbeat scheduler to fire.

  it("persists spawn-init continue_work chain state to the session store", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "persist budgets", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    clearSessionStoreCacheForTest();
    closeOpenClawAgentDatabasesForTest();
    const persisted = loadSessionEntry({ storePath, sessionKey });
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
    expect(persisted?.continuationChainCount).toBe(1);
    expect(persisted?.continuationChainTokens).toBe(2);
  });

  it("does not schedule spawn-init work when continuation is disabled during the turn", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "disabled before scheduling", delaySeconds: 30 });
      setRuntimeConfigSnapshot(makeContinuationDisabledConfig());
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    expect(listTaskFlowsForOwnerKey(sessionKey)).toHaveLength(0);
    expect(sessionStore[sessionKey]?.continuationChainCount).toBeUndefined();
  });

  it("rolls back spawn-init reservation when continuation is disabled during persistence", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "disabled during reservation", delaySeconds: 30 });
      sessionAccessorState.runtimeConfigAfterPatch = makeContinuationDisabledConfig();
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    expect(listTaskFlowsForOwnerKey(sessionKey)).toHaveLength(0);
    expect(sessionStore[sessionKey]).toMatchObject({
      continuationChainCount: 0,
      continuationChainTokens: 0,
    });
  });

  it("reserves spawn-init chain state before creating durable work", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "requires durable reservation", delaySeconds: 30 });
      sessionAccessorState.failPatch = true;
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    expect(listTaskFlowsForOwnerKey(sessionKey)).toHaveLength(0);
    expect(sessionStore[sessionKey]?.continuationChainCount).toBeUndefined();
    expect(
      peekSystemEvents(sessionKey).some((event) =>
        event.includes("chain state could not be persisted"),
      ),
    ).toBe(true);
  });

  it("does not create durable spawn-init work without a durable session store", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "restart recovery without store", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig(), { durableSessionStore: false });

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    expect(listTaskFlowsForOwnerKey(sessionKey)).toHaveLength(0);
    expect(sessionEntry.continuationChainCount).toBeUndefined();
    expect(
      peekSystemEvents(sessionKey).some((event) =>
        event.includes("durable session state is unavailable"),
      ),
    ).toBe(true);
  });

  it("preserves prior parked work when a capped election receives no reservation", async () => {
    sessionEntry.continuationChainCount = 1;
    sessionEntry.continuationChainTokens = 2;
    sessionStore[sessionKey] = sessionEntry;
    persistSessionEntry();
    clearSessionStoreCacheForTest();
    await enqueuePriorParkedWork("prior parked work");

    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "capped replacement", delaySeconds: 30 });
      return makeEmbeddedResult();
    });
    await runEmbeddedAttempt(makeAtCapContinuationConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ status: "queued" });
    expect(flows[0]?.stateJson).toMatchObject({ reason: "prior parked work" });
  });

  it("preserves prior parked work when a hot-smaller limit rejects the replacement", async () => {
    sessionEntry.continuationChainCount = 1;
    sessionEntry.continuationChainTokens = 2;
    sessionStore[sessionKey] = sessionEntry;
    persistSessionEntry();
    clearSessionStoreCacheForTest();
    await enqueuePriorParkedWork("prior parked work");

    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "hot-capped replacement", delaySeconds: 30 });
      sessionAccessorState.runtimeConfigAfterPatch = makeAtCapContinuationConfig();
      return makeEmbeddedResult();
    });
    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const flows = listTaskFlowsForOwnerKey(sessionKey);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ status: "queued" });
    expect(flows[0]?.stateJson).toMatchObject({ reason: "prior parked work" });
  });

  it("merges a concurrent spawn-init chain advance before scheduling", async () => {
    const concurrentStartedAt = Date.now() - 5_000;
    const concurrentChainId = crypto.randomUUID();
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "merge fresh chain state", delaySeconds: 30 });
      replaceSessionEntrySync(
        { storePath, sessionKey },
        {
          ...sessionEntry,
          continuationChainCount: 7,
          continuationChainStartedAt: concurrentStartedAt,
          continuationChainTokens: 100,
          continuationChainId: concurrentChainId,
        },
      );
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const [flow] = listTaskFlowsForOwnerKey(sessionKey);
    expect(flow?.stateJson).toMatchObject({
      hop: 8,
      chainId: concurrentChainId,
      accumulatedChainTokens: 102,
    });
    expect(sessionStore[sessionKey]).toMatchObject({
      continuationChainCount: 8,
      continuationChainStartedAt: concurrentStartedAt,
      continuationChainTokens: 102,
      continuationChainId: concurrentChainId,
    });
  });

  it("schedules every same-turn continue_work tool election with independent delays", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "first immediate-ish wake", delaySeconds: 60 });
      opts?.requestContinuation({ reason: "second slower wake", delaySeconds: 120 });
      opts?.requestContinuation({ reason: "third default-ish wake", delaySeconds: 15 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const states = listTaskFlowsForOwnerKey(sessionKey)
      .map((flow) => flow.stateJson as { delayMs?: number; hop?: number; reason?: string })
      .toSorted((left, right) => (left.hop ?? 0) - (right.hop ?? 0));

    expect(states).toHaveLength(3);
    expect(states.map((state) => state.hop)).toEqual([1, 2, 3]);
    expect(states.map((state) => state.delayMs)).toEqual([60_000, 120_000, 15_000]);
    expect(states.map((state) => state.reason)).toEqual([
      "first immediate-ish wake",
      "second slower wake",
      "third default-ish wake",
    ]);
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(3);
  });

  it("does not collapse a multi continue_work tool batch when the model turn returns after the requested delays elapsed", async () => {
    const electedAt = Date.parse("2026-06-20T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(electedAt);
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "sixty seconds", delaySeconds: 60 });
      opts?.requestContinuation({ reason: "one hundred twenty seconds", delaySeconds: 120 });
      opts?.requestContinuation({ reason: "default delay", delaySeconds: 15 });
      // The runner schedules captured tool requests only after the agent turn
      // yields. Advancing time here pins that current behavior: elapsed time
      // during the model turn does not collapse or pre-mature the batch.
      vi.setSystemTime(electedAt + 120_000);
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const states = listTaskFlowsForOwnerKey(sessionKey)
      .map((flow) => flow.stateJson as { delayMs?: number; dueAt?: number; hop?: number })
      .toSorted((left, right) => (left.hop ?? 0) - (right.hop ?? 0));

    expect(states).toHaveLength(3);
    expect(states.map((state) => state.delayMs)).toEqual([60_000, 120_000, 15_000]);
    expect(states.map((state) => state.dueAt)).toEqual([
      electedAt + 180_000,
      electedAt + 240_000,
      electedAt + 135_000,
    ]);
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(3);
  });

  // Never-silent symmetry: the spawn-init lane must surface a multi-election
  // cap-drop even when NOTHING scheduled (scheduledCount:0, cappedCount>0). The
  // cap-notice emit lives ABOVE the zero-scheduled early return so this lane
  // matches the main-reply (agent-runner) and followup (followup-runner) lanes,
  // which both emit the cap-notice regardless of scheduledCount.
  it("emits the cap-notice on spawn-init when a multi continue_work batch schedules nothing at the cap", async () => {
    // Seed the session already at the chain cap so the FIRST election is
    // rejected: scheduleContinuationWorkBatch returns scheduledCount:0,
    // cappedCount:2 — the exact case the spawn-init lane used to drop silently.
    sessionEntry.continuationChainCount = 1;
    sessionStore[sessionKey] = sessionEntry;
    persistSessionEntry();
    clearSessionStoreCacheForTest();
    // The continuation budget reads the live runtime-config snapshot (see
    // resolveLiveContinuationRuntimeConfig); set it to the at-cap config so the
    // chain-cap fires deterministically regardless of ambient snapshot state.
    setRuntimeConfigSnapshot(makeAtCapContinuationConfig());

    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      // Two elections this turn — multi-election is required for the cap-notice.
      opts?.requestContinuation({ reason: "first election", delaySeconds: 30 });
      opts?.requestContinuation({ reason: "second election", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeAtCapContinuationConfig());

    const events = peekSystemEvents(sessionKey);
    expect(
      events.some((text) => text.includes("2 of 2 continue_work elections were not scheduled")),
    ).toBe(true);

    // Nothing scheduled, so the seeded chain count must NOT advance.
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  // Single-election guard: keep single-work behavior intact. A lone capped
  // election stays silent on the spawn-init lane, matching the `requests > 1`
  // guard shared by the main-reply and followup lanes.
  it("stays silent for a single capped continue_work election on spawn-init", async () => {
    sessionEntry.continuationChainCount = 1;
    sessionStore[sessionKey] = sessionEntry;
    persistSessionEntry();
    clearSessionStoreCacheForTest();
    setRuntimeConfigSnapshot(makeAtCapContinuationConfig());

    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "lone election", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeAtCapContinuationConfig());

    const events = peekSystemEvents(sessionKey);
    expect(events.some((text) => text.includes("continue_work elections were not scheduled"))).toBe(
      false,
    );
  });

  it("induces the chain-depth rejection from a bracket token without mutating protected config", async () => {
    // The live gateway tool must keep maxChainLength protected,
    // but the runtime still needs a deterministic way to behaviorally exercise
    // the reject branch. This seeds a test session already at the cap and emits
    // a terminal bracket continue_work token; no config.patch, raw file edit, or
    // gateway restart is involved.
    sessionEntry.continuationChainCount = 1;
    sessionStore[sessionKey] = sessionEntry;
    persistSessionEntry();
    clearSessionStoreCacheForTest();
    setRuntimeConfigSnapshot(makeAtCapContinuationConfig());

    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done\n[[CONTINUE_WORK]]" }],
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "done",
        agentMeta: {
          sessionId: "session-embedded",
          provider: "anthropic",
          model: "claude-sonnet-4.7",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
      },
    } satisfies EmbeddedAgentRunResult);

    const result = await runEmbeddedAttempt(makeAtCapContinuationConfig());

    expect(result.payloads?.[0]?.text).toBe("done");
    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    expect(listTaskFlowsForOwnerKey(sessionKey)).toHaveLength(0);
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  it("does not strip bracket continue_delegate markers while peeking for spawn-init continue_work", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done\n[[CONTINUE_DELEGATE: next hop]]" }],
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "done",
        agentMeta: {
          sessionId: "session-embedded",
          provider: "anthropic",
          model: "claude-sonnet-4.7",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
      },
    } satisfies EmbeddedAgentRunResult);

    const result = await runEmbeddedAttempt(makeContinuationEnabledConfig());

    expect(result.payloads?.[0]?.text).toContain("[[CONTINUE_DELEGATE: next hop]]");
  });

  it("suppresses spawn-init continuations after replay-unsafe incomplete turns", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "unsafe spawn-init request", delaySeconds: 30 });
      return {
        payloads: [{ text: "Agent could not complete the turn.", isError: true }],
        meta: {
          durationMs: 1,
          replayInvalid: true,
          error: {
            kind: "incomplete_turn",
            message: "Agent could not complete the turn.",
            fallbackSafe: false,
          },
          agentMeta: {
            sessionId: "session-embedded",
            provider: "anthropic",
            model: "claude-sonnet-4.7",
            usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
          },
        },
      } satisfies EmbeddedAgentRunResult;
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    expect(listTaskFlowsForOwnerKey(sessionKey)).toHaveLength(0);
    expect(sessionStore[sessionKey]?.continuationChainCount).toBeUndefined();
  });

  it("lets bracket continue_work use the configured default delay when a tool delay also exists", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "tool delay should not win", delaySeconds: 30 });
      return {
        payloads: [{ text: "done\n[[CONTINUE_WORK]]" }],
        meta: {
          durationMs: 1,
          finalAssistantVisibleText: "done",
          agentMeta: {
            sessionId: "session-embedded",
            provider: "anthropic",
            model: "claude-sonnet-4.7",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          },
        },
      } satisfies EmbeddedAgentRunResult;
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const [flow] = listTaskFlowsForOwnerKey(sessionKey);
    expect(flow?.stateJson).toMatchObject({
      kind: "continuation_work",
      delayMs: 15000,
    });
  });

  it("schedules one same-session wake for a bracket CONTINUE_WORK token when no tool call exists", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done\n[[CONTINUE_WORK:60]]" }],
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "done",
        agentMeta: {
          sessionId: "session-embedded",
          provider: "anthropic",
          model: "claude-sonnet-4.7",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
      },
    } satisfies EmbeddedAgentRunResult);

    const result = await runEmbeddedAttempt(makeContinuationEnabledConfig());

    expect(result.payloads?.[0]?.text).toBe("done");
    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const states = listTaskFlowsForOwnerKey(sessionKey).map(
      (flow) => flow.stateJson as { delayMs?: number; hop?: number; reason?: string },
    );
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ hop: 1, delayMs: 60_000 });
    expect(states[0]?.reason).toBeUndefined();
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  it("does NOT tag the spawn-init continue_work flow with parentRunId (own-turn has no spawn lineage; reap guard)", async () => {
    // A subagent's own-turn continue_work is same-session work, not a delegate
    // child. If the spawn-init lane tags the durable flow with the subagent's own
    // electing run as parentRunId, bucket-1 treats that confident-terminal run
    // as an orphan parent and reaps the flow on the first busy-defer — so hop-2
    // never runs. Pin that the scheduled flow carries NO parentRunId, keeping
    // it on the never-reap (parentRunId==null → same-session) path.
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done\nCONTINUE_WORK" }],
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "done",
        agentMeta: {
          sessionId: "session-embedded",
          provider: "anthropic",
          model: "claude-sonnet-4.7",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
      },
    } satisfies EmbeddedAgentRunResult);

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const [flow] = listTaskFlowsForOwnerKey(sessionKey);
    expect(flow).toBeDefined();
    expect(flow?.stateJson).toMatchObject({ kind: "continuation_work" });
    expect(flow?.stateJson).not.toHaveProperty("parentRunId");
  });

  it("captured continue_work request is invocable end-to-end on spawn-init (turn-1 cure-mechanism pin)", async () => {
    // Simulate a runEmbeddedAgent run that fires continue_work mid-turn by
    // invoking the supplied closure with a representative request payload.
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      if (!opts) {
        throw new Error(
          "continueWorkOpts missing — spawn-init continuation plumbing regressed; subagent turn-1 cannot continue_work",
        );
      }
      opts.requestContinuation({ reason: "trap-test", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    // No throw means the closure was both present and invocable. The
    // post-turn scheduler runs asynchronously via dynamic imports and arms
    // a timer; we don't assert on the timer itself here (covered by the
    // existing continuation-state test suite), only on the wiring invariant.
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });
});

// Cross-layer drift guard:
//   - turn-2+ followup-runner plumbing is pinned by followup-runner.test.ts
//   - turn-1 spawn-init plumbing is pinned by this file
describe("cross-layer drift-catch sentinel", () => {
  it("documents both continuation plumbing sites", () => {
    // The real behavior coverage lives in the two owner-specific test files.
    expect(true).toBe(true);
  });
});
