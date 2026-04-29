import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

vi.mock("../agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  return {
    ...actual,
    resolveSessionAgentId: () => "agent-123",
  };
});

import { createCronTool } from "./cron-tool.js";

describe("cron tool", () => {
  type SchemaLike = {
    anyOf?: Array<{ type?: string }>;
    description?: string;
    properties?: Record<string, SchemaLike>;
  };

  type TestDelivery = {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };

  function createTestCronTool(
    opts?: Parameters<typeof createCronTool>[0],
  ): ReturnType<typeof createCronTool> {
    return createCronTool(opts, {
      callGatewayTool: async (method, _gatewayOpts, params) =>
        await callGatewayMock({ method, params }),
    });
  }

  function readGatewayCall(index = 0): { method?: string; params?: Record<string, unknown> } {
    return (
      (callGatewayMock.mock.calls[index]?.[0] as
        | { method?: string; params?: Record<string, unknown> }
        | undefined) ?? { method: undefined, params: undefined }
    );
  }

  function readCronPayloadText(index = 0): string {
    const params = readGatewayCall(index).params as { payload?: { text?: string } } | undefined;
    return params?.payload?.text ?? "";
  }

  function expectSingleGatewayCallMethod(method: string) {
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = readGatewayCall(0);
    expect(call.method).toBe(method);
    return call.params;
  }

  it("tells models to keep cron expressions in local wall-clock time for tz", () => {
    const tool = createTestCronTool();

    expect(tool.description).toContain("local wall-clock time");
    expect(tool.description).toContain("do not convert the requested local time to UTC first");
    expect(tool.description).toContain("Gateway host local timezone");
    expect(tool.description).toContain(
      'For schedule.kind="at", ISO timestamps without an explicit timezone are treated as UTC.',
    );
    expect(tool.description).toContain('"expr": "0 18 * * *"');
    expect(tool.description).toContain('"tz": "Asia/Shanghai"');
  });

  function buildReminderAgentTurnJob(overrides: Record<string, unknown> = {}): {
    name: string;
    schedule: { at: string };
    payload: { kind: "agentTurn"; message: string };
    delivery?: { mode: string; to?: string };
  } {
    return {
      name: "reminder",
      schedule: { at: new Date(123).toISOString() },
      payload: { kind: "agentTurn", message: "hello" },
      ...overrides,
    };
  }

  async function executeAddAndReadDelivery(params: {
    callId: string;
    agentSessionKey?: string;
    currentDeliveryContext?: NonNullable<
      Parameters<typeof createCronTool>[0]
    >["currentDeliveryContext"];
    delivery?: TestDelivery | null;
  }) {
    const tool = createTestCronTool({
      agentSessionKey: params.agentSessionKey,
      currentDeliveryContext: params.currentDeliveryContext,
    });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: TestDelivery };
    };
    return call?.params?.delivery;
  }

  async function executeAddAndReadSessionKey(params: {
    callId: string;
    agentSessionKey: string;
    jobSessionKey?: string;
  }): Promise<string | undefined> {
    const tool = createTestCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        ...(params.jobSessionKey ? { sessionKey: params.jobSessionKey } : {}),
        payload: { kind: "systemEvent", text: "hello" },
      },
    });
    const call = readGatewayCall();
    const payload = call.params as { sessionKey?: string } | undefined;
    return payload?.sessionKey;
  }

  async function executeAddAndReadAgentId(params: {
    callId: string;
    agentSessionKey: string;
    agentId?: unknown;
    includeAgentId?: boolean;
  }): Promise<unknown> {
    const tool = createTestCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        ...(params.includeAgentId ? { agentId: params.agentId } : {}),
      },
    });
    return readGatewayCall().params?.agentId;
  }

  async function executeAddWithContextMessages(callId: string, contextMessages: number) {
    const tool = createTestCronTool({ agentSessionKey: "main" });
    await tool.execute(callId, {
      action: "add",
      contextMessages,
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });
  }

  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  it("marks cron as owner-only", async () => {
    const tool = createTestCronTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("allows scoped isolated cron runs to remove the current job", async () => {
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    await tool.execute("call-self-remove", {
      action: "remove",
      jobId: "job-current",
    });

    const params = expectSingleGatewayCallMethod("cron.remove");
    expect(params).toEqual({ id: "job-current" });
  });

  it("denies scoped isolated cron runs from removing another job", async () => {
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    await expect(
      tool.execute("call-remove-other", {
        action: "remove",
        jobId: "job-other",
      }),
    ).rejects.toThrow("Cron tool is restricted to removing the current cron job.");

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("denies scoped isolated cron runs from using non-remove cron actions", async () => {
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    await expect(
      tool.execute("call-list", {
        action: "list",
      }),
    ).rejects.toThrow("Cron tool is restricted to removing the current cron job.");

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("documents deferred follow-up guidance in the tool description", () => {
    const tool = createTestCronTool();
    expect(tool.description).toContain(
      'Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks.',
    );
    expect(tool.description).toContain(
      "Do not emulate scheduling with exec sleep or process polling.",
    );
  });

  it("advertises delivery threadId in the tool schema", () => {
    const tool = createTestCronTool();
    const parameters = tool.parameters as SchemaLike;
    const jobThreadId = parameters.properties?.job?.properties?.delivery?.properties?.threadId;
    const patchThreadId = parameters.properties?.patch?.properties?.delivery?.properties?.threadId;

    for (const threadId of [jobThreadId, patchThreadId]) {
      expect(threadId?.description).toContain("Thread/topic id");
      expect(threadId?.anyOf?.map((entry) => entry.type)).toEqual(["string", "number"]);
    }
  });

  it.each([
    [
      "update",
      { action: "update", jobId: "job-1", patch: { foo: "bar" } },
      { id: "job-1", patch: { foo: "bar" } },
    ],
    [
      "update",
      { action: "update", id: "job-2", patch: { foo: "bar" } },
      { id: "job-2", patch: { foo: "bar" } },
    ],
    ["remove", { action: "remove", jobId: "job-1" }, { id: "job-1" }],
    ["remove", { action: "remove", id: "job-2" }, { id: "job-2" }],
    ["run", { action: "run", jobId: "job-1" }, { id: "job-1", mode: "force" }],
    ["run", { action: "run", id: "job-2" }, { id: "job-2", mode: "force" }],
    ["runs", { action: "runs", jobId: "job-1" }, { id: "job-1" }],
    ["runs", { action: "runs", id: "job-2" }, { id: "job-2" }],
  ])("%s sends id to gateway", async (action, args, expectedParams) => {
    const tool = createTestCronTool();
    await tool.execute("call1", args);

    const params = expectSingleGatewayCallMethod(`cron.${action}`);
    expect(params).toEqual(expectedParams);
  });

  it("prefers jobId over id when both are provided", async () => {
    const tool = createTestCronTool();
    await tool.execute("call1", {
      action: "run",
      jobId: "job-primary",
      id: "job-legacy",
    });

    expect(readGatewayCall().params).toEqual({ id: "job-primary", mode: "force" });
  });

  it("supports due-only run mode", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-due", {
      action: "run",
      jobId: "job-due",
      runMode: "due",
    });

    expect(readGatewayCall().params).toEqual({ id: "job-due", mode: "due" });
  });

  it("normalizes cron.add job payloads", async () => {
    const tool = createTestCronTool();
    await tool.execute("call2", {
      action: "add",
      job: {
        data: {
          name: "wake-up",
          schedule: { atMs: 123 },
          payload: { kind: "systemEvent", text: "hello" },
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toEqual({
      name: "wake-up",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });
  });

  it("does not default agentId when job.agentId is null", async () => {
    const tool = createTestCronTool({ agentSessionKey: "main" });
    await tool.execute("call-null", {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        agentId: null,
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { agentId?: unknown };
    };
    expect(call?.params?.agentId).toBeNull();
  });

  it("infers session agentId when job.agentId is omitted", async () => {
    await expect(
      executeAddAndReadAgentId({
        callId: "call-omitted-agent-id",
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      }),
    ).resolves.toBe("agent-123");
  });

  it("infers session agentId when job.agentId is undefined", async () => {
    await expect(
      executeAddAndReadAgentId({
        callId: "call-undefined-agent-id",
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
        includeAgentId: true,
        agentId: undefined,
      }),
    ).resolves.toBe("agent-123");
  });

  it("passes through failureAlert=false for add", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-disable-alerts-add", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        failureAlert: false,
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { failureAlert?: unknown }
      | undefined;
    expect(params?.failureAlert).toBe(false);
  });

  it("recovers flattened add params for failureAlert and payload extras", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-flat-add-extras", {
      action: "add",
      name: "reminder",
      schedule: { at: new Date(123).toISOString() },
      message: "hello",
      lightContext: true,
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
      toolsAllow: [" exec ", " read "],
      failureAlert: { after: 3, cooldownMs: 60_000 },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | {
          payload?: {
            kind?: string;
            message?: string;
            lightContext?: boolean;
            fallbacks?: string[];
            toolsAllow?: string[];
          };
          failureAlert?: { after?: number; cooldownMs?: number };
        }
      | undefined;
    expect(params?.payload).toEqual({
      kind: "agentTurn",
      message: "hello",
      lightContext: true,
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
      toolsAllow: ["exec", "read"],
    });
    expect(params?.failureAlert).toEqual({ after: 3, cooldownMs: 60_000 });
  });

  it("stamps cron.add with caller sessionKey when missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const callerSessionKey = "agent:main:discord:channel:ops";
    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-session-key",
      agentSessionKey: callerSessionKey,
    });
    expect(sessionKey).toBe(callerSessionKey);
  });

  it("preserves explicit job.sessionKey on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-explicit-session-key",
      agentSessionKey: "agent:main:discord:channel:ops",
      jobSessionKey: "agent:main:telegram:group:-100123:topic:99",
    });
    expect(sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });

  it("adds recent context for systemEvent reminders when contextMessages > 0", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: [{ type: "text", text: "Discussed Q2 budget" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "We agreed to review on Tuesday." }],
          },
          { role: "user", content: [{ type: "text", text: "Remind me about the thing at 2pm" }] },
        ],
      })
      .mockResolvedValueOnce({ ok: true });

    await executeAddWithContextMessages("call3", 3);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");

    const cronCall = readGatewayCall(1);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(1);
    expect(text).toContain("Recent context:");
    expect(text).toContain("User: Discussed Q2 budget");
    expect(text).toContain("Assistant: We agreed to review on Tuesday.");
    expect(text).toContain("User: Remind me about the thing at 2pm");
  });

  it("caps contextMessages at 10", async () => {
    const messages = Array.from({ length: 12 }, (_, idx) => ({
      role: "user",
      content: [{ type: "text", text: `Message ${idx + 1}` }],
    }));
    callGatewayMock.mockResolvedValueOnce({ messages }).mockResolvedValueOnce({ ok: true });

    await executeAddWithContextMessages("call5", 20);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");
    const historyParams = historyCall.params as { limit?: number } | undefined;
    expect(historyParams?.limit).toBe(10);

    const text = readCronPayloadText(1);
    expect(text).not.toMatch(/Message 1\\b/);
    expect(text).not.toMatch(/Message 2\\b/);
    expect(text).toContain("Message 3");
    expect(text).toContain("Message 12");
  });

  it("does not add context when contextMessages is 0 (default)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({ agentSessionKey: "main" });
    await tool.execute("call4", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { text: "Reminder: the thing." },
      },
    });

    // Should only call cron.add, not chat.history
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const cronCall = readGatewayCall(0);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(0);
    expect(text).not.toContain("Recent context:");
  });

  it("preserves explicit agentId null on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({ agentSessionKey: "main" });
    await tool.execute("call6", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        agentId: null,
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { agentId?: string | null };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.agentId).toBeNull();
  });

  it("infers delivery from threaded session keys", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-thread",
        agentSessionKey: "agent:main:slack:channel:general:thread:1699999999.0001",
      }),
    ).toEqual({
      mode: "announce",
      channel: "slack",
      to: "general",
    });
  });

  it("preserves telegram forum topics when inferring delivery", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-telegram-topic",
        agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:topic:99",
    });
  });

  it("preserves telegram direct-chat thread ids when inferring delivery", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-telegram-direct-thread",
        agentSessionKey: "agent:main:telegram:direct:123456789:thread:123456789:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "123456789",
      threadId: "99",
    });
  });

  it("preserves telegram account ids with direct-chat thread inference", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-telegram-account-direct-thread",
        agentSessionKey: "agent:main:telegram:bot-a:direct:123456789:thread:123456789:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "123456789",
      accountId: "bot-a",
      threadId: "99",
    });
  });

  it("preserves legacy telegram dm thread ids when inferring delivery", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-telegram-dm-thread",
        agentSessionKey: "agent:main:telegram:dm:123456789:thread:123456789:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "123456789",
      threadId: "99",
    });
  });

  it("drops mismatched telegram direct-chat thread ids when inferring delivery", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-telegram-mismatched-direct-thread",
        agentSessionKey: "agent:main:telegram:direct:123456789:thread:987654321:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "123456789",
    });
  });

  it("prefers current delivery context over lowercased session-key targets", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-current-context",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "room:!AbCdEf1234567890:example.org",
          accountId: "bot-a",
          threadId: "$RootEvent:Example.Org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "room:!AbCdEf1234567890:example.org",
      accountId: "bot-a",
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("does not let current delivery context override explicit delivery targets", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-explicit-target-wins",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "room:!AbCdEf1234567890:example.org",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-100123",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-100123",
    });
  });

  it("keeps explicit delivery account and thread while filling target from context", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-explicit-delivery-fields-win",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
          accountId: "context-bot",
          threadId: "$ContextThread:Example.Org",
        },
        delivery: {
          mode: "announce",
          accountId: "explicit-bot",
          threadId: "$ExplicitThread:Example.Org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
      accountId: "explicit-bot",
      threadId: "$ExplicitThread:Example.Org",
    });
  });

  it("trims current context fields without changing provider target casing", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-trim-current-context",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: " Matrix ",
          to: "  !AbCdEf1234567890:Example.Org  ",
          accountId: " Bot-A ",
          threadId: "  $RootEvent:Example.Org  ",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:Example.Org",
      accountId: "bot-a",
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("infers delivery from current context even when no session key is available", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-context-no-session",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
    });
  });

  it("uses current delivery context when delivery is null", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-null-delivery-current-context",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
        },
        delivery: null,
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
    });
  });

  it("falls back to session-key inference when current context has no target", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-empty-current-context",
        agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
        currentDeliveryContext: {
          channel: "matrix",
          to: "   ",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:topic:99",
    });
  });

  it("does not infer current delivery context when delivery mode is none", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-current-context-mode-none",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
        },
        delivery: { mode: "none" },
      }),
    ).toEqual({ mode: "none" });
  });

  it("infers delivery when delivery is null", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-null-delivery",
        agentSessionKey: "agent:main:dm:alice",
        delivery: null,
      }),
    ).toEqual({
      mode: "announce",
      to: "alice",
    });
  });

  // ── Flat-params recovery (issue #11310) ──────────────────────────────

  it("recovers flat params when job is missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-flat", {
      action: "add",
      name: "flat-job",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "do stuff" },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { name?: string; sessionTarget?: string; payload?: { kind?: string } }
      | undefined;
    expect(params?.name).toBe("flat-job");
    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.payload?.kind).toBe("agentTurn");
  });

  it("recovers flat params when job is empty object", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-empty-job", {
      action: "add",
      job: {},
      name: "empty-job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "wake up" },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { name?: string; sessionTarget?: string; payload?: { text?: string } }
      | undefined;
    expect(params?.name).toBe("empty-job");
    expect(params?.sessionTarget).toBe("main");
    expect(params?.payload?.text).toBe("wake up");
  });

  it("recovers flat message shorthand as agentTurn payload", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-msg-shorthand", {
      action: "add",
      schedule: { kind: "at", at: new Date(456).toISOString() },
      message: "do stuff",
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { kind?: string; message?: string }; sessionTarget?: string }
      | undefined;
    // normalizeCronJobCreate infers agentTurn from message and isolated from agentTurn
    expect(params?.payload?.kind).toBe("agentTurn");
    expect(params?.payload?.message).toBe("do stuff");
    expect(params?.sessionTarget).toBe("isolated");
  });

  it("does not recover flat params when no meaningful job field is present", async () => {
    const tool = createTestCronTool();
    await expect(
      tool.execute("call-no-signal", {
        action: "add",
        name: "orphan-name",
        enabled: true,
      }),
    ).rejects.toThrow("job required");
  });

  it("prefers existing non-empty job over flat params", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-nested-wins", {
      action: "add",
      job: {
        name: "nested-job",
        schedule: { kind: "at", at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "from nested" },
      },
      name: "flat-name-should-be-ignored",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { name?: string; payload?: { text?: string } };
    };
    expect(call?.params?.name).toBe("nested-job");
    expect(call?.params?.payload?.text).toBe("from nested");
  });

  it("does not infer delivery when mode is none", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const delivery = await executeAddAndReadDelivery({
      callId: "call-none",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "none" },
    });
    expect(delivery).toEqual({ mode: "none" });
  });

  it("preserves explicit mode-less delivery objects for add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const delivery = await executeAddAndReadDelivery({
      callId: "call-implicit-announce",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { channel: "telegram", to: "123" },
    });
    expect(delivery).toEqual({
      channel: "telegram",
      to: "123",
    });
  });

  it("does not infer announce delivery when mode is webhook", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const delivery = await executeAddAndReadDelivery({
      callId: "call-webhook-explicit",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    });
    expect(delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });

  it("fails fast when webhook mode is missing delivery.to", async () => {
    const tool = createTestCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-missing", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          delivery: { mode: "webhook" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("fails fast when webhook mode uses a non-http URL", async () => {
    const tool = createTestCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-invalid", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("recovers flat patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat", {
      action: "update",
      jobId: "job-1",
      name: "new-name",
      enabled: false,
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | { id?: string; patch?: { name?: string; enabled?: boolean } }
      | undefined;
    expect(params?.id).toBe("job-1");
    expect(params?.patch?.name).toBe("new-name");
    expect(params?.patch?.enabled).toBe(false);
  });

  it("recovers additional flat patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-extra", {
      action: "update",
      id: "job-2",
      sessionTarget: "main",
      failureAlert: { after: 3, cooldownMs: 60_000 },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            sessionTarget?: string;
            failureAlert?: { after?: number; cooldownMs?: number };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-2");
    expect(params?.patch?.sessionTarget).toBe("main");
    expect(params?.patch?.failureAlert).toEqual({ after: 3, cooldownMs: 60_000 });
  });
  it("passes through failureAlert=false for update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-disable-alerts", {
      action: "update",
      id: "job-4",
      patch: { failureAlert: false },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | { id?: string; patch?: { failureAlert?: unknown } }
      | undefined;
    expect(params?.id).toBe("job-4");
    expect(params?.patch?.failureAlert).toBe(false);
  });

  it("recovers flattened payload patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-payload", {
      action: "update",
      id: "job-3",
      message: "run report",
      model: " openrouter/deepseek/deepseek-r1 ",
      thinking: " high ",
      timeoutSeconds: 45,
      lightContext: true,
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              message?: string;
              model?: string;
              thinking?: string;
              timeoutSeconds?: number;
              lightContext?: boolean;
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-3");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      message: "run report",
      model: "openrouter/deepseek/deepseek-r1",
      thinking: "high",
      timeoutSeconds: 45,
      lightContext: true,
    });
  });

  it("recovers flattened model-only payload patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-model-only", {
      action: "update",
      id: "job-5",
      model: " openrouter/deepseek/deepseek-r1 ",
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
      toolsAllow: [" exec ", " read "],
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              model?: string;
              fallbacks?: string[];
              toolsAllow?: string[];
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-5");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      model: "openrouter/deepseek/deepseek-r1",
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
      toolsAllow: ["exec", "read"],
    });
  });

  it("rejects malformed flattened fallback-only payload patch params for update action", async () => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-update-flat-invalid-fallbacks", {
        action: "update",
        id: "job-9",
        fallbacks: [123],
      }),
    ).rejects.toThrow("patch required");
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("rejects malformed flattened toolsAllow-only payload patch params for update action", async () => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-update-flat-invalid-tools", {
        action: "update",
        id: "job-10",
        toolsAllow: [123],
      }),
    ).rejects.toThrow("patch required");
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("infers kind for nested fallback-only payload patches on update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-nested-fallbacks-only", {
      action: "update",
      id: "job-6",
      patch: {
        payload: {
          fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              fallbacks?: string[];
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-6");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
    });
  });

  it("infers kind for nested toolsAllow-only payload patches on update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-nested-tools-only", {
      action: "update",
      id: "job-7",
      patch: {
        payload: {
          toolsAllow: [" exec ", " read "],
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              toolsAllow?: string[];
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-7");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      toolsAllow: ["exec", "read"],
    });
  });

  it("preserves null toolsAllow payload patches on update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-clear-tools", {
      action: "update",
      id: "job-8",
      patch: {
        payload: {
          toolsAllow: null,
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              toolsAllow?: string[] | null;
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-8");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      toolsAllow: null,
    });
  });
});
