import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { CronDeliveryMode } from "../types.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  clearFastTestEnv,
  dispatchCronDeliveryMock,
  getChannelPluginMock,
  isHeartbeatOnlyResponseMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveCronPayloadOutcomeMock,
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

function makeAnnounceMessageToolJob(
  options: {
    id?: string;
    name?: string;
    delivery?: Record<string, unknown>;
  } = {},
) {
  return {
    id: options.id ?? "message-tool-policy",
    name: options.name ?? "Message Tool Policy",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "send a message" },
    delivery: { mode: "announce", channel: "messagechat", to: "123", ...options.delivery },
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

function makeAnnounceDeliveryPlan(overrides: Record<string, unknown> = {}) {
  return {
    requested: true,
    mode: "announce",
    channel: "messagechat",
    to: "123",
    ...overrides,
  };
}

function makeResolvedAnnounceTarget(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    channel: "messagechat",
    to: "123",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    ...overrides,
  };
}

function makeMessageToolRunResult(messagingToolSentTargets: Array<Record<string, unknown>>) {
  return {
    payloads: [{ text: "sent" }],
    didSendViaMessagingTool: true,
    messagingToolSentTargets,
    meta: { agentMeta: { usage: { input: 10, output: 20 } } },
  };
}

function mockPendingMessagePresentationWarningOutcome() {
  resolveCronPayloadOutcomeMock.mockReturnValue({
    summary: "Final cron report",
    outputText: "Final cron report",
    synthesizedText: "Final cron report",
    deliveryPayload: { text: "Final cron report" },
    deliveryPayloads: [{ text: "Final cron report" }],
    deliveryPayloadHasStructuredContent: false,
    hasFatalErrorPayload: false,
    embeddedRunError: undefined,
    pendingPresentationWarningError: "⚠️ ✉️ Message failed",
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getMockCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = (mock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

function expectEmbeddedRunFields(expected: Record<string, unknown>): Record<string, unknown> {
  return expectRecordFields(
    getMockCallArg(runEmbeddedPiAgentMock, 0, 0, "embedded run"),
    expected,
    "embedded run params",
  );
}

function expectEmbeddedRunPrompt(): string {
  const prompt = expectEmbeddedRunFields({}).prompt;
  if (typeof prompt !== "string") {
    throw new Error("expected embedded run prompt to be a string");
  }
  return prompt;
}

function expectDispatchFields(expected: Record<string, unknown>): Record<string, unknown> {
  return expectRecordFields(
    getMockCallArg(dispatchCronDeliveryMock, 0, 0, "cron delivery dispatch"),
    expected,
    "cron delivery dispatch params",
  );
}

function expectDeliveryFields(
  delivery: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  return expectRecordFields(delivery, expected, "cron delivery result");
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
    expectEmbeddedRunFields({
      disableMessageTool: true,
      forceMessageTool: false,
    });
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
    expectEmbeddedRunFields({
      disableMessageTool: false,
      forceMessageTool: true,
    });
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
    expectEmbeddedRunFields({
      disableMessageTool: false,
      forceMessageTool: true,
      messageChannel: "messagechat",
      messageTo: "123",
      currentChannelId: "123",
    });
  }

  async function expectCronFallbackSkippedForMessageToolDelivery(options: {
    sentTargets: Array<Record<string, unknown>>;
    job?: Parameters<typeof makeAnnounceMessageToolJob>[0];
  }) {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan());
    runEmbeddedPiAgentMock.mockResolvedValue(makeMessageToolRunResult(options.sentTargets));

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob(options.job),
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expectDispatchFields({
      deliveryRequested: true,
      skipMessagingToolDelivery: true,
    });
    expectDeliveryFields(result.delivery, {
      intended: { channel: "messagechat", to: "123", source: "explicit" },
      resolved: { ok: true, channel: "messagechat", to: "123", source: "explicit" },
      messageToolSentTo: [{ channel: "messagechat", to: "123" }],
      fallbackUsed: false,
      delivered: true,
    });
  }

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    getChannelPluginMock.mockImplementation((channelId: string) =>
      channelId === "topicchat"
        ? {
            threading: {
              resolveCurrentChannelId: ({
                to,
                threadId,
              }: {
                to: string;
                threadId?: string | number | null;
              }) => {
                if (threadId == null) {
                  return to;
                }
                return to.includes("#") ? to : `${to}#${threadId}`;
              },
            },
            outbound: {
              preferFinalAssistantVisibleText: true,
            },
          }
        : undefined,
    );
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "messagechat",
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
      runSessionKey: "cron:message-tool-policy:run:test-session-id",
      workspaceDir: "/tmp/workspace",
      resolvedVerboseLevel: "off",
      thinkLevel: undefined,
      timeoutMs: 60_000,
      senderIsOwner: true,
      messageChannel: "messagechat",
      suppressExecNotifyOnExit: true,
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

  it('skips implicit target resolution for bare delivery.mode "none"', async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeMessageToolPolicyJob({ mode: "none" }),
    });

    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const embeddedRun = expectEmbeddedRunFields({
      disableMessageTool: false,
      forceMessageTool: true,
    });
    expect(embeddedRun.messageChannel).toBeUndefined();
    expect(embeddedRun.messageTo).toBeUndefined();
  });

  it('suppresses automatic exec completion notifications when delivery.mode is "none"', async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "topicchat",
      to: "room#42",
      threadId: 42,
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "topicchat",
      to: "room#42",
      threadId: 42,
      accountId: undefined,
      error: undefined,
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeMessageToolPolicyJob({
        mode: "none",
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
      }),
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expectEmbeddedRunFields({
      disableMessageTool: false,
      forceMessageTool: true,
      messageChannel: "topicchat",
      messageTo: "room#42",
      messageThreadId: 42,
      execOverrides: {
        notifyOnExit: false,
        notifyOnExitEmptySuccess: false,
      },
    });
  });

  it("preserves explicit delivery targets for agent-initiated messaging when delivery.mode is none", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "topicchat",
      to: "room#42",
      threadId: 42,
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "topicchat",
      to: "room#42",
      threadId: 42,
      accountId: undefined,
      error: undefined,
    });

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: {
        id: "message-tool-policy",
        name: "Message Tool Policy",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: { mode: "none", channel: "topicchat", to: "room#42", threadId: 42 },
      } as never,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expectEmbeddedRunFields({
      disableMessageTool: false,
      messageChannel: "topicchat",
      messageTo: "room#42",
      messageThreadId: 42,
      currentChannelId: "room#42",
    });
    expectDeliveryFields(result.delivery, {
      intended: { channel: "topicchat", to: "room#42", threadId: 42, source: "explicit" },
      resolved: {
        ok: true,
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
        source: "explicit",
      },
    });
  });

  it('does not resolve implicit "last" context for bare delivery.mode none', async () => {
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
    const embeddedRun = expectEmbeddedRunFields({
      disableMessageTool: false,
      forceMessageTool: true,
    });
    expect(embeddedRun.messageChannel).toBeUndefined();
    expect(embeddedRun.messageTo).toBeUndefined();
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
      messageChannel: "topicchat",
      resolvedDelivery: {
        accountId: "ops",
        to: "room#42",
        threadId: 42,
      },
    });

    await executor.runPrompt("send a message");

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expectEmbeddedRunFields({
      messageChannel: "topicchat",
      agentAccountId: "ops",
      messageTo: "room#42",
      messageThreadId: 42,
      currentChannelId: "room#42",
    });
  });

  it("lets channels build currentChannelId from split delivery fields", async () => {
    mockRunCronFallbackPassthrough();
    const executor = createMessageToolExecutor({
      messageChannel: "topicchat",
      resolvedDelivery: {
        accountId: "ops",
        to: "room",
        threadId: 42,
      },
    });

    await executor.runPrompt("send a message");

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expectEmbeddedRunFields({
      messageChannel: "topicchat",
      agentAccountId: "ops",
      messageTo: "room",
      messageThreadId: 42,
      currentChannelId: "room#42",
    });
  });

  it("keeps the message tool enabled when announce delivery is active", async () => {
    await expectMessageToolEnabledForPlan({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });
  });

  it("keeps automatic exec completion notifications when announce delivery is active", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan());

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob(),
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(expectEmbeddedRunFields({}).execOverrides).toBeUndefined();
  });

  it("keeps automatic exec completion notifications when webhook delivery is active", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "webhook",
      to: "https://example.invalid/cron",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeMessageToolPolicyJob({
        mode: "webhook",
        to: "https://example.invalid/cron",
      }),
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(expectEmbeddedRunFields({}).execOverrides).toBeUndefined();
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
    expectEmbeddedRunFields({ disableMessageTool: false });
  });

  it("skips cron delivery when output is heartbeat-only", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan());
    isHeartbeatOnlyResponseMock.mockReturnValue(true);

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob(),
    });

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expectDispatchFields({
      deliveryRequested: true,
      skipHeartbeatDelivery: true,
    });
  });

  it("skips cron fallback delivery when the message tool already sent to the same target", async () => {
    await expectCronFallbackSkippedForMessageToolDelivery({
      sentTargets: [{ tool: "message", provider: "messagechat", to: "123" }],
    });
  });

  it("skips cron fallback delivery when the message tool sends to the bound target", async () => {
    await expectCronFallbackSkippedForMessageToolDelivery({
      sentTargets: [],
      job: {
        id: "message-tool-bound-target",
        name: "Message Tool Bound Target",
      },
    });
  });

  it("rewrites generic message provider to resolved channel in delivery trace", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan());
    runEmbeddedPiAgentMock.mockResolvedValue(
      makeMessageToolRunResult([{ tool: "message", provider: "message", to: "123" }]),
    );

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob({
        id: "message-tool-generic-target",
        name: "Message Tool Generic Target",
      }),
    });

    expectDeliveryFields(result.delivery, {
      resolved: { ok: true, channel: "messagechat", to: "123", source: "explicit" },
      messageToolSentTo: [{ channel: "messagechat", to: "123" }],
    });
  });

  it("preserves accountId when rewriting generic message provider to resolved channel", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan({ accountId: "bot-a" }));
    resolveDeliveryTargetMock.mockResolvedValue(makeResolvedAnnounceTarget({ accountId: "bot-a" }));
    runEmbeddedPiAgentMock.mockResolvedValue(
      makeMessageToolRunResult([
        { tool: "message", provider: "message", to: "123", accountId: "bot-a" },
      ]),
    );

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob({
        id: "message-tool-generic-target-account",
        name: "Message Tool Generic Target (accountId)",
        delivery: { accountId: "bot-a" },
      }),
    });

    expectDeliveryFields(result.delivery, {
      messageToolSentTo: [{ channel: "messagechat", to: "123", accountId: "bot-a" }],
    });
  });

  it("rewrites generic message provider when tool send omits accountId (tool fills at exec)", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan({ accountId: "bot-a" }));
    resolveDeliveryTargetMock.mockResolvedValue(makeResolvedAnnounceTarget({ accountId: "bot-a" }));
    runEmbeddedPiAgentMock.mockResolvedValue(
      makeMessageToolRunResult([{ tool: "message", provider: "message", to: "123" }]),
    );

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob({
        id: "message-tool-generic-target-account-default",
        name: "Message Tool Generic Target (accountId default)",
        delivery: { accountId: "bot-a" },
      }),
    });

    expectDeliveryFields(result.delivery, {
      messageToolSentTo: [{ channel: "messagechat", to: "123" }],
    });
  });

  it("does not rewrite generic message provider when tool names a different accountId (spoof guard)", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan({ accountId: "bot-a" }));
    resolveDeliveryTargetMock.mockResolvedValue(makeResolvedAnnounceTarget({ accountId: "bot-a" }));
    runEmbeddedPiAgentMock.mockResolvedValue(
      makeMessageToolRunResult([
        { tool: "message", provider: "message", to: "123", accountId: "bot-b" },
      ]),
    );

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob({
        id: "message-tool-generic-target-account-spoof",
        name: "Message Tool Generic Target (account spoof guard)",
        delivery: { accountId: "bot-a" },
      }),
    });

    expectDeliveryFields(result.delivery, {
      messageToolSentTo: [{ channel: "message", to: "123", accountId: "bot-b" }],
    });
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
    runEmbeddedPiAgentMock.mockResolvedValue(
      makeMessageToolRunResult([{ tool: "message", provider: "messagechat", to: "123" }]),
    );

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expectDispatchFields({
      deliveryRequested: true,
      skipMessagingToolDelivery: false,
      unverifiedMessagingToolDelivery: true,
    });
    const delivery = expectDeliveryFields(result.delivery, {
      intended: { channel: "last", to: null, source: "last" },
      messageToolSentTo: [{ channel: "messagechat", to: "123" }],
      fallbackUsed: false,
      delivered: false,
    });
    expectRecordFields(
      delivery.resolved,
      {
        ok: false,
        source: "last",
        error: "sessionKey is required to resolve delivery.channel=last",
      },
      "cron delivery resolved target",
    );
  });

  it("does not mark bare no-deliver runs delivered when the current target is unresolved", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: false,
      mode: "none",
      channel: "last",
    });
    runEmbeddedPiAgentMock.mockResolvedValue(
      makeMessageToolRunResult([{ tool: "message", provider: "messagechat", to: "123" }]),
    );

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(dispatchCronDeliveryMock).toHaveBeenCalledTimes(1);
    expectDispatchFields({
      deliveryRequested: false,
      skipMessagingToolDelivery: false,
      unverifiedMessagingToolDelivery: true,
    });
    expect(result.delivered).toBe(false);
    expect(result.deliveryAttempted).toBe(false);
    expectDeliveryFields(result.delivery, {
      intended: { channel: "last", to: null, source: "last" },
      messageToolSentTo: [{ channel: "messagechat", to: "123" }],
      fallbackUsed: false,
      delivered: false,
    });
    expect(result.delivery).not.toHaveProperty("resolved");
  });

  it("clears pending message presentation warnings only after cron delivery succeeds", async () => {
    mockRunCronFallbackPassthrough();
    mockPendingMessagePresentationWarningOutcome();
    resolveCronDeliveryPlanMock.mockReturnValue(makeAnnounceDeliveryPlan());
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "Final cron report" }, { text: "⚠️ ✉️ Message failed", isError: true }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeAnnounceMessageToolJob({
        id: "pending-message-warning-delivered",
        name: "Pending Message Warning Delivered",
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
    expectDispatchFields({
      deliveryPayloads: [{ text: "Final cron report" }],
    });
  });

  it("keeps pending message presentation warnings fatal when cron delivery does not succeed", async () => {
    mockRunCronFallbackPassthrough();
    mockPendingMessagePresentationWarningOutcome();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "Final cron report" }, { text: "⚠️ ✉️ Message failed", isError: true }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeMessageToolPolicyJob({ mode: "none" }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("⚠️ ✉️ Message failed");
    expect(result.summary).toBe("Final cron report");
    expectDispatchFields({
      deliveryRequested: false,
      deliveryPayloads: [{ text: "Final cron report" }],
    });
  });
});

describe("runCronIsolatedAgentTurn delivery instruction", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "messagechat",
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
      channel: "messagechat",
      to: "123",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt = expectEmbeddedRunPrompt();
    expect(prompt).toContain("Use the message tool");
    expect(prompt).toContain("will be delivered automatically");
    expect(prompt).not.toContain("note who/where");
  });

  it("does not prompt for the message tool when toolsAllow excludes it", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "123",
    });

    await runCronIsolatedAgentTurn({
      ...makeParams(),
      job: makeMessageToolPolicyJob(
        { mode: "announce", channel: "messagechat", to: "123" },
        { kind: "agentTurn", message: "send a message", toolsAllow: ["read"] },
      ),
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt = expectEmbeddedRunPrompt();
    expect(prompt).not.toContain("Use the message tool");
    expect(prompt).toContain("Return your response as plain text");
  });

  it("does not append a delivery instruction when delivery is not requested", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt = expectEmbeddedRunPrompt();
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
      channel: "messagechat",
      to: "123",
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const prompt = expectEmbeddedRunPrompt();
    expect(prompt).not.toMatch(/\bsummary\b/i);
  });
});
