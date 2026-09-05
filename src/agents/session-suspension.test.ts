import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Verifies quota suspension records recovery state without blocking shared work.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { QuotaSuspension } from "../config/sessions/types.js";
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

  it.each([
    {
      name: "the previous marker",
      previousQuotaSuspension: {
        schemaVersion: 1,
        suspendedAt: 100,
        reason: "manual",
        failedProvider: "previous-provider",
        failedModel: "previous-model",
        summary: "previous briefing",
        snapshotRef: "previous-snapshot",
        laneId: "previous-lane",
        expectedResumeBy: 500,
        state: "resuming",
      } satisfies QuotaSuspension,
    },
    { name: "an absent marker", previousQuotaSuspension: undefined },
  ])(
    "restores $name when a committed write finishes after shutdown",
    async ({ previousQuotaSuspension }) => {
      const { fenceSessionSuspensionWritesForGatewayShutdown } =
        await import("./session-suspension.js");
      const committed = createDeferred();
      const releaseWrite = createDeferred();
      let storeEntry: { quotaSuspension?: QuotaSuspension } = {
        quotaSuspension: previousQuotaSuspension,
      };
      let writeCount = 0;
      sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) => {
        writeCount += 1;
        const patch = update(storeEntry) as typeof storeEntry | null;
        if (patch && "quotaSuspension" in patch) {
          storeEntry = patch.quotaSuspension ? { quotaSuspension: patch.quotaSuspension } : {};
        }
        if (writeCount === 1) {
          committed.resolve();
          await releaseWrite.promise;
        }
        return storeEntry;
      });

      const suspension = recordSuspension();
      await committed.promise;
      try {
        expect(storeEntry.quotaSuspension).toMatchObject({
          reason: "quota_exhausted",
          failedProvider: "openai",
          failedModel: "gpt-5.6-sol",
          state: "suspended",
        });
        fenceSessionSuspensionWritesForGatewayShutdown();
      } finally {
        releaseWrite.resolve();
        await suspension;
      }

      expect(storeEntry.quotaSuspension).toEqual(previousQuotaSuspension);
      expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledTimes(2);
    },
  );

  it("serializes same-session writes until the previous committed write returns", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const committed = createDeferred();
    const releaseWrite = createDeferred();
    let storeEntry: { quotaSuspension?: QuotaSuspension } = {};
    let writeCount = 0;
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) => {
      writeCount += 1;
      const patch = update(storeEntry) as typeof storeEntry | null;
      if (patch) {
        storeEntry = { ...storeEntry, ...patch };
      }
      if (writeCount === 1) {
        committed.resolve();
        await releaseWrite.promise;
      }
      return storeEntry;
    });

    const first = recordSuspension();
    await committed.promise;
    clock.mockReturnValue(2_000);
    const second = recordSuspension(200);
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledOnce();
      expect(storeEntry.quotaSuspension?.suspendedAt).toBe(1_000);
    } finally {
      releaseWrite.resolve();
      await Promise.all([first, second]);
    }

    expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledTimes(2);
    expect(storeEntry.quotaSuspension).toMatchObject({
      suspendedAt: 2_000,
      expectedResumeBy: 2_200,
      failedProvider: "openai",
      failedModel: "gpt-5.6-sol",
      state: "suspended",
    });
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
