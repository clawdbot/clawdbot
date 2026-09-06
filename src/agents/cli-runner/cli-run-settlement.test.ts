/** Tests native CLI continuity projection and bounded transcript-flush probing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import {
  isCliBindingFlushed,
  restoreCliRunnerTestDeps,
  setCliRunnerTestDeps,
} from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "../cli-session.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../tools/turn-send-ledger.js";
import {
  buildBlockedCliRunResult,
  buildCliRunResult,
  settlePreparedCliRun,
} from "./cli-run-settlement.js";
import type { PreparedCliRunContext } from "./types.js";

describe("isCliBindingFlushed", () => {
  const workspaceDir = "/tmp/openclaw-workspace";

  beforeEach(() => {
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  it("returns false when no sessionId is provided", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed(undefined, "claude-cli")).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true when the transcript has content on the first probe", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-fresh", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({ sessionId: "sid-fresh", workspaceDir });
  });

  it("retries up to three times before giving up", async () => {
    const delay = vi.fn(async () => undefined);
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-cold", "claude-cli", workspaceDir)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 50);
    expect(delay).toHaveBeenNthCalledWith(2, 150);
  });

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    const delay = vi.fn(async () => undefined);
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 2;
    });
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-late", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    vi.useFakeTimers();
    try {
      // Fake timers enforce the retry contract without introducing wall-clock
      // sleeps into this import-heavy agent test.
      const probe = vi.fn(async () => false);
      setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

      const settled = vi.fn();
      const errored = vi.fn();
      isCliBindingFlushed("sid-bounded", "claude-cli", workspaceDir).then(settled, errored);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(150);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toBe(false);
      expect(errored).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("returns true without probing for non-claude-cli providers", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-codex", "codex-cli")).toBe(true);
    expect(await isCliBindingFlushed("sid-anthropic", "anthropic")).toBe(true);
    expect(await isCliBindingFlushed("sid-openai", "openai")).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when provider is undefined", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-x", undefined)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when the caller owns continuity outside native transcripts", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-warm", "claude-cli", workspaceDir, {
        skipTranscriptProbe: true,
      }),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("still probes when transcript-probe skipping is disabled", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-probe", "claude-cli", workspaceDir, {
        skipTranscriptProbe: false,
      }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("CLI native continuity projection", () => {
  it.each(["blocked", "no-native-id", "native", "stateless"])(
    "projects only explicit native continuity from a %s result",
    (kind) => {
      const context = buildPreparedCliRunContext({ provider: "claude-cli" });
      const result =
        kind === "blocked"
          ? buildBlockedCliRunResult({
              context,
              message: "Blocked by the test policy",
              preparedContextAgentMeta: {},
              sessionBindingDisabled: false,
            })
          : buildCliRunResult({
              context,
              output: { text: "done" },
              effectiveCliSessionId: kind === "native" ? "next-native-session" : undefined,
              bindingFlushOk: kind !== "no-native-id",
              usedHistoryPrompt: false,
              userTurnHandled: true,
              sessionBindingDisabled: kind === "stateless",
              preparedContextAgentMeta: {},
            });
      const entry: SessionEntry = {
        sessionId: context.params.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "previous-native-session" } },
      };

      applyCliSessionBindingResult(entry, "claude-cli", result.meta.agentMeta);

      expect(entry.sessionId).toBe(context.params.sessionId);
      expect(result.meta.agentMeta?.sessionId).toBe(
        kind === "native" ? "next-native-session" : context.params.sessionId,
      );
      expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe(
        kind === "native"
          ? "next-native-session"
          : kind === "stateless"
            ? undefined
            : "previous-native-session",
      );
    },
  );
});

describe("settlePreparedCliRun per-turn send ledger terminal cleanup", () => {
  // Mirrors the exact slot the loopback message/conversations_send tools write under
  // for a direct CLI run: buildCliMcpGrantContext forwards agentId + canonical
  // sessionKey + runId, and prepare stashes them as context.turnSendLedgerScope.
  const agentId = "main";
  const grantSessionKey = "agent:main:main";
  const targetKey = "imessage default +15550001111";
  const ledgerSessionKey = buildTurnSendLedgerSessionKey(agentId, grantSessionKey)!;

  beforeEach(() => {
    resetTurnSendLedgerForTest();
  });
  afterEach(() => {
    resetTurnSendLedgerForTest();
  });

  // A landed send committed by the message tool during the run, keyed exactly as
  // the tool keys it for this (session, run) pair.
  function commitSend(runId: string): number {
    const key = { sessionKey: ledgerSessionKey, runId, targetKey };
    const reserved = reserveTurnSend(key, {});
    if (reserved.status !== "reserved") {
      throw new Error(`expected a reserved send, got "${reserved.status}"`);
    }
    return commitTurnSend(reserved.reservation);
  }

  function makeContext(params: {
    runId: string;
    isFinalFallbackAttempt?: boolean | "omit";
    withScope?: boolean;
    effectiveAuthProfileId?: string;
    authProfileStore?: AuthProfileStore;
  }): PreparedCliRunContext {
    const scope = { agentId, sessionKey: grantSessionKey, runId: params.runId };
    // Cron forwards isFinalFallbackAttempt to every CLI candidate, so it defaults to a
    // terminal candidate here; "omit" models an embedded/command-rpc dispatched candidate
    // (run-entry.ts owns that terminal) or a tool-less direct run.
    const finalFallback = params.isFinalFallbackAttempt ?? true;
    // SAFETY: settlePreparedCliRun reads only params.{cleanup*, sessionId, provider,
    // runId, isFinalFallbackAttempt}, turnSendLedgerScope, and — when the auth-profile
    // settlement path is exercised — context.{effectiveAuthProfileId, authProfileStore,
    // agentDir, modelId}; the rest of the prepared context is unused.
    return {
      params: {
        cleanupCliLiveSessionOnRunEnd: false,
        cleanupBundleMcpOnRunEnd: false,
        sessionId: "session-1",
        provider: "claude-cli",
        runId: params.runId,
        ...(finalFallback === "omit" ? {} : { isFinalFallbackAttempt: finalFallback }),
      },
      started: 0,
      modelId: "opus",
      ...(params.effectiveAuthProfileId
        ? { effectiveAuthProfileId: params.effectiveAuthProfileId }
        : {}),
      ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
      ...(params.withScope === false ? {} : { turnSendLedgerScope: scope }),
    } as unknown as PreparedCliRunContext;
  }

  const okResult = { payloads: [], meta: {} } as unknown as EmbeddedAgentRunResult;

  it("clears the committed slot when a direct CLI run succeeds", async () => {
    const runId = "run-success";
    commitSend(runId);
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);

    await settlePreparedCliRun({
      context: makeContext({ runId }),
      run: async () => okResult,
    });

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("clears on an early success that ends a multi-candidate cron chain", async () => {
    // isFinalFallbackAttempt === false but the run succeeded, so runWithModelFallback
    // stops here: this candidate is the true terminal and must release the budget.
    const runId = "run-early-success";
    commitSend(runId);

    await settlePreparedCliRun({
      context: makeContext({ runId, isFinalFallbackAttempt: false }),
      run: async () => okResult,
    });

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("clears the committed slot when a direct CLI run throws at its terminal", async () => {
    const runId = "run-error";
    commitSend(runId);
    const failure = new Error("cli run failed");

    await expect(
      settlePreparedCliRun({
        context: makeContext({ runId, isFinalFallbackAttempt: true }),
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("does NOT clear when a non-final fallback candidate fails mid-turn", async () => {
    const runId = "run-fallback";
    commitSend(runId);
    const failure = new Error("candidate failed, another remains");

    await expect(
      settlePreparedCliRun({
        // isFinalFallbackAttempt === false: runWithModelFallback will run another
        // candidate that reuses this runId; the budget must survive to it.
        context: makeContext({ runId, isFinalFallbackAttempt: false }),
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
  });

  // A run success drives the auth-profile settlement branch, which is not wrapped in
  // the cleanup try/catch: if it throws, settlement exits exceptionally even though
  // the run itself succeeded (runError stays undefined). Terminal cleanup must gate on
  // that real exceptional exit, not on runError.
  const successResult = {
    payloads: [],
    meta: { executionTrace: { attempts: [{ result: "success" }] } },
  } as unknown as EmbeddedAgentRunResult;

  function throwingAuthProfileStore(): AuthProfileStore {
    return {
      get profiles(): Record<string, unknown> {
        throw new Error("auth-profile settlement failed");
      },
    } as unknown as AuthProfileStore;
  }

  it("does NOT clear when a non-final candidate succeeds but auth-profile settlement throws", async () => {
    // The run succeeded (runError === undefined) yet settlement exits exceptionally.
    // A pre-fix gate of `runError !== undefined` would read threw === false and wipe
    // this non-final candidate's committed counts mid-chain.
    const runId = "run-settle-throw-nonfinal";
    commitSend(runId);

    await expect(
      settlePreparedCliRun({
        context: makeContext({
          runId,
          isFinalFallbackAttempt: false,
          effectiveAuthProfileId: "profile-1",
          authProfileStore: throwingAuthProfileStore(),
        }),
        run: async () => successResult,
      }),
    ).rejects.toThrow("auth-profile settlement failed");

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
  });

  it("clears when a final candidate succeeds but auth-profile settlement throws", async () => {
    // Same exceptional exit, but this is the chain's terminal (isFinalFallbackAttempt
    // === true), so the slot is released for the reused runId's next turn.
    const runId = "run-settle-throw-final";
    commitSend(runId);

    await expect(
      settlePreparedCliRun({
        context: makeContext({
          runId,
          isFinalFallbackAttempt: true,
          effectiveAuthProfileId: "profile-1",
          authProfileStore: throwingAuthProfileStore(),
        }),
        run: async () => successResult,
      }),
    ).rejects.toThrow("auth-profile settlement failed");

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("defers cleanup for a dispatched candidate whose outer runner owns the terminal", async () => {
    // Embedded/command-rpc CLI dispatch does not forward isFinalFallbackAttempt; the
    // embedded runner's fallback-chain finally (run-entry.ts) clears the slot after the
    // whole chain, so settlement must not clear it here even on success.
    const runId = "run-dispatched";
    commitSend(runId);

    await settlePreparedCliRun({
      context: makeContext({ runId, isFinalFallbackAttempt: "omit" }),
      run: async () => okResult,
    });

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
  });

  it("repeated runs reusing one runId each start with an empty budget", async () => {
    // Isolated cron reuses its durable session id as the runId (run-executor.ts), so
    // turn 2 must not inherit turn 1's committed counts once turn 1's terminal clears.
    const runId = "cron-durable-session";
    const budgetAtStartOfTurn: number[] = [];

    for (let turn = 0; turn < 2; turn += 1) {
      await settlePreparedCliRun({
        context: makeContext({ runId }),
        run: async () => {
          budgetAtStartOfTurn.push(
            peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey }),
          );
          commitSend(runId);
          return okResult;
        },
      });
    }

    expect(budgetAtStartOfTurn).toEqual([0, 0]);
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("clears exactly the run's slot, not a sibling run or session slot", async () => {
    const runId = "run-target";
    const siblingRunId = "run-sibling";
    const otherSessionKey = buildTurnSendLedgerSessionKey(agentId, "agent:main:other")!;
    commitSend(runId);
    commitSend(siblingRunId);
    // A concurrent run on a different session keyed independently.
    const otherReserved = reserveTurnSend({ sessionKey: otherSessionKey, runId, targetKey }, {});
    if (otherReserved.status === "reserved") {
      commitTurnSend(otherReserved.reservation);
    }

    await settlePreparedCliRun({
      context: makeContext({ runId }),
      run: async () => okResult,
    });

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
    // A distinct runId on the same session — an independent live turn — is untouched.
    expect(
      peekTurnSendCount({ sessionKey: ledgerSessionKey, runId: siblingRunId, targetKey }),
    ).toBe(1);
    // A distinct session slot is untouched.
    expect(peekTurnSendCount({ sessionKey: otherSessionKey, runId, targetKey })).toBe(1);
  });
});
