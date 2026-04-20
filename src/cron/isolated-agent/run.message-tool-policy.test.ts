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

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "message-tool-policy",
      name: "Message Tool Policy",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: { mode: "none" },
    } as never,
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

  it("does not resolve implicit last-target context for bare delivery.mode none", async () => {
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

    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: false,
      messageChannel: undefined,
      messageTo: undefined,
      messageThreadId: undefined,
      currentChannelId: undefined,
    });
  });

  it("does not resolve implicit last-target context for delivery.mode none with only accountId", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "last",
      accountId: "ops",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "none", accountId: "ops" },
      } as never,
    });

    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: false,
      messageChannel: undefined,
      messageTo: undefined,
      messageThreadId: undefined,
      currentChannelId: undefined,
      agentAccountId: undefined,
    });
  });

  it("does not resolve implicit last-target context for delivery.mode none with only threadId", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "last",
      threadId: 42,
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "none", threadId: 42 },
      } as never,
    });

    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: false,
      messageChannel: undefined,
      messageTo: undefined,
      messageThreadId: undefined,
      currentChannelId: undefined,
      agentAccountId: undefined,
    });
  });

  it("forwards explicit message targets into the embedded run", async () => {
    mockRunCronFallbackPassthrough();
    const executor = createCronPromptExecutor({
      cfg: {},
      cfgWithAgentDefaults: {},
      job: makeParams().job,
      agentId: "default",
      agentDir: "/tmp/agent-dir",
      agentSessionKey: "cron:message-tool-policy",
      workspaceDir: "/tmp/workspace",
      resolvedVerboseLevel: "off",
      thinkLevel: undefined,
      timeoutMs: 60_000,
      messageChannel: "telegram",
      resolvedDelivery: {
        accountId: "ops",
        to: "123:topic:42",
        threadId: 42,
      },
      toolPolicy: {
        requireExplicitMessageTarget: false,
        disableMessageTool: false,
      },
      skillsSnapshot: emptySkillsSnapshot,
      agentPayload: null,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
      },
      cronSession: makeCronSession() as MutableCronSession,
      abortReason: () => "aborted",
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
    const executor = createCronPromptExecutor({
      cfg: {},
      cfgWithAgentDefaults: {},
      job: makeParams().job,
      agentId: "default",
      agentDir: "/tmp/agent-dir",
      agentSessionKey: "cron:message-tool-policy",
      workspaceDir: "/tmp/workspace",
      resolvedVerboseLevel: "off",
      thinkLevel: undefined,
      timeoutMs: 60_000,
      messageChannel: "telegram",
      resolvedDelivery: {
        accountId: "ops",
        to: "123",
        threadId: 42,
      },
      toolPolicy: {
        requireExplicitMessageTarget: false,
        disableMessageTool: false,
      },
      skillsSnapshot: emptySkillsSnapshot,
      agentPayload: null,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
      },
      cronSession: makeCronSession() as MutableCronSession,
      abortReason: () => "aborted",
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

  it("disables the message tool when cron delivery is active", async () => {
    await expectMessageToolDisabledForPlan({
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

  it("keeps the message tool enabled for shared callers when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      deliveryContract: "shared",
    });

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

  it("skips cron delivery when a shared caller already sent to the same target", async () => {
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

    await runCronIsolatedAgentTurn({
      ...params,
      deliveryContract: "shared",
      job: job as never,
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expect(dispatchCronDeliveryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        deliveryRequested: true,
        skipMessagingToolDelivery: true,
      }),
    );
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

  it("appends a plain-text delivery instruction to the prompt when delivery is requested", async () => {
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
    expect(prompt).toContain("Return your response as plain text");
    expect(prompt).toContain("it will be delivered automatically");
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
