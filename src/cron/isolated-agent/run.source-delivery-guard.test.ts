import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { CronJob } from "../types.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  clearFastTestEnv,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
  resolveCronDeliveryPlanMock,
} from "./run.test-harness.js";

const actualDeliveryPlanModule =
  await vi.importActual<typeof import("../delivery-plan.js")>("../delivery-plan.js");
const { createCronPromptExecutor, executeCronRun } = await import("./run-executor.js");
const { resolveCronSourceDeliveryPlan, resolveFallbackCronSourceDeliveryPlan } =
  await import("./source-delivery-fallback.js");

const emptySkillsSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkills: [],
  version: 1,
};

function makeJob(
  params: {
    delivery?: CronJob["delivery"];
    omitDelivery?: boolean;
    sessionTarget?: CronJob["sessionTarget"];
  } = {},
): CronJob {
  return {
    id: "source-delivery-guard",
    name: "Source Delivery Guard",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: params.sessionTarget ?? "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...(params.omitDelivery ? {} : { delivery: params.delivery ?? { mode: "none" } }),
    state: {},
  } as CronJob;
}

function makeExecutor(overrides: Partial<Parameters<typeof createCronPromptExecutor>[0]>) {
  const resolvedDelivery = overrides.resolvedDelivery ?? {};

  return createCronPromptExecutor({
    cfg: {},
    cfgWithAgentDefaults: {},
    job: makeJob(),
    agentId: "default",
    agentDir: "/tmp/agent-dir",
    agentSessionKey: "cron:source-delivery-guard",
    runSessionKey: "cron:source-delivery-guard:run:test-session-id",
    workspaceDir: "/tmp/workspace",
    resolvedVerboseLevel: "off",
    thinkLevel: undefined,
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
    skillsSnapshot: emptySkillsSnapshot,
    agentPayload: null,
    useSubagentFallbacks: false,
    liveSelection: {
      provider: "openai",
      model: "gpt-5.4",
    },
    cronSession: makeCronSession() as MutableCronSession,
    abortReason: () => "aborted",
    resolvedDeliveryOk: true,
    messageToolPromptEnabled: true,
    ...overrides,
    resolvedDelivery,
  });
}

function getEmbeddedRunArg(): Record<string, unknown> {
  const call = runEmbeddedAgentMock.mock.calls[0];
  if (!call) {
    throw new Error("expected runEmbeddedAgent to be called");
  }
  return call[0] as Record<string, unknown>;
}

describe("resolveFallbackCronSourceDeliveryPlan", () => {
  beforeEach(() => {
    resolveCronDeliveryPlanMock.mockReset();
    resolveCronDeliveryPlanMock.mockImplementation(
      actualDeliveryPlanModule.resolveCronDeliveryPlan,
    );
  });

  it('rebuilds delivery.mode "none" with no owner and unforced message tool', () => {
    const plan = resolveFallbackCronSourceDeliveryPlan(makeJob({ delivery: { mode: "none" } }), {
      channel: "messagechat",
      to: "room-1",
      accountId: "acct-1",
      threadId: "thread-1",
      ok: true,
    });

    expect(plan.owner).toBe("none");
    expect(plan.reason).toBe("cron_none");
    expect(plan.messageTool.enabled).toBe(true);
    expect(plan.messageTool.force).toBe(false);
    expect(plan.fallback.directDelivery).toBe(false);
    expect(plan.target).toEqual({
      channel: "messagechat",
      to: "room-1",
      accountId: "acct-1",
      threadId: "thread-1",
    });
  });

  it('rebuilds delivery.mode "announce" with direct fallback and unforced message tool', () => {
    const plan = resolveFallbackCronSourceDeliveryPlan(
      makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "room-1" } }),
      {
        channel: "messagechat",
        to: "room-1",
        ok: true,
      },
    );

    expect(plan.owner).toBe("direct_fallback");
    expect(plan.reason).toBe("cron_announce");
    expect(plan.messageTool.enabled).toBe(true);
    expect(plan.messageTool.force).toBe(false);
    expect(plan.fallback.directDelivery).toBe(true);
    expect(plan.fallback.skipWhenMessageToolSentToTarget).toBe(true);
  });

  it('rebuilds delivery.mode "webhook" with message tool disabled', () => {
    const plan = resolveFallbackCronSourceDeliveryPlan(makeJob({ delivery: { mode: "webhook" } }), {
      channel: "messagechat",
      to: "room-1",
      ok: true,
    });

    expect(plan.owner).toBe("none");
    expect(plan.reason).toBe("cron_webhook");
    expect(plan.messageTool.enabled).toBe(false);
    expect(plan.messageTool.force).toBe(false);
    expect(plan.fallback.directDelivery).toBe(false);
    expect(plan.target).toEqual({});
  });

  it("defaults an isolated agentTurn with no delivery config to announce behavior", () => {
    const plan = resolveFallbackCronSourceDeliveryPlan(makeJob({ omitDelivery: true }), {
      channel: "messagechat",
      to: "room-1",
      ok: false,
    });

    expect(plan.owner).toBe("direct_fallback");
    expect(plan.reason).toBe("cron_announce");
    expect(plan.messageTool.enabled).toBe(true);
    expect(plan.messageTool.force).toBe(false);
    expect(plan.fallback.directDelivery).toBe(true);
    expect(plan.fallback.skipWhenMessageToolSentToTarget).toBe(false);
  });

  it("preserves duplicate suppression when stale caller omits ok", () => {
    const plan = resolveFallbackCronSourceDeliveryPlan(
      makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "room-1" } }),
      {
        channel: "messagechat",
        to: "room-1",
        // ok intentionally omitted — stale caller shape
      },
    );

    expect(plan.owner).toBe("direct_fallback");
    expect(plan.reason).toBe("cron_announce");
    expect(plan.fallback.directDelivery).toBe(true);
    // When ok is absent, default to true to prevent double-posting
    expect(plan.fallback.skipWhenMessageToolSentToTarget).toBe(true);
  });
});

describe("resolveCronSourceDeliveryPlan", () => {
  beforeEach(() => {
    resolveCronDeliveryPlanMock.mockReset();
    resolveCronDeliveryPlanMock.mockImplementation(
      actualDeliveryPlanModule.resolveCronDeliveryPlan,
    );
  });

  const cases: Array<{
    name: string;
    job: CronJob;
    resolvedDelivery: {
      channel?: string;
      accountId?: string;
      to?: string;
      threadId?: string | number;
      ok?: boolean;
    };
  }> = [
    {
      name: "none",
      job: makeJob({ delivery: { mode: "none" } }),
      resolvedDelivery: {
        channel: "messagechat",
        accountId: "acct-1",
        to: "room-1",
        threadId: "thread-1",
        ok: true,
      },
    },
    {
      name: "announce",
      job: makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "room-1" } }),
      resolvedDelivery: {
        channel: "messagechat",
        to: "room-1",
        ok: true,
      },
    },
    {
      name: "webhook",
      job: makeJob({ delivery: { mode: "webhook" } }),
      resolvedDelivery: {
        channel: "messagechat",
        to: "room-1",
        ok: true,
      },
    },
    {
      name: "implicit announce",
      job: makeJob({ omitDelivery: true }),
      resolvedDelivery: {
        channel: "messagechat",
        to: "room-1",
        ok: false,
      },
    },
  ];

  for (const testCase of cases) {
    it(`matches the fallback wrapper for ${testCase.name}`, () => {
      const deliveryPlan = actualDeliveryPlanModule.resolveCronDeliveryPlan(testCase.job);
      const normalPathPlan = resolveCronSourceDeliveryPlan({
        deliveryPlan,
        resolvedDelivery: testCase.resolvedDelivery,
      });
      const fallbackPathPlan = resolveFallbackCronSourceDeliveryPlan(
        testCase.job,
        testCase.resolvedDelivery,
      );

      expect(normalPathPlan).toEqual(fallbackPathPlan);
    });
  }
});

describe("createCronPromptExecutor sourceDelivery guard", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronDeliveryPlanMock.mockImplementation(
      actualDeliveryPlanModule.resolveCronDeliveryPlan,
    );
    previousFastTestEnv = clearFastTestEnv();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it('falls back from delivery.mode "none" with messageToolForced false and owner none', async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "none" } }),
      sourceDelivery: undefined,
      resolvedDelivery: {
        channel: "messagechat",
        accountId: "acct-1",
        threadId: "thread-99",
      },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.allowEmptyAssistantReplyAsSilent).toBe(true);
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.agentAccountId).toBe("acct-1");
    expect(args.messageThreadId).toBe("thread-99");
  });

  it('falls back from delivery.mode "announce" with direct fallback semantics', async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "123" } }),
      sourceDelivery: undefined,
      resolvedDelivery: { ok: true, channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.allowEmptyAssistantReplyAsSilent).toBe(true);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.messageChannel).toBe("messagechat");
    expect(args.messageTo).toBe("123");
  });

  it('falls back from delivery.mode "webhook" with message tool disabled', async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "webhook" } }),
      sourceDelivery: undefined,
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(true);
    expect(args.forceMessageTool).toBe(false);
    expect(args.messageChannel).toBe("messagechat");
  });

  it("falls back with announce behavior when isolated agentTurn has no delivery config", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ omitDelivery: true }),
      sourceDelivery: undefined,
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.messageChannel).toBe("messagechat");
  });

  it("ignores stale legacy fields when sourceDelivery is missing", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "123" } }),
      sourceDelivery: undefined,
      resolvedDelivery: { channel: "messagechat", to: "123" },
      messageChannel: "legacychat",
      toolPolicy: {
        disableMessageTool: true,
        forceMessageTool: true,
        requireExplicitMessageTarget: true,
      },
      sourceReplyDeliveryMode: "message_tool_only",
    } as never);

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.messageChannel).toBe("messagechat");
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.requireExplicitMessageTarget).toBe(true);
  });

  it("still works with a valid sourceDelivery", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: createSourceDeliveryPlan({
        owner: "message_tool_then_direct_fallback",
        reason: "cron_announce",
        target: { channel: "messagechat", to: "123" },
        messageToolEnabled: true,
        messageToolForced: true,
        directFallback: true,
      }),
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("send a message");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(true);
    expect(args.messageChannel).toBe("messagechat");
  });

  it("forwards an explicit OpenClaw runtime override to cron execution", async () => {
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession() as MutableCronSession;
    cronSession.sessionEntry.agentRuntimeOverride = "openclaw";
    cronSession.sessionEntry.agentHarnessId = "codex";
    const executor = makeExecutor({
      cfgWithAgentDefaults: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
      liveSelection: { provider: "openai", model: "gpt-5.6-luna" },
      cronSession,
      thinkLevel: "ultra",
    });

    await executor.runPrompt("run an Ultra task");

    expect(getEmbeddedRunArg()).toEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        thinkLevel: "ultra",
        agentHarnessRuntimeOverride: "openclaw",
      }),
    );
    expect(getEmbeddedRunArg()).not.toHaveProperty("agentHarnessId");
  });
});

function makeExecuteCronRunParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: {},
    cfgWithAgentDefaults: {},
    job: makeJob(),
    agentId: "default",
    agentDir: "/tmp/agent-dir",
    agentSessionKey: "cron:source-delivery-guard",
    runSessionKey: "cron:source-delivery-guard:run:test-session-id",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: emptySkillsSnapshot,
    agentPayload: null,
    useSubagentFallbacks: false,
    agentVerboseDefault: undefined,
    liveSelection: {
      provider: "openai",
      model: "gpt-5.4",
    },
    cronSession: makeCronSession() as MutableCronSession,
    commandBody: "run a task",
    persistSessionEntry: vi.fn().mockResolvedValue(undefined),
    abortReason: () => "aborted",
    isAborted: () => false,
    thinkLevel: undefined,
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
    resolvedDelivery: {},
    sourceDelivery: undefined,
    ...overrides,
  } as never;
}

describe("executeCronRun sourceDelivery guard", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronDeliveryPlanMock.mockImplementation(
      actualDeliveryPlanModule.resolveCronDeliveryPlan,
    );
    previousFastTestEnv = clearFastTestEnv();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("rebuilds fallback from job delivery config and ignores stale legacy params", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        job: makeJob({ delivery: { mode: "none" } }),
        sourceDelivery: undefined,
        resolvedDelivery: { channel: "messagechat", to: "123" },
        messageChannel: "legacychat",
        toolPolicy: {
          disableMessageTool: true,
          forceMessageTool: true,
          requireExplicitMessageTarget: true,
        },
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.messageChannel).toBe("messagechat");
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.requireExplicitMessageTarget).toBe(false);
  });

  it('rebuilds delivery.mode "webhook" with message tool disabled through executeCronRun', async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        job: makeJob({ delivery: { mode: "webhook" } }),
        sourceDelivery: undefined,
        resolvedDelivery: { channel: "messagechat", to: "202" },
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(true);
    expect(args.forceMessageTool).toBe(false);
  });
});
