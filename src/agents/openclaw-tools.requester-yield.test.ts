// Regression tests for requester yield claims: isolated automation (cron)
// requesters must never record yield intent (#135282). sessions_yield is not
// assembled for them at all (the documented effective-tool contract stays
// truthful), and the lifecycle-boundary rejection remains as a backstop for
// any future re-introduction path. The registry-backed tests exercise the real
// production registry with no mocks: the completion-required child row is the
// exact state that the pre-fix claim path accepted (proven by the control test
// below).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { markRequesterTurnYieldedInRuns } from "./subagents/registry/subagent-registry-requester-yield.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";

// Mirrors the production constant in openclaw-tools.requester-yield.ts, which
// stays module-local so the public tool surface does not grow (#135282).
const ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR =
  "Isolated automation turns do not support sessions_yield because no continuation owner resumes this session. Keep required child work bounded in this turn; spawned descendants deliver output through the scheduler-owned completion wait.";

const CRON_RUN_KEY = "agent:main:cron:daily-report:run:run-42";

// The reported #135282 state: a running, completion-required child whose
// completion is owned by the isolated automation turn. `expectsCompletionMessage`
// is what markRequesterTurnYieldedInRuns selects on, so this fixture — and only
// this shape — reproduces the pre-fix accepted-yield failure.
function seedCompletionRequiredCronChild(): void {
  addSubagentRunForTests({
    runId: "run-child",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: CRON_RUN_KEY,
    requesterAgentId: "main",
    requesterTurnRunId: "run-requester",
    requesterDisplayKey: "cron:daily-report",
    task: "child work",
    cleanup: "keep",
    createdAt: 1_000,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
    execution: { status: "running" },
  });
}

function createTestOpenClawTools(
  options: NonNullable<Parameters<typeof createOpenClawTools>[0]> = {},
) {
  return createOpenClawTools({
    ...options,
    config: {
      ...options.config,
      agents: options.config?.agents ?? { entries: { main: { default: true } } },
    } satisfies OpenClawConfig,
  });
}

describe("createRequesterYieldCallback isolated automation rejection", () => {
  it("rejects a cron requester with the unsupported-lifecycle error", async () => {
    const registry = await import("./subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);

    try {
      const claim = createRequesterYieldCallback({
        requesterSessionKey: CRON_RUN_KEY,
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
      });

      expect(await claim?.()).toEqual({
        error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR,
      });
      expect(markRequesterTurnYielded).not.toHaveBeenCalled();
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });

  it("rejects a cron requester even when no other claim source exists", async () => {
    const claim = createRequesterYieldCallback({
      requesterSessionKey: "agent:main:cron:daily-report",
      requesterAgentId: "main",
    });

    expect(await claim?.()).toEqual({
      error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR,
    });
  });

  it("still records yield intent for an ordinary requester", async () => {
    const registry = await import("./subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);

    try {
      const claim = createRequesterYieldCallback({
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
      });

      await expect(claim?.()).resolves.toBe(true);
      expect(markRequesterTurnYielded).toHaveBeenCalledExactlyOnceWith({
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
      });
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});

describe("sessions_yield isolated automation ownership", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  // Control experiment: this exact fixture is the state the pre-fix claim path
  // accepted. If this stops holding, the regression test below would pass for
  // the wrong reason (an unclaimable row), so pin the claimability here.
  it("marks the completion-required cron child as the pre-fix accepted-yield state", () => {
    seedCompletionRequiredCronChild();
    const childRun = getSubagentRunByRunId("run-child") as SubagentRunRecord;
    expect(childRun.expectsCompletionMessage).toBe(true);

    const marked = markRequesterTurnYieldedInRuns({
      requesterSessionKey: CRON_RUN_KEY,
      requesterAgentId: "main",
      requesterTurnRunId: "run-requester",
      runs: new Map([[childRun.runId, childRun]]),
      persistOrThrow: () => {},
    });

    expect(marked).toBe(1);
    expect(childRun.requesterTurnYielded).toBe(true);
  });

  // Real registry, real tool assembly, no mocks: the isolated automation turn
  // owns a genuinely pending completion-required child, and the unsupported
  // yield capability must not even be assembled, leaving the run record free
  // of any yield intent or settle-wake state.
  it("does not assemble sessions_yield for an isolated automation requester and records no yield intent", () => {
    seedCompletionRequiredCronChild();

    const tools = createTestOpenClawTools({
      agentSessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: CRON_RUN_KEY,
      sessionId: "cron-requester-session",
      runId: "run-requester",
      onYield: async () => undefined,
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("sessions_yield");

    const childRun = getSubagentRunByRunId("run-child");
    expect(childRun).toBeDefined();
    // The turn still owns its pending child completion; no durable yield intent
    // or settle-wake handoff may exist because the capability is absent.
    expect(childRun?.requesterTurnYielded).toBeUndefined();
    expect(childRun?.requesterSettleWake).toBeUndefined();
    expect(childRun?.requesterTurnRunId).toBe("run-requester");
    expect(childRun?.execution.status).toBe("running");
  });

  it("does not assemble sessions_yield when only the controller session key is cron", () => {
    const tools = createTestOpenClawTools({
      agentSessionKey: "agent:main:cron:daily-report",
      sessionId: "cron-controller-session",
      runId: "run-requester",
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("sessions_yield");
  });

  // Ordinary yield flows are unchanged: interactive and subagent requesters
  // keep the documented waiting capability.
  it.each([
    "agent:main:telegram:default:direct:1234",
    "agent:main:subagent:worker",
    "agent:main:main",
  ])("still assembles sessions_yield for requester %s", (agentSessionKey) => {
    const tools = createTestOpenClawTools({
      agentSessionKey,
      sessionId: "requester-session",
      runId: "run-requester",
      onYield: async () => undefined,
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });

    expect(tools.map((tool) => tool.name)).toContain("sessions_yield");
  });
});
