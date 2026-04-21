import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { CronDeliveryMode } from "../types.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  clearFastTestEnv,
  dispatchCronDeliveryMock,
  isHeartbeatOnlyResponseMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { createCronPromptExecutor } = await import("./run-executor.js");

function makeMessageToolPolicyJob(
  delivery: Record<string, unknown> = { mode: "none" },
  payload: Record<string, unknown> = { kind: "agentTurn", message: "send a message" },
) {
  return {
    id: "message-tool-policy",
    name: "Message Tool Policy",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload,
    delivery,
  } as never;
}

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: makeMessageToolPolicyJob(),
    message: "send a message",
    sessionKey: "cron:message-tool-policy",
  };
}

describe("runCronIsolatedAgentTurn message tool policy", () => {
  let previousFastTestEnv: string | undefined;

  async function expectMessageToolDisabledForPlan(plan: {
    requested: boolean;
    mode: CronDeliveryMode;
    channel?: string;
    to?: string;
  }) {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(plan);
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(true);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.forceMessageTool).toBe(false);
  }

  async function expectMessageToolEnabledForPlan(plan: {
    requested: boolean;
    mode: CronDeliveryMode;
    channel?: string;
    to?: string;
  }) {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(plan);
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(false);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.forceMessageTool).toBe(true);
  }

  async function runModeNoneDeliveryCase(params: {
    delivery: Record<string, unknown>;
    plan: Record<string, unknown>;
  }) {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "last",
      ...params.plan,
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeMessageToolPolicyJob(params.delivery),
    });

    expect(resolveDeliveryTargetMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: false,
      forceMessageTool: true,
      messageChannel: "telegram",
      messageTo: "123",
      currentChannelId: "123",
    });
  }

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  const emptySkillsSnapshot: SkillSnapshot = {
    prompt: "",
    skills: [],
    resolvedSkills: [],
    version: 1,
  };

  function createMessageToolExecutor(
    overrides: Partial<Parameters<typeof createCronPromptExecutor>[0]>,
  ) {
    const resolvedDelivery = overrides.resolvedDelivery ?? {};

    return createCronPromptExecutor({
      cfg: {},
      cfgWithAgentDefaults: {},
      job: makeMessageToolPolicyJob(),
      agentId: "default",
      agentDir: "/tmp/agent-dir",
      agentSessionKey: "cron:message-tool-policy",
      workspaceDir: "/tmp/workspace",
      resolvedVerboseLevel: "off",
      thinkLevel: undefined,
      timeoutMs: 60_000,
      messageChannel: "telegram",
      toolPolicy: {
        requireExplicitMessageTarget: false,
        disableMessageTool: false,
        forceMessageTool: true,
      },
      skillsSnapshot: emptySkillsSnapshot,
      agentPayload: null,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
      },
      cronSession: makeCronSession() as MutableCronSession,
      abortReason: () => "aborted",
      ...overrides,
      resolvedDelivery,
    });
  }

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it('keeps the message tool enabled when delivery.mode is "none"', async () => {
    await expectMessageToolEnabledForPlan({
      requested: false,
      mode: "none",
    });
  });

  it("preserves explicit delivery targets for agent-initiated messaging when delivery.mode is none", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "telegram",
      to: "123:topic:42",
      threadId: 42,
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123:topic:42",
      threadId: 42,
      accountId: undefined,
      error: undefined,
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "none", channel: "telegram", to: "123:topic:42", threadId: 42 },
      } as never,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: false,
      messageChannel: "telegram",
      messageTo: "123:topic:42",
      messageThreadId: 42,
      currentChannelId: "123:topic:42",
    });
  });

  it("resolves implicit last-target context for bare delivery.mode none", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "last",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "none" },
      } as never,
    });

    expect(resolveDeliveryTargetMock).toHaveBeenCalledTimes(1);
    expect(resolveDeliveryTargetMock.mock.calls[0]?.[2]).toMatchObject({
      channel: "last",
      sessionKey: undefined,
    });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: false,
      forceMessageTool: true,
      messageChannel: "telegram",
      messageTo: "123",
      currentChannelId: "123",
    });
  });

  it("resolves implicit last-target context for delivery.mode none with only accountId", async () => {
    await runModeNoneDeliveryCase({
      delivery: { mode: "none", accountId: "ops" },
      plan: { accountId: "ops" },
    });
  });

  it("resolves implicit last-target context for delivery.mode none with only threadId", async () => {
    await runModeNoneDeliveryCase({
      delivery: { mode: "none", threadId: 42 },
      plan: { threadId: 42 },
    });
  });

  it("forwards explicit message targets into the embedded run", async () => {
    mockRunCronFallbackPassthrough();
    const executor = createMessageToolExecutor({
      resolvedDelivery: {
        accountId: "ops",
        to: "123:topic:42",
        threadId: 42,
      },
    });

    await executor.runPrompt("send a message");

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      messageChannel: "telegram",
      agentAccountId: "ops",
      messageTo: "123:topic:42",
      messageThreadId: 42,
      currentChannelId: "123:topic:42",
    });
  });

  it("preserves topic routing when inferred currentChannelId is built from split delivery fields", async () => {
    mockRunCronFallbackPassthrough();
    const executor = createMessageToolExecutor({
      resolvedDelivery: {
        accountId: "ops",
        to: "123",
        threadId: 42,
      },
    });

    await executor.runPrompt("send a message");

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      messageChannel: "telegram",
      agentAccountId: "ops",
      messageTo: "123",
      messageThreadId: 42,
      currentChannelId: "123:topic:42",
    });
  });

  it("keeps the message tool enabled when announce delivery is active", async () => {
    await expectMessageToolEnabledForPlan({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
  });

  it("disables the message tool when webhook delivery is active", async () => {
    await expectMessageToolDisabledForPlan({
      requested: false,
      mode: "webhook",
      to: "https://example.invalid/cron",
    });
  });

  it("keeps the message tool enabled when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.disableMessageTool).toBe(false);
  });

  it("skips cron delivery when output is heartbeat-only", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    isHeartbeatOnlyResponseMock.mockReturnValue(true);

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      } as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipHeartbeatDelivery: true,
      }),
    );
  });

  it("skips cron fallback delivery when the message tool already sent to the same target", async () => {
    mockRunCronFallbackPassthrough();
    const params = makeParams();
    const job = {
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    } as const;
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "sent" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn({
      ...params,
      job: job as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: true,
      }),
    );
    expect(result.delivery).toEqual(
      expect.objectContaining({
        intended: { channel: "telegram", to: "123", source: "explicit" },
        resolved: { ok: true, channel: "telegram", to: "123", source: "explicit" },
        messageToolSentTo: [{ channel: "telegram", to: "123" }],
        fallbackUsed: false,
        delivered: true,
      }),
    );
  });

  it("skips cron fallback delivery when the message tool sends to the bound target", async () => {
    mockRunCronFallbackPassthrough();
    const params = makeParams();
    const job = {
      id: "message-tool-bound-target",
      name: "Message Tool Bound Target",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    } as const;
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "sent" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn({
      ...params,
      job: job as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: true,
      }),
    );
    expect(result.delivery).toEqual(
      expect.objectContaining({
        intended: { channel: "telegram", to: "123", source: "explicit" },
        resolved: { ok: true, channel: "telegram", to: "123", source: "explicit" },
        messageToolSentTo: [{ channel: "telegram", to: "123" }],
        fallbackUsed: false,
        delivered: true,
      }),
    );
  });

  it("does not mark message tool delivery as matched when cron target resolution failed", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "last",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: false,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      error: new Error("sessionKey is required to resolve delivery.channel=last"),
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "sent" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: false,
        unverifiedMessagingToolDelivery: true,
      }),
    );
    expect(result.delivery).toEqual(
      expect.objectContaining({
        intended: { channel: "last", to: null, source: "last" },
        resolved: expect.objectContaining({
          ok: false,
          source: "last",
          error: "sessionKey is required to resolve delivery.channel=last",
        }),
        messageToolSentTo: [{ channel: "telegram", to: "123" }],
        fallbackUsed: false,
        delivered: false,
      }),
    );
  });

  it("marks no-deliver runs delivered when the message tool sends to the current target", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "last",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "sent" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: false,
        skipMessagingToolDelivery: true,
      }),
    );
    expect(result.delivered).toBe(true);
    expect(result.deliveryAttempted).toBe(true);
  });
});

describe("runCronIsolatedAgentTurn delivery instruction", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("appends shared delivery guidance to the prompt when announce delivery is requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("Use the message tool");
    expect(prompt).toContain("will be delivered automatically");
    expect(prompt).not.toContain("note who/where");
  });

  it("does not prompt for the message tool when toolsAllow excludes it", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeMessageToolPolicyJob(
        { mode: "announce", channel: "telegram", to: "123" },
        { kind: "agentTurn", message: "send a message", toolsAllow: ["read"] },
      ),
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).not.toContain("Use the message tool");
    expect(prompt).toContain("Return your response as plain text");
  });

  it("does not append a delivery instruction when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).not.toContain("Return your response as plain text");
    expect(prompt).not.toContain("it will be delivered automatically");
  });

  it("does not instruct the agent to summarize when delivery is requested", async () => {
    // Regression for https://github.com/openclaw/openclaw/issues/58535:
    // "summary" caused LLMs to condense structured output and drop fields
    // non-deterministically on every run.
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt: string = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).not.toMatch(/\bsummary\b/i);
  });
});
