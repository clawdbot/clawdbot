/**
 * proof: a tool-less / light-context subagent that emits the BARE
 * `CONTINUE_WORK:N` token (no typed continue_work tool) self-elects another
 * turn end-to-end.
 *
 * The spawn-init / turn-1 path (`runAgentAttempt`) parses the token from the
 * run-result payloads, arms a durable `continuation_work` wake for the
 * subagent's OWN session, and the pure-decoupled work dispatcher re-drives the
 * same session via `getReplyFromConfig` with `continuationTrigger:"work-wake"`.
 * That re-drive IS hop-2 executing on the subagent session.
 *
 * This pins the token-form parity with the tool-form (the tool form is covered
 * by attempt-execution.continue-work-opts.test.ts). Without the token honoring
 * in runAgentAttempt's post-turn block a tool-less subagent could never claim
 * its own next turn.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTINUATION_WORK_CONTROLLER_ID } from "../../auto-reply/continuation/work-flow-state.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { listTaskFlowsForOwnerKey } from "../../tasks/task-flow-registry.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { runAgentAttempt } from "./attempt-execution.js";

const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const runCliAgentMock = vi.hoisted(() => vi.fn());
const getReplyFromConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));
vi.mock("../model-selection.js", () => ({
  isCliProvider: () => false,
  normalizeProviderId: (p: string) => p.trim().toLowerCase(),
}));
vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (p: string) => p.trim().toLowerCase(),
}));
vi.mock("../embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));
// Intercept the hop-2 re-drive so the test is deterministic: the work
// dispatcher calls getReplyFromConfig for the subagent session — that call IS
// the proof that hop-2 executes (it is the same entrypoint a normal inbound
// turn uses, which writes the turn to the session transcript).
vi.mock("../../auto-reply/reply/get-reply.js", () => ({
  getReplyFromConfig: getReplyFromConfigMock,
}));

const sessionKey = "agent:main:subagent:952-token";
const ACTIVE_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const INHERITED_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const ATTACKER_TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
const ACTIVE_TRACE_CONTEXT: DiagnosticTraceContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: "01",
};

function tokenRunResult(token: string): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: `final findings\n${token}` }],
    meta: {
      durationMs: 1,
      finalAssistantVisibleText: "final findings",
      agentMeta: {
        sessionId: "session-embedded",
        provider: "anthropic",
        model: "claude-sonnet-4.7",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    },
  } satisfies EmbeddedAgentRunResult;
}

describe("subagent CONTINUE_WORK token self-continuation (token-form parity)", () => {
  let tmpDir: string;
  let storePath: string;

  function cfgWithStore(delayMs = 0): OpenClawConfig {
    return {
      // Point driveContinuationTurn's SQLite-backed accessor at the temp store
      // so the re-drive resolves the subagent session.
      session: { store: storePath },
      agents: {
        defaults: {
          continuation: {
            enabled: true,
            maxChainLength: 200,
            // Most tests use zero delay; provenance tests keep the row queued.
            defaultDelayMs: delayMs,
            minDelayMs: delayMs,
            maxDelayMs: delayMs,
            costCapTokens: 50_000_000,
            maxDelegatesPerTurn: 500,
            maxPendingWork: 10,
          },
        },
      },
    } as unknown as OpenClawConfig;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc952-token-"));
    storePath = path.join(tmpDir, "sessions.json");
    runEmbeddedAgentMock.mockReset();
    getReplyFromConfigMock.mockReset();
    getReplyFromConfigMock.mockResolvedValue({ text: "hop-2 ran" });
    setRuntimeConfigSnapshot(cfgWithStore());
  });

  afterEach(async () => {
    const { resetContinuationWorkDispatchForTests } =
      await import("../../auto-reply/continuation/work-dispatch.js");
    const { resetTaskFlowRegistryForTests } =
      await import("../../tasks/task-runtime.test-helpers.js");
    resetContinuationWorkDispatchForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    resetSystemEventsForTest();
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runTurnOne(
    token: string,
    opts: Parameters<typeof runAgentAttempt>[0]["opts"] = {} as Parameters<
      typeof runAgentAttempt
    >[0]["opts"],
    cfg = cfgWithStore(),
  ) {
    const sessionEntry = { sessionId: "session-embedded", updatedAt: Date.now() } as SessionEntry;
    const sessionStore = { [sessionKey]: sessionEntry };
    expect(await upsertSessionEntry({ sessionKey, storePath }, sessionEntry)).not.toBeNull();
    clearSessionStoreCacheForTest();
    runEmbeddedAgentMock.mockResolvedValueOnce(tokenRunResult(token));
    return runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-sonnet-4.7",
      cfg,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      lifecycleGeneration: "g",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "do the work",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1000,
      runId: "run-952-token",
      opts,
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });
  }

  function readQueuedTraceState(): {
    traceparent?: string;
    traceparentProvenance?: string;
  } {
    const flow = listTaskFlowsForOwnerKey(sessionKey).find(
      (candidate) => candidate.controllerId === CONTINUATION_WORK_CONTROLLER_ID,
    );
    return (
      (flow?.stateJson as { traceparent?: string; traceparentProvenance?: string } | undefined) ??
      {}
    );
  }

  it("bare CONTINUE_WORK:N token arms a durable wake and re-drives the SAME subagent (hop-2 executes)", async () => {
    await runTurnOne("CONTINUE_WORK:1");

    // Let the post-turn scheduler arm + the (zero-delay) work timer fire.
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    // hop-2: the work dispatcher re-drove the subagent session through the
    // normal reply entrypoint with the work-wake trigger.
    expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
    const [ctxArg, optsArg] = expectDefined(
      getReplyFromConfigMock.mock.calls.at(0),
      "getReplyFromConfig call",
    );
    expect((ctxArg as { SessionKey?: string }).SessionKey).toBe(sessionKey);
    expect((optsArg as { continuationTrigger?: string }).continuationTrigger).toBe("work-wake");
  });

  it("does NOT re-drive when the final output carries no CONTINUE_WORK token", async () => {
    await runTurnOne("(all done)");

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
  });

  it("captures active internal trace context for spawn-init bracket work when opts are empty", async () => {
    await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      runTurnOne(
        `[[CONTINUE_DELEGATE: attacker context | traceparent=${ATTACKER_TRACEPARENT}]]\n[[CONTINUE_WORK:60]]`,
        {} as Parameters<typeof runAgentAttempt>[0]["opts"],
        cfgWithStore(60_000),
      ),
    );

    const { traceparent, traceparentProvenance } = readQueuedTraceState();
    expect(traceparent).toBe(ACTIVE_TRACEPARENT);
    expect(traceparentProvenance).toBe("internal");
    expect(traceparent).not.toBe(ATTACKER_TRACEPARENT);
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(traceparent).not.toContain("00000000000000000000000000000000");
    expect(traceparent).not.toContain("-0000000000000000-");
  });

  it("prefers inherited trusted opts traceparent over active context", async () => {
    await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      runTurnOne(
        "[[CONTINUE_WORK:60]]",
        { traceparent: INHERITED_TRACEPARENT } as Parameters<typeof runAgentAttempt>[0]["opts"],
        cfgWithStore(60_000),
      ),
    );

    const { traceparent, traceparentProvenance } = readQueuedTraceState();
    expect(traceparent).toBe(INHERITED_TRACEPARENT);
    expect(traceparentProvenance).toBe("internal");
    expect(traceparent).not.toBe(ACTIVE_TRACEPARENT);
  });
});
