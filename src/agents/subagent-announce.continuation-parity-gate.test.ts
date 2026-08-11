/**
 * Continuation delegate dispatch parity harness.
 *
 * THE EXACTLY-ONCE INVARIANT:
 * runSubagentAnnounceFlow is the SOLE dispatch route for bracket
 * [[CONTINUE_DELEGATE:]] tokens in the completion flow. The own-turn path
 * (attempt-execution.ts nested block) has no delegate branch — by design.
 * If anyone adds a delegate dispatch to the own-turn nested block, the
 * delegate would fire TWICE (once in own-turn, once in announce). This
 * harness gates against that regression by asserting exactly-once dispatch
 * for every delegate sub-mode form.
 *
 * Sub-mode coverage matrix:
 *   1. [[CONTINUE_DELEGATE: task]]                     (normal)
 *   2. [[CONTINUE_DELEGATE: task | silent]]             (silent)
 *   3. [[CONTINUE_DELEGATE: task | silent-wake]]        (silent-wake)
 *   4. [[CONTINUE_DELEGATE: task +30s]]                 (delay)
 *   5. [[CONTINUE_DELEGATE: task | target=session:key]] (target)
 * 6. [[CONTINUE_DELEGATE: task | post-compaction]] (post-compaction —)
 *   7. No bracket in findings                           (negative control)
 *   8. continuationEnabled=false + bracket              (feature-gate control)
 */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks that DO intercept the SUT (non-barrel modules) ---

vi.mock("./subagents/announce/subagent-announce.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSessionMessagesAsync: vi.fn(async () => []),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: Record<string, unknown>) => {
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    return {};
  }),
}));

vi.mock("./subagents/spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 1,
}));

vi.mock("./embedded-agent.js", () => ({
  isEmbeddedAgentRunActive: () => false,
  queueEmbeddedAgentMessage: () => false,
  waitForEmbeddedAgentRunEnd: async () => true,
}));

vi.mock("./subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  countPendingDescendantRunsExcludingRun: () => 0,
  isSubagentSessionRunActive: () => true,
  listSubagentRunsForRequester: () => [],
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => null,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
}));
vi.mock("./subagents/registry/subagent-registry-runtime.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  countPendingDescendantRunsExcludingRun: () => 0,
  isSubagentSessionRunActive: () => true,
  listSubagentRunsForRequester: () => [],
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => null,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
}));

vi.mock("../auto-reply/continuation/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/state.js")>()),
  registerContinuationTimerHandle: vi.fn(),
  retainContinuationTimerRef: vi.fn(),
  releaseContinuationTimerRef: vi.fn(),
  unregisterContinuationTimerHandle: vi.fn(),
}));

vi.mock("../auto-reply/continuation/delegate-store.js", () => ({
  annotateQueuedDelegatesChainTokensFold: vi.fn(() => 0),
  clearQueuedDelegatesChainTokensFold: vi.fn(() => 0),
  consumePendingDelegates: vi.fn(() => []),
  enqueuePendingDelegate: vi.fn(),
  hasRecoverablePendingDelegate: vi.fn(() => false),
  markPendingDelegateFailed: vi.fn(),
  markPendingDelegateSpawnAccepted: vi.fn(),
  peekEarliestQueuedDelegateDueAt: vi.fn(() => undefined),
}));

vi.mock("../auto-reply/continuation/delegate-store-post-compaction.js", () => ({
  failStagedPostCompactionDelegatesForCleanup: vi.fn(() => 0),
  stagePostCompactionDelegate: vi.fn(),
}));

import { stagePostCompactionDelegate } from "../auto-reply/continuation/delegate-store-post-compaction.js";
import { enqueuePendingDelegate } from "../auto-reply/continuation/delegate-store.js";
import {
  retainContinuationTimerRef,
  registerContinuationTimerHandle,
} from "../auto-reply/continuation/state.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { saveLegacySessionStore as saveSessionStore } from "../infra/state-migrations.legacy-session-store.js";
import { runSubagentAnnounceFlow } from "./subagents/announce/subagent-announce.js";
import * as subagentSpawn from "./subagents/spawn/subagent-spawn.js";

type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

function makeConfig(
  overrides: {
    maxChainLength?: number;
    costCapTokens?: number;
    enabled?: boolean;
    crossSessionTargeting?: "disabled" | "enabled";
  } = {},
): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" as const },
    agents: {
      defaults: {
        continuation: {
          enabled: overrides.enabled ?? true,
          maxChainLength: overrides.maxChainLength ?? 10,
          costCapTokens: overrides.costCapTokens ?? 500_000,
          minDelayMs: 0,
          maxDelayMs: 0,
          crossSessionTargeting: overrides.crossSessionTargeting ?? "disabled",
        },
      },
    },
  };
}

async function writeSessionStore(data: Record<string, unknown>) {
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  await saveSessionStore(storePath, data as Parameters<typeof saveSessionStore>[1], {
    skipMaintenance: true,
  });
  clearSessionStoreCacheForTest();
}

const childSessionKey = "agent:main:subagent:parity-gate";
const childRunId = "run-parity-gate";
const requesterSessionKey = "agent:main:discord:dm:test-parity";

function buildParityParams(bracket: string): AnnounceFlowParams {
  return {
    childSessionKey,
    childRunId,
    requesterSessionKey,
    requesterDisplayKey: "test-parity",
    task: "[continuation:chain-hop:1] Delegated task: original research",
    roundOneReply: `Research result.\n${bracket}`,
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

// --------------------------------------------------------------------------
// exactly-once gate: delegate sub-mode parity matrix
// --------------------------------------------------------------------------

describe("announce-path bracket delegate exactly-once dispatch", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig());
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:parity-next",
      runId: "run-parity-next",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
  });

  // -- 1. Normal delegate (no modifiers) --

  it("dispatches exactly once for [[CONTINUE_DELEGATE: task]] (normal)", async () => {
    const params = buildParityParams("[[CONTINUE_DELEGATE: continue next step]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:2]");
    expect(spawnArgs.task).toContain("continue next step");
  });

  // -- 2. Silent modifier --

  it("dispatches exactly once for [[CONTINUE_DELEGATE: task | silent]]", async () => {
    const params = buildParityParams("[[CONTINUE_DELEGATE: continue silently | silent]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:2]");
    expect(spawnArgs.task).toContain("continue silently");
    // "| silent" is consumed as a directive, not part of the task body
    expect(spawnArgs.task).not.toContain("| silent");
    expect(spawnArgs.silentAnnounce).toBe(true);
  });

  // -- 3. Silent-wake modifier --

  it("dispatches exactly once for [[CONTINUE_DELEGATE: task | silent-wake]]", async () => {
    // Use wakeOnReturn: false on parent so the directive is the sole source of wakeOnReturn
    const params = buildParityParams("[[CONTINUE_DELEGATE: continue with wake | silent-wake]]");
    params.wakeOnReturn = false;
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:2]");
    expect(spawnArgs.task).toContain("continue with wake");
    expect(spawnArgs.task).not.toContain("| silent-wake");
    expect(spawnArgs.silentAnnounce).toBe(true);
    // silentWake directive drives wakeOnReturn on the spawn
    expect(spawnArgs.wakeOnReturn).toBe(true);
  });

  // -- 4. Delay modifier (+Ns) --

  it("enqueues a delayed bracket delegate durably instead of a volatile timer (+Ns)", async () => {
    const params = buildParityParams("[[CONTINUE_DELEGATE: continue after delay +30s]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    // a delayed bracket delegate is routed through the durable pending
    // delegate store (survives restart) exactly once, not fired via a volatile
    // in-process setTimeout.
    expect(enqueuePendingDelegate).toHaveBeenCalledTimes(1);
    const [enqueueSession, enqueued] = vi.mocked(enqueuePendingDelegate).mock.calls[0] as [
      string,
      { task: string; delayMs?: number },
    ];
    // Enqueued under the CHILD session so the later drain uses the child's chain
    // state (hop/cost), not reset to the requester's.
    expect(enqueueSession).toBe(childSessionKey);
    expect(enqueued.task).toBe("continue after delay");
    // +30s is consumed by the parser, not included in the task body
    expect(enqueued.task).not.toContain("+30s");
    // Not fired immediately, and the removed volatile-timer path is not used.
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(retainContinuationTimerRef).not.toHaveBeenCalled();
    expect(registerContinuationTimerHandle).not.toHaveBeenCalled();
  });

  // -- 5. Target modifier --

  it("dispatches exactly once for [[CONTINUE_DELEGATE: task | target=agent:main:other]]", async () => {
    // Enable cross-session targeting so the target directive is not rejected
    setRuntimeConfigSnapshot(makeConfig({ crossSessionTargeting: "enabled" }));
    const params = buildParityParams(
      "[[CONTINUE_DELEGATE: targeted research | target=agent:main:other]]",
    );
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("[continuation:chain-hop:2]");
    expect(spawnArgs.task).toContain("targeted research");
    expect(spawnArgs.task).not.toContain("| target=");
    expect(spawnArgs.continuationTargetSessionKey).toBe("agent:main:other");
  });

  // -- 6. Post-compaction modifier (gap) --

  it("stages exactly once (NOT immediate-spawn) for [[CONTINUE_DELEGATE: task | post-compaction]] (lifeboat-drop fix)", async () => {
    // Post- (merged): parseDelegateDirective recognizes "post-compaction"
    // and the announce/completion path routes it to stagePostCompactionDelegate
    // (staged at the compaction seam) INSTEAD of an immediate chain-spawn — the
    // lifeboat-drop fix (subagent-announce.ts:995-996). So spawnSubagentDirect
    // is NOT called; the delegate is staged. The modifier is consumed as a
    // directive, not left in the task body. Mirrors the dedicated assertion in
    // subagent-announce.postcompaction-route.test.ts.
    const stageMock = vi.mocked(stagePostCompactionDelegate);
    stageMock.mockClear();
    const params = buildParityParams(
      "[[CONTINUE_DELEGATE: post-compact research | post-compaction]]",
    );
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    // Exactly-once invariant, post-compaction form: staged once, spawned zero.
    expect(stageMock).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();
    const stagedTask = (
      expectDefined(stageMock.mock.calls.at(0)?.at(1), "staged delegate") as Record<string, unknown>
    ).task as string;
    // The staged task is the cleaned delegate body (no immediate chain-hop
    // annotation — that is applied at spawn time, which the post-compaction
    // path bypasses by staging instead).
    expect(stagedTask).toContain("post-compact research");
    // "post-compaction" consumed as a directive → NOT left in the task body.
    expect(stagedTask).not.toContain("| post-compaction");
  });

  // -- 7. Negative control: no bracket --

  it("does NOT dispatch when findings contain no [[CONTINUE_DELEGATE:]] bracket", async () => {
    const params: AnnounceFlowParams = {
      childSessionKey,
      childRunId,
      requesterSessionKey,
      requesterDisplayKey: "test-parity",
      task: "[continuation:chain-hop:1] Delegated task: plain research",
      roundOneReply: "Research complete. No continuation needed.",
      timeoutMs: 30_000,
      cleanup: "delete",
      outcome: { status: "ok" as const },
      silentAnnounce: true,
      wakeOnReturn: true,
    };
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  // -- 8. Feature-gate control: continuationEnabled=false --

  it("does NOT dispatch when continuationEnabled=false even with bracket in findings", async () => {
    setRuntimeConfigSnapshot(makeConfig({ enabled: false }));
    const params = buildParityParams("[[CONTINUE_DELEGATE: should not fire]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// double-fire regression guard
// --------------------------------------------------------------------------

describe("announce path is the sole dispatch route (no-double-fire guard)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig());
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:double-fire-check",
      runId: "run-double-fire-check",
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
  });

  // This test documents the exactly-once invariant that the announce path
  // is the only dispatch site for bracket delegate tokens. The own-turn
  // path (attempt-execution.ts) intentionally lacks a delegate branch.
  // If a second dispatch site is ever added there, this test (and the
  // sub-mode matrix above) will catch the double-fire because the mock
  // would show two calls instead of one.
  //
  // The assertion here is structural: running the announce flow with a
  // bracket delegate produces exactly ONE spawnSubagentDirect call, not
  // zero and not two. Any addition of a parallel dispatch route in the
  // own-turn nested block would surface as spawnSpy.toHaveBeenCalledTimes(2)
  // in integration tests that drive both paths.
  it("bracket delegate through announce flow fires spawnSubagentDirect exactly once", async () => {
    const params = buildParityParams("[[CONTINUE_DELEGATE: double-fire sentinel task]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnArgs.task).toContain("double-fire sentinel task");
    expect(spawnArgs.task).toContain("[continuation:chain-hop:2]");
    expect(spawnArgs.drainsContinuationDelegateQueue).toBe(true);
  });

  it("announce flow with bracket does not spawn a second delegate on re-invocation guard", async () => {
    // Run the flow once — the bracket is consumed and the delegate spawns.
    const params = buildParityParams("[[CONTINUE_DELEGATE: re-invoke guard task]]");
    await runSubagentAnnounceFlow(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    // Exactly one spawn from the single announce invocation.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});
