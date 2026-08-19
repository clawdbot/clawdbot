import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Verifies quota suspension records recovery state without blocking shared work.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  patchSessionEntryCore: vi.fn(),
}));

vi.mock("../config/sessions/session-accessor.js", () => sessionAccessorMocks);

const sessionKeyResolverMocks = vi.hoisted(() => ({
  resolveStoredSessionKeyForSessionId: vi.fn(() => ({
    sessionKey: "session-key",
    storePath: "/tmp/openclaw-session-suspension-test/sessions.json",
  })),
}));

vi.mock("./command/session.js", () => sessionKeyResolverMocks);

async function recordSuspension(ttlMs = 100) {
  const { suspendSession } = await import("./session-suspension.js");
  await suspendSession({
    cfg: {} as OpenClawConfig,
    sessionId: "session-1",
    reason: "quota_exhausted",
    failedProvider: "openai",
    failedModel: "gpt-5.6-sol",
    ttlMs,
  });
}

describe("session suspension", () => {
  afterEach(async () => {
    const { resetSessionSuspensionStateForTest } =
      await import("./session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    resetCommandQueueStateForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionAccessorMocks.patchSessionEntryCore.mockReset();
    sessionKeyResolverMocks.resolveStoredSessionKeyForSessionId.mockClear();
  });

  it("records a bounded recovery marker without pausing the shared main lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) =>
      update({}),
    );

    await recordSuspension(Number.MAX_SAFE_INTEGER);

    const buildPatch = sessionAccessorMocks.patchSessionEntryCore.mock.calls[0]?.[1] as (_entry: {
      quotaSuspension?: unknown;
    }) => {
      quotaSuspension?: {
        expectedResumeBy?: number;
        failedProvider?: string;
        failedModel?: string;
        state?: string;
      };
    };
    expect(buildPatch({}).quotaSuspension).toEqual(
      expect.objectContaining({
        expectedResumeBy: 1_000 + MAX_TIMER_TIMEOUT_MS,
        failedProvider: "openai",
        failedModel: "gpt-5.6-sol",
        state: "suspended",
      }),
    );
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(1);
    await expect(
      enqueueCommandInLane(CommandLane.Main, async () => "unrelated-provider-ok"),
    ).resolves.toBe("unrelated-provider-ok");
  });

  it("keeps the shared lane runnable when marker persistence fails", async () => {
    sessionAccessorMocks.patchSessionEntryCore.mockRejectedValueOnce(new Error("disk busy"));

    await recordSuspension();

    await expect(enqueueCommandInLane(CommandLane.Main, async () => "still-runs")).resolves.toBe(
      "still-runs",
    );
  });

  it("resolves the session store with the explicit agent id, never the agentDir basename", async () => {
    const { suspendSession } = await import("./session-suspension.js");
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) =>
      update({}),
    );

    await suspendSession({
      cfg: {} as OpenClawConfig,
      agentId: "work",
      // Default layout: <state>/agents/<id>/agent — basename is always "agent".
      agentDir: "/state/agents/work/agent",
      sessionId: "session-1",
      reason: "quota_exhausted",
      failedProvider: "openai",
      failedModel: "gpt-5.6-sol",
    });

    expect(sessionKeyResolverMocks.resolveStoredSessionKeyForSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work" }),
    );
  });

  it("falls back to the registered agent-dir owner when no explicit agent id is given", async () => {
    const { suspendSession } = await import("./session-suspension.js");
    const { registerResolvedAgentDir, unregisterResolvedAgentDir } =
      await import("./agent-dir-registry.js");
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) =>
      update({}),
    );

    registerResolvedAgentDir({ agentId: "research", agentDir: "/state/agents/research/agent" });
    try {
      await suspendSession({
        cfg: {} as OpenClawConfig,
        agentDir: "/state/agents/research/agent",
        sessionId: "session-2",
        reason: "quota_exhausted",
        failedProvider: "openai",
        failedModel: "gpt-5.6-sol",
      });
    } finally {
      unregisterResolvedAgentDir({
        agentId: "research",
        agentDir: "/state/agents/research/agent",
      });
    }

    expect(sessionKeyResolverMocks.resolveStoredSessionKeyForSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research" }),
    );
  });

  it("rolls back a write that finishes after gateway shutdown begins", async () => {
    const { fenceSessionSuspensionWritesForGatewayShutdown } =
      await import("./session-suspension.js");
    let releaseWrite: (() => void) | undefined;
    let storeEntry: { quotaSuspension?: { suspendedAt: number } } = {};
    let writeCount = 0;
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) => {
      writeCount += 1;
      if (writeCount === 1) {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      }
      const patch = update(storeEntry) as typeof storeEntry | null;
      if (patch && "quotaSuspension" in patch) {
        storeEntry = patch.quotaSuspension ? { quotaSuspension: patch.quotaSuspension } : {};
      }
      return storeEntry;
    });

    const suspension = recordSuspension();
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf("function"));
    fenceSessionSuspensionWritesForGatewayShutdown();
    releaseWrite?.();
    await suspension;

    expect(storeEntry.quotaSuspension).toBeUndefined();
    expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledTimes(2);
  });

  it("blocks new state writes until gateway startup re-enables them", async () => {
    const {
      enableSessionSuspensionWritesForGatewayStart,
      fenceSessionSuspensionWritesForGatewayShutdown,
    } = await import("./session-suspension.js");
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) =>
      update({}),
    );

    fenceSessionSuspensionWritesForGatewayShutdown();
    await recordSuspension();
    expect(sessionAccessorMocks.patchSessionEntryCore).not.toHaveBeenCalled();

    enableSessionSuspensionWritesForGatewayStart();
    await recordSuspension();
    expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledOnce();
  });

  it("defers only the outer fallback candidate's marker", async () => {
    const { resolveSessionSuspensionTarget, runWithDeferredSessionSuspension } =
      await import("./session-suspension.js");
    const onDeferred = vi.fn();

    expect(resolveSessionSuspensionTarget()).toEqual({ mode: "suspend" });
    await runWithDeferredSessionSuspension(async () => {
      const target = resolveSessionSuspensionTarget();
      expect(target.mode).toBe("defer");
      if (target.mode === "defer") {
        target.defer({
          cfg: {},
          sessionId: "session-1",
          reason: "quota_exhausted",
          failedProvider: "openai",
          failedModel: "gpt-5.6-sol",
        });
      }
      expect(resolveSessionSuspensionTarget()).toEqual({ mode: "suspend" });
    }, onDeferred);

    expect(onDeferred).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "session-1", failedProvider: "openai" }),
    );
    expect(resolveSessionSuspensionTarget()).toEqual({ mode: "suspend" });
  });

  it("maps failover reasons to persisted suspension reasons", async () => {
    const { resolveSessionSuspensionReason } = await import("./session-suspension.js");

    expect(resolveSessionSuspensionReason("rate_limit")).toBe("quota_exhausted");
    expect(resolveSessionSuspensionReason("billing")).toBe("manual");
    expect(resolveSessionSuspensionReason("overloaded")).toBe("circuit_open");
    expect(resolveSessionSuspensionReason("timeout")).toBe("circuit_open");
    expect(resolveSessionSuspensionReason("auth")).toBe("circuit_open");
  });
});
