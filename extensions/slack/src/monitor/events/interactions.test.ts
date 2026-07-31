// Slack tests cover interactions plugin behavior.
import type { SlackShortcutMiddlewareArgs } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const requestHeartbeatMock = vi.hoisted(() => vi.fn());
type DispatchPluginInteractiveHandlerResult = {
  matched: boolean;
  handled: boolean;
  duplicate: boolean;
  result?: unknown;
};
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() =>
  vi.fn<(arg: unknown) => Promise<DispatchPluginInteractiveHandlerResult>>(async () => ({
    matched: false,
    handled: false,
    duplicate: false,
  })),
);
const resolvePluginConversationBindingApprovalMock = vi.hoisted(() => vi.fn());
const buildPluginBindingResolvedTextMock = vi.hoisted(() => vi.fn(() => "Binding updated."));
type ApprovalResolveMockResult = {
  applied: boolean;
  approval:
    | { status: "allowed"; decision: "allow-once" | "allow-always" }
    | { status: "denied"; decision: "deny" }
    | { status: "expired" | "cancelled" };
};
const resolveApprovalOverGatewayMock = vi.hoisted(() =>
  vi.fn<(arg: unknown) => Promise<ApprovalResolveMockResult>>(async (_arg: unknown) => ({
    applied: true,
    approval: { status: "allowed", decision: "allow-once" },
  })),
);
const resolveQuestionOverGatewayMock = vi.hoisted(() =>
  vi.fn(async (_arg: unknown) => ({
    status: "answered" as const,
    questionId: "target",
    optionValue: "Production",
  })),
);

let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>();
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/heartbeat-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/heartbeat-runtime")>();
  return {
    ...actual,
    requestHeartbeat: (...args: unknown[]) => requestHeartbeatMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (arg: unknown) => resolveApprovalOverGatewayMock(arg),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: {
    resolveOption: (arg: unknown) => resolveQuestionOverGatewayMock(arg),
  },
}));

vi.mock("../../interactive-dispatch.js", () => ({
  dispatchSlackPluginInteractiveHandler: (params: {
    data: string;
    interactionId: string;
    ctx: {
      interaction?: Record<string, unknown>;
    } & Record<string, unknown>;
    respond: unknown;
  }) =>
    (dispatchPluginInteractiveHandlerMock as (arg: unknown) => Promise<unknown>)({
      channel: "slack",
      data: params.data,
      dedupeId: params.interactionId,
      invoke: async ({
        registration,
        namespace,
        payload,
      }: {
        registration: { handler: (ctx: unknown) => unknown };
        namespace: string;
        payload: string;
      }) =>
        registration.handler({
          ...params.ctx,
          channel: "slack",
          interaction: {
            ...params.ctx.interaction,
            data: params.data,
            namespace,
            payload,
          },
          respond: params.respond,
          requestConversationBinding: vi.fn(),
          detachConversationBinding: vi.fn(),
          getCurrentConversationBinding: vi.fn(),
        }),
    }),
}));

vi.mock("../conversation.runtime.js", () => {
  const parsePluginBindingApprovalCustomId = (value: string) => {
    const prefix = "pluginbind:";
    const trimmed = value.trim();
    if (!trimmed.startsWith(prefix)) {
      return null;
    }
    const body = trimmed.slice(prefix.length);
    const separator = body.lastIndexOf(":");
    if (separator <= 0 || separator === body.length - 1) {
      return null;
    }
    const decisionCode = body.slice(separator + 1).trim();
    const decision =
      decisionCode === "o"
        ? "allow-once"
        : decisionCode === "a"
          ? "allow-always"
          : decisionCode === "d"
            ? "deny"
            : null;
    if (!decision) {
      return null;
    }
    return {
      approvalId: decodeURIComponent(body.slice(0, separator).trim()),
      decision,
    };
  };

  return {
    buildPluginBindingResolvedText: (...args: unknown[]) =>
      (buildPluginBindingResolvedTextMock as (...innerArgs: unknown[]) => string)(...args),
    parsePluginBindingApprovalCustomId,
    resolvePluginConversationBindingApproval: (...args: unknown[]) =>
      (
        resolvePluginConversationBindingApprovalMock as (
          ...innerArgs: unknown[]
        ) => Promise<unknown>
      )(...args),
  };
});

type RegisteredHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user: { id: string };
    team?: { id?: string };
    trigger_id?: string;
    response_url?: string;
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
    message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] };
  };
  action: Record<string, unknown>;
  respond?: (payload: { text: string; response_type: string }) => Promise<void>;
}) => Promise<void>;

type RegisteredViewHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user?: { id?: string };
    team?: { id?: string };
    trigger_id?: string;
    view?: {
      id?: string;
      callback_id?: string;
      private_metadata?: string;
      root_view_id?: string;
      previous_view_id?: string;
      external_id?: string;
      hash?: string;
      state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
    };
  };
}) => Promise<void>;

type RegisteredViewClosedHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user?: { id?: string };
    team?: { id?: string };
    trigger_id?: string;
    view?: {
      id?: string;
      callback_id?: string;
      private_metadata?: string;
      root_view_id?: string;
      previous_view_id?: string;
      external_id?: string;
      hash?: string;
      state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
    };
    is_cleared?: boolean;
  };
}) => Promise<void>;

type RegisteredShortcutHandler = (
  args: Pick<SlackShortcutMiddlewareArgs, "ack" | "body">,
) => Promise<void>;

function createContext(overrides?: {
  dmEnabled?: boolean;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: string[];
  allowNameMatching?: boolean;
  useAccessGroups?: boolean;
  channelsConfig?: Record<string, { users?: string[] }>;
  cfg?: Record<string, unknown>;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  isChannelAllowed?: (params: {
    channelId?: string;
    channelName?: string;
    channelType?: "im" | "mpim" | "channel" | "group";
  }) => boolean;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  resolveChannelName?: (channelId: string) => Promise<{
    name?: string;
    type?: "im" | "mpim" | "channel" | "group";
  }>;
}) {
  let handler: RegisteredHandler | null = null;
  let actionMatcher: RegExp | null = null;
  let viewHandler: RegisteredViewHandler | null = null;
  let viewClosedHandler: RegisteredViewClosedHandler | null = null;
  let shortcutHandler: RegisteredShortcutHandler | null = null;
  const app = {
    action: vi.fn((matcher: RegExp, next: RegisteredHandler) => {
      actionMatcher = matcher;
      handler = next;
    }),
    view: vi.fn((_matcher: RegExp, next: RegisteredViewHandler) => {
      viewHandler = next;
    }),
    viewClosed: vi.fn((_matcher: RegExp, next: RegisteredViewClosedHandler) => {
      viewClosedHandler = next;
    }),
    shortcut: vi.fn((_matcher: RegExp, next: RegisteredShortcutHandler) => {
      shortcutHandler = next;
    }),
    client: {
      chat: {
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  const runtimeLog = vi.fn();
  const resolveSessionKey = vi.fn().mockReturnValue("agent:ops:slack:channel:C1");
  const isChannelAllowed = vi
    .fn<
      (params: {
        channelId?: string;
        channelName?: string;
        channelType?: "im" | "mpim" | "channel" | "group";
      }) => boolean
    >()
    .mockImplementation((params) => overrides?.isChannelAllowed?.(params) ?? true);
  const resolveUserName = vi
    .fn<(userId: string) => Promise<{ name?: string }>>()
    .mockImplementation((userId) => overrides?.resolveUserName?.(userId) ?? Promise.resolve({}));
  const resolveChannelName = vi
    .fn<
      (channelId: string) => Promise<{
        name?: string;
        type?: "im" | "mpim" | "channel" | "group";
      }>
    >()
    .mockImplementation(
      (channelId) => overrides?.resolveChannelName?.(channelId) ?? Promise.resolve({}),
    );
  const ctx = {
    app,
    accountId: "default",
    cfg: overrides?.cfg ?? {
      channels: {
        slack: {
          execApprovals: {
            enabled: true,
            approvers: ["U123"],
            target: "both",
          },
        },
      },
    },
    runtime: { log: runtimeLog },
    dmEnabled: overrides?.dmEnabled ?? true,
    dmPolicy: overrides?.dmPolicy ?? ("open" as const),
    allowFrom: overrides?.allowFrom ?? ["*"],
    allowNameMatching: overrides?.allowNameMatching ?? false,
    useAccessGroups: overrides?.useAccessGroups ?? true,
    channelsConfig: overrides?.channelsConfig ?? {},
    channelsConfigKeys: Object.keys(overrides?.channelsConfig ?? {}),
    defaultRequireMention: true,
    shouldDropMismatchedSlackEvent: (body: unknown) =>
      overrides?.shouldDropMismatchedSlackEvent?.(body) ?? false,
    isChannelAllowed,
    resolveUserName,
    resolveChannelName,
    resolveSlackSystemEventSessionKey: resolveSessionKey,
  };
  return {
    ctx,
    app,
    runtimeLog,
    resolveSessionKey,
    isChannelAllowed,
    resolveUserName,
    resolveChannelName,
    getActionMatcher: () => {
      if (!actionMatcher) {
        throw new Error("Expected Slack action matcher to be registered");
      }
      return actionMatcher;
    },
    getHandler: () => {
      if (!handler) {
        throw new Error("Expected Slack action handler to be registered");
      }
      return handler;
    },
    getViewHandler: () => {
      if (!viewHandler) {
        throw new Error("Expected Slack view handler to be registered");
      }
      return viewHandler;
    },
    getViewClosedHandler: () => {
      if (!viewClosedHandler) {
        throw new Error("Expected Slack view-closed handler to be registered");
      }
      return viewClosedHandler;
    },
    getShortcutHandler: () => {
      if (!shortcutHandler) {
        throw new Error("Expected Slack shortcut handler to be registered");
      }
      return shortcutHandler;
    },
  };
}

type UnknownMock = { mock: { calls: unknown[][] } };

function mockCallArg(mock: unknown, index: number, label: string, argIndex = 0): unknown {
  const calls = (mock as UnknownMock).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`Expected ${label} to be a mock`);
  }
  const call = calls.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call[argIndex];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });
}

function expectRecordFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

function slackInteractionPayload(callIndex = 0): Record<string, unknown> {
  const eventText = mockCallArg(enqueueSystemEventMock, callIndex, "enqueueSystemEvent");
  if (typeof eventText !== "string") {
    throw new Error("Expected Slack interaction event text");
  }
  return JSON.parse(eventText.replace("Slack interaction: ", "")) as Record<string, unknown>;
}

function enqueueSystemEventText(callIndex = 0): string {
  const eventText = mockCallArg(enqueueSystemEventMock, callIndex, "enqueueSystemEvent");
  if (typeof eventText !== "string") {
    throw new Error("Expected Slack interaction event text");
  }
  return eventText;
}

function chatUpdateCall(app: { client: { chat: { update: unknown } } }, callIndex = 0) {
  return requireRecord(
    mockCallArg(app.client.chat.update, callIndex, "chat.update"),
    "chat.update",
  );
}

function inputByActionId(
  inputs: Array<Record<string, unknown>>,
  actionId: string,
): Record<string, unknown> {
  const input = inputs.find((entry) => entry.actionId === actionId);
  if (!input) {
    throw new Error(`Expected input ${actionId}`);
  }
  return input;
}

describe("registerSlackInteractionEvents", () => {
  beforeAll(async () => {
    ({ registerSlackInteractionEvents } = await import("./interactions.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    enqueueSystemEventMock.mockReturnValue(true);
    requestHeartbeatMock.mockClear();
    dispatchPluginInteractiveHandlerMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockResolvedValue({ status: "expired" });
    buildPluginBindingResolvedTextMock.mockClear();
    buildPluginBindingResolvedTextMock.mockReturnValue("Binding updated.");
    resolveApprovalOverGatewayMock.mockClear();
    resolveApprovalOverGatewayMock.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    resolveQuestionOverGatewayMock.mockClear();
    resolveQuestionOverGatewayMock.mockResolvedValue({
      status: "answered",
      questionId: "target",
      optionValue: "Production",
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: false,
      handled: false,
      duplicate: false,
    });
  });

  it("routes global shortcuts to the actor's direct session", async () => {
    const { ctx, getShortcutHandler, resolveSessionKey } = createContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    const ack = vi.fn().mockResolvedValue(undefined);
    await getShortcutHandler()({
      ack,
      body: {
        type: "shortcut",
        callback_id: "capture-note",
        trigger_id: "123.trigger",
        user: { id: "U123", username: "ada", team_id: "T9" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "100.200",
      },
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledOnce();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: undefined,
      channelType: "im",
      senderId: "U123",
      threadTs: undefined,
    });
    expect(slackInteractionPayload()).toMatchObject({
      interactionType: "global_shortcut",
      actionId: "shortcut:capture-note",
      callbackId: "capture-note",
      userId: "U123",
      teamId: "T9",
      triggerId: "[redacted]",
      actionTs: "100.200",
    });
    expect(enqueueSystemEventText()).not.toContain("secret");
    expect(mockCallArg(enqueueSystemEventMock, 0, "enqueueSystemEvent", 1)).toMatchObject({
      sessionKey: "agent:ops:slack:channel:C1",
      deliveryContext: {
        channel: "slack",
        to: "user:U123",
        accountId: "default",
      },
    });
    expect(requestHeartbeatMock).toHaveBeenCalledOnce();
  });

  it("routes message shortcuts with selected-message context", async () => {
    const { ctx, getShortcutHandler, resolveSessionKey } = createContext({
      resolveChannelName: async () => ({ name: "ops", type: "channel" }),
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    await getShortcutHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        type: "message_action",
        callback_id: "summarize-message",
        trigger_id: "456.trigger",
        response_url: "https://hooks.slack.test/response",
        message_ts: "200.300",
        message: {
          type: "message",
          user: "U456",
          ts: "200.300",
          text: "Selected message",
          thread_ts: "200.100",
        },
        user: { id: "U123", name: "ada", team_id: "T9" },
        channel: { id: "C1", name: "ops" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "200.400",
      },
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "200.100",
    });
    expect(slackInteractionPayload()).toMatchObject({
      interactionType: "message_shortcut",
      actionId: "shortcut:summarize-message",
      callbackId: "summarize-message",
      channelId: "C1",
      channelName: "ops",
      messageTs: "200.300",
      threadTs: "200.100",
      messageUserId: "U456",
      messageText: "Selected message",
      triggerId: "[redacted]",
      responseUrl: "[redacted]",
    });
    expect(enqueueSystemEventText()).not.toContain("secret");
    expect(mockCallArg(enqueueSystemEventMock, 0, "enqueueSystemEvent", 1)).toMatchObject({
      deliveryContext: {
        channel: "slack",
        to: "channel:C1",
        accountId: "default",
        threadId: "200.100",
      },
    });
  });

  it("acknowledges mismatched shortcuts before dropping them", async () => {
    const order: string[] = [];
    const { ctx, getShortcutHandler } = createContext({
      shouldDropMismatchedSlackEvent: () => {
        order.push("filter");
        return true;
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    await getShortcutHandler()({
      ack: vi.fn(async () => {
        order.push("ack");
      }),
      body: {
        type: "shortcut",
        callback_id: "capture-note",
        trigger_id: "123.trigger",
        user: { id: "U123", username: "ada", team_id: "T9" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "100.200",
      },
    });

    expect(order).toEqual(["ack", "filter"]);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("enforces DM policy for global shortcuts", async () => {
    const { ctx, getShortcutHandler } = createContext({
      dmEnabled: false,
      dmPolicy: "disabled",
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    await getShortcutHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        type: "shortcut",
        callback_id: "capture-note",
        trigger_id: "123.trigger",
        user: { id: "U123", username: "ada", team_id: "T9" },
        team: { id: "T9", domain: "example" },
        token: "secret",
        action_ts: "100.200",
      },
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("enqueues structured events and updates button rows", async () => {
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        trigger_id: "123.trigger",
        response_url: "https://hooks.slack.test/response",
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            { type: "divider" },
            {
              type: "actions",
              block_id: "deploy_row",
              elements: [
                {
                  type: "button",
                  action_id: "deploy_all_services",
                  text: { type: "plain_text", text: "Deploy all services" },
                },
              ],
            },
            {
              type: "actions",
              block_id: "verify_block",
              elements: [{ type: "button", action_id: "openclaw:verify" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
        value: "approved",
        text: { type: "plain_text", text: "Approve" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = mockCallArg(enqueueSystemEventMock, 0, "enqueueSystemEvent");
    expect(typeof eventText === "string" && eventText.startsWith("Slack interaction: ")).toBe(true);
    const payload = slackInteractionPayload();
    expectRecordFields(payload, {
      actionId: "openclaw:verify",
      actionType: "button",
      value: "approved",
      userId: "U123",
      teamId: "T9",
      triggerId: "[redacted]",
      responseUrl: "[redacted]",
      channelId: "C1",
      messageTs: "100.200",
      threadTs: "100.100",
    });
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "100.100",
    });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      blocks: [
        { type: "divider" },
        {
          type: "actions",
          block_id: "deploy_row",
          elements: [
            {
              type: "button",
              action_id: "deploy_all_services",
              text: { type: "plain_text", text: "Deploy all services" },
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: ":white_check_mark: *Approve* selected by <@U123>",
            },
          ],
        },
      ],
    });
  });

  it("registers a matcher that accepts plugin action ids beyond the OpenClaw prefix", () => {
    const { ctx, getActionMatcher } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const matcher = getActionMatcher();
    expect(matcher.test("openclaw:verify")).toBe(true);
    expect(matcher.test("codex")).toBe(true);
  });

  it("routes matching Slack actions through the shared plugin interactive dispatcher", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        trigger_id: "123.trigger",
        response_url: "https://hooks.slack.test/response",
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
        text: { type: "plain_text", text: "Approve" },
      },
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCall = mockCallArg(
      dispatchPluginInteractiveHandlerMock,
      0,
      "plugin interactive dispatcher",
    ) as
      | {
          channel?: string;
          data?: string;
          dedupeId?: string;
          invoke?: (params: {
            registration: { handler: (ctx: unknown) => unknown };
            namespace: string;
            payload: string;
          }) => Promise<unknown>;
        }
      | undefined;
    expectRecordFields(requireRecord(dispatchCall, "dispatch call"), {
      channel: "slack",
      data: "codex:approve:thread-1",
      dedupeId: "U123:C1:100.200:123.trigger:codex:approve:thread-1",
    });
    const registrationHandler = vi.fn();
    await dispatchCall?.invoke?.({
      registration: { handler: registrationHandler },
      namespace: "codex",
      payload: "approve:thread-1",
    });
    const registrationCtx = requireRecord(
      mockCallArg(registrationHandler, 0, "registration handler"),
      "registration handler ctx",
    );
    expectRecordFields(registrationCtx, {
      accountId: ctx.accountId,
      conversationId: "C1",
      interactionId: "U123:C1:100.200:123.trigger:codex:approve:thread-1",
      threadId: "100.100",
    });
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(true);
    expectRecordFields(requireRecord(registrationCtx.interaction, "registration interaction"), {
      actionId: "codex",
      value: "approve:thread-1",
      data: "codex:approve:thread-1",
      namespace: "codex",
      payload: "approve:thread-1",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("passes false command auth to Slack plugin interactions for non-allowlisted senders", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { ctx, getHandler } = createContext({
      cfg: {
        commands: {
          allowFrom: {
            slack: ["U_OWNER"],
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U_ALLOWED" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
      },
    });

    const dispatchCall = mockCallArg(
      dispatchPluginInteractiveHandlerMock,
      0,
      "plugin interactive dispatcher",
    ) as
      | {
          invoke?: (params: {
            registration: { handler: (ctx: unknown) => unknown };
            namespace: string;
            payload: string;
          }) => Promise<unknown>;
        }
      | undefined;
    const registrationHandler = vi.fn();
    await dispatchCall?.invoke?.({
      registration: { handler: registrationHandler },
      namespace: "codex",
      payload: "approve:thread-1",
    });

    const registrationCtx = requireRecord(
      mockCallArg(registrationHandler, 0, "registration handler"),
      "registration handler ctx",
    );
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(false);
  });

  it("passes true command auth to Slack plugin interactions for allowlisted senders", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { ctx, getHandler } = createContext({
      cfg: {
        commands: {
          allowFrom: {
            slack: ["U_OWNER"],
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U_OWNER" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
      },
    });

    const dispatchCall = mockCallArg(
      dispatchPluginInteractiveHandlerMock,
      0,
      "plugin interactive dispatcher",
    ) as
      | {
          invoke?: (params: {
            registration: { handler: (ctx: unknown) => unknown };
            namespace: string;
            payload: string;
          }) => Promise<unknown>;
        }
      | undefined;
    const registrationHandler = vi.fn();
    await dispatchCall?.invoke?.({
      registration: { handler: registrationHandler },
      namespace: "codex",
      payload: "approve:thread-1",
    });

    const registrationCtx = requireRecord(
      mockCallArg(registrationHandler, 0, "registration handler"),
      "registration handler ctx",
    );
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(true);
  });

  it("treats Slack reply buttons as plain interaction events instead of plugin dispatch", async () => {
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "reply_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "reply_actions",
        value: "codex",
        text: { type: "plain_text", text: "codex" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    const eventText = mockCallArg(enqueueSystemEventMock, 0, "enqueueSystemEvent");
    expect(eventText).toContain('"actionId":"openclaw:reply_button"');
    expectRecordFields(
      requireRecord(
        mockCallArg(enqueueSystemEventMock, 0, "enqueueSystemEvent", 1),
        "event options",
      ),
      {
        contextKey: "slack:interaction:C1:100.200:openclaw:reply_button",
        deliveryContext: {
          accountId: "default",
          channel: "slack",
          threadId: "100.100",
          to: "channel:C1",
        },
        sessionKey: "agent:ops:slack:channel:C1",
      },
    );
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
      senderId: "U123",
      threadTs: "100.100",
    });
    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "hook",
      intent: "immediate",
      reason: "hook:slack-interaction",
      sessionKey: "agent:ops:slack:channel:C1",
      heartbeat: { target: "last" },
    });
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("keeps typed callback payloads opaque even when they resemble approval commands", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: { ts: "100.200", text: "Choose", blocks: [] },
      },
      action: {
        type: "button",
        action_id: "openclaw:callback_button:1:1",
        value: "/approve req-1 deny",
        text: { type: "plain_text", text: "Choose" },
      },
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expectRecordFields(
      requireRecord(
        mockCallArg(dispatchPluginInteractiveHandlerMock, 0, "plugin interactive dispatcher"),
        "plugin interactive dispatcher",
      ),
      { channel: "slack", data: "/approve req-1 deny" },
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("uses unique interaction ids for repeated Slack actions on the same message", async () => {
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: false,
      duplicate: false,
    });
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        trigger_id: "trigger-1",
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
        text: { type: "plain_text", text: "Approve" },
      },
    });
    await handler({
      ack,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        trigger_id: "trigger-2",
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "codex_actions",
              elements: [{ type: "button", action_id: "codex" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "codex",
        block_id: "codex_actions",
        value: "approve:thread-1",
        text: { type: "plain_text", text: "Approve" },
      },
    });

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(2);
    const calls = dispatchPluginInteractiveHandlerMock.mock.calls as unknown[][];
    const firstCall = calls[0]?.[0] as
      | {
          dedupeId?: string;
        }
      | undefined;
    const secondCall = calls[1]?.[0] as
      | {
          dedupeId?: string;
        }
      | undefined;
    expect(firstCall?.dedupeId).toContain(":trigger-1:");
    expect(secondCall?.dedupeId).toContain(":trigger-2:");
    expect(firstCall?.dedupeId).not.toBe(secondCall?.dedupeId);
  });

  it("resolves plugin binding approvals from shared interactive Slack actions", async () => {
    resolvePluginConversationBindingApprovalMock.mockResolvedValueOnce({
      status: "approved",
      decision: "allow-once",
      request: {
        pluginId: "codex",
        pluginName: "Codex",
        summary: "for this thread",
      },
    });
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          ts: "100.200",
          text: "Approve this bind?",
          blocks: [
            {
              type: "actions",
              block_id: "bind_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "bind_actions",
        value: "pluginbind:approval-123:o",
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolvePluginConversationBindingApprovalMock).toHaveBeenCalledWith({
      approvalId: "approval-123",
      decision: "allow-once",
      senderId: "U123",
    });
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Approve this bind?",
      blocks: [],
    });
    expect(respond).toHaveBeenCalledWith({
      text: "Binding updated.",
      response_type: "ephemeral",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("resolves typed exec approvals from Slack-private action data", async () => {
    const { ctx, app, getHandler } = createContext({
      allowFrom: ["U999"],
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["u123"],
              target: "both",
            },
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
        message: {
          ts: "100.200",
          text: "Exec approval required",
          blocks: [
            {
              type: "actions",
              block_id: "exec_actions",
              elements: [
                { type: "button", action_id: "openclaw:approval_button:1:1" },
                { type: "button", action_id: "openclaw:reply_button" },
              ],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"plugin:looks-plugin","approvalKind":"exec","decision":"allow-once"}',
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "plugin:looks-plugin",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "U123",
      clientDisplayName: "Slack approval (U123)",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Resolved: Allowed once",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Resolved: Allowed once*" },
        },
        {
          type: "actions",
          block_id: "exec_actions",
          elements: [{ type: "button", action_id: "openclaw:reply_button" }],
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("resolves typed question buttons without enqueueing an agent interaction", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: { ts: "100.200", text: "Question", blocks: [] },
      },
      action: {
        type: "button",
        action_id: "openclaw:question_button:1:2",
        block_id: "openclaw_reply_buttons_1",
        value: `slq1:${questionId}:1`,
        text: { type: "plain_text", text: "Production" },
      },
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(resolveQuestionOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      questionId,
      optionIndex: 1,
      senderId: "U123",
      clientDisplayName: "Slack question (default)",
    });
    expect(respond).toHaveBeenCalledWith({
      text: "Answer submitted.",
      response_type: "ephemeral",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("cleans stale typed buttons and shows the canonical first-answer winner", async () => {
    resolveApprovalOverGatewayMock.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["U123"],
              target: "both",
            },
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const respond = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "Exec approval required",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "*Exec approval required*\nA command needs approval." },
            },
            { type: "section", text: { type: "mrkdwn", text: "Command preview" } },
            {
              type: "actions",
              block_id: "exec_actions",
              elements: [
                { type: "button", action_id: "openclaw:approval_button:1:1" },
                { type: "button", action_id: "openclaw:approval_button:1:2" },
              ],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-123",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "U123",
      clientDisplayName: "Slack approval (U123)",
    });
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Already resolved: Denied",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Already resolved: Denied*" },
        },
        { type: "section", text: { type: "mrkdwn", text: "Command preview" } },
      ],
    });
    expect(respond).toHaveBeenCalledWith({
      text: "This approval was already resolved: Denied.",
      response_type: "ephemeral",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("shows canonical typed approval truth when the clicked message update fails", async () => {
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["U123"],
              target: "both",
            },
          },
        },
      },
    });
    app.client.chat.update.mockRejectedValueOnce(new Error("message update failed"));
    registerSlackInteractionEvents({ ctx: ctx as never });
    const respond = vi.fn().mockResolvedValue(undefined);

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: { ts: "100.200", text: "Exec approval required", blocks: [] },
      },
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(respond).toHaveBeenCalledWith({
      text: "Approval resolved: Allowed once.",
      response_type: "ephemeral",
    });
  });

  it("tells the clicker when a typed approval is no longer pending", async () => {
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["U123"],
              target: "both",
            },
          },
        },
      },
    });
    resolveApprovalOverGatewayMock.mockRejectedValueOnce(
      new Error("unknown or expired approval id"),
    );
    registerSlackInteractionEvents({ ctx: ctx as never });
    const respond = vi.fn().mockResolvedValue(undefined);

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: { ts: "100.200", text: "Exec approval required", blocks: [] },
      },
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"exec","decision":"allow-once"}',
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This approval is no longer pending.",
      response_type: "ephemeral",
    });
  });

  it("fails closed for malformed Slack approval envelopes", async () => {
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const respond = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: { ts: "100.200", text: "Exec approval required", blocks: [] },
      },
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "exec_actions",
        value: 'openclaw:approval:v1:{"approvalId":"req-123","decision":"allow-once"}',
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This approval action is invalid or expired.",
      response_type: "ephemeral",
    });
  });

  it("uses the typed plugin kind for unprefixed approval ids", async () => {
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                allowFrom: ["u123owner"],
                execApprovals: {
                  enabled: true,
                  approvers: ["U999EXEC"],
                  target: "both",
                },
              },
            },
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123OWNER" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "Plugin approval required",
          blocks: [
            {
              type: "actions",
              block_id: "plugin_actions",
              elements: [{ type: "button", action_id: "openclaw:approval_button:1:1" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:approval_button:1:1",
        block_id: "plugin_actions",
        value:
          'openclaw:approval:v1:{"approvalId":"req-123","approvalKind":"plugin","decision":"allow-always"}',
        text: { type: "plain_text", text: "Always allow" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-123",
      approvalKind: "plugin",
      decision: "allow-always",
      senderId: "U123OWNER",
      clientDisplayName: "Slack approval (U123OWNER)",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Resolved: Allowed once",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Resolved: Allowed once*" },
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("routes opaque legacy ids through the authorized plugin adapter", async () => {
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                allowFrom: ["u123owner"],
                execApprovals: {
                  enabled: true,
                  approvers: ["U999EXEC"],
                  target: "both",
                },
              },
            },
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123OWNER" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "Plugin approval required",
          blocks: [
            {
              type: "actions",
              block_id: "plugin_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "plugin_actions",
        value: "/approve req-legacy allow-once",
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-legacy",
      decision: "allow-once",
      senderId: "U123OWNER",
      resolveMethod: "plugin",
      clientDisplayName: "Slack approval (U123OWNER)",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Plugin approval required",
      blocks: [],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("preserves legacy unprefixed fallback when the sender may approve either kind", async () => {
    resolveApprovalOverGatewayMock
      .mockRejectedValueOnce(new Error("unknown or expired approval id"))
      .mockResolvedValueOnce({
        applied: true,
        approval: { status: "allowed", decision: "allow-once" },
      });
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                allowFrom: ["U123OWNER"],
                execApprovals: {
                  enabled: true,
                  approvers: ["U123OWNER"],
                  target: "both",
                },
              },
            },
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    await getHandler()({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: "U123OWNER" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "Plugin approval required",
          blocks: [
            {
              type: "actions",
              block_id: "plugin_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "plugin_actions",
        value: "/approve req-legacy allow-once",
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    const expectedCommon = {
      cfg: ctx.cfg,
      approvalId: "req-legacy",
      decision: "allow-once",
      senderId: "U123OWNER",
      clientDisplayName: "Slack approval (U123OWNER)",
    };
    expect(resolveApprovalOverGatewayMock).toHaveBeenNthCalledWith(1, {
      ...expectedCommon,
      resolveMethod: "exec",
    });
    expect(resolveApprovalOverGatewayMock).toHaveBeenNthCalledWith(2, {
      ...expectedCommon,
      resolveMethod: "plugin",
    });
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Plugin approval required",
      blocks: [],
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("does not treat a plugin-looking legacy id as an owner signal", async () => {
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                allowFrom: ["U123OWNER"],
                execApprovals: {
                  enabled: true,
                  approvers: ["U999EXEC"],
                  target: "both",
                },
              },
            },
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U999EXEC" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "Plugin approval required",
          blocks: [
            {
              type: "actions",
              block_id: "plugin_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "plugin_actions",
        value: "/approve plugin:req-123 allow-always",
        text: { type: "plain_text", text: "Always allow" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "plugin:req-123",
      decision: "allow-always",
      senderId: "U999EXEC",
      resolveMethod: "exec",
      clientDisplayName: "Slack approval (U999EXEC)",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "100.200",
      text: "Plugin approval required",
      blocks: [],
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    { name: "current", actionId: "openclaw:reply_link:1:1", value: undefined },
    {
      name: "legacy",
      actionId: "openclaw:reply_button:1:1",
      value: "/approve req-1 allow-once",
    },
  ])("ignores $name Slack callbacks emitted for link-only reply buttons", async (testCase) => {
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const ack = vi.fn().mockResolvedValue(undefined);
    await getHandler()({
      ack,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "reply_actions",
              elements: [{ type: "button", action_id: testCase.actionId }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: testCase.actionId,
        block_id: "reply_actions",
        url: "https://example.com/app",
        ...(testCase.value ? { value: testCase.value } : {}),
        text: { type: "plain_text", text: "Launch" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("keeps exec approval buttons when gateway resolution fails", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValueOnce(new Error("gateway down"));
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await expect(
      handler({
        ack,
        body: {
          user: { id: "U123" },
          channel: { id: "C1" },
          container: { channel_id: "C1", message_ts: "100.200" },
          message: {
            ts: "100.200",
            text: "Exec approval required",
            blocks: [
              {
                type: "actions",
                block_id: "exec_actions",
                elements: [{ type: "button", action_id: "openclaw:reply_button" }],
              },
            ],
          },
        },
        action: {
          type: "button",
          action_id: "openclaw:reply_button",
          block_id: "exec_actions",
          value: "/approve req-123 allow-once",
          text: { type: "plain_text", text: "Allow once" },
        },
      }),
    ).rejects.toThrow("gateway down");

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("rejects unauthorized exec approval interactions without enqueueing them", async () => {
    const { ctx, app, getHandler } = createContext({
      cfg: {
        channels: {
          slack: {
            execApprovals: {
              enabled: true,
              approvers: ["U999"],
              target: "both",
            },
          },
        },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "Exec approval required",
          blocks: [
            {
              type: "actions",
              block_id: "exec_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "exec_actions",
        value: "/approve req-123 allow-once",
        text: { type: "plain_text", text: "Allow once" },
      },
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to approve this request.",
      response_type: "ephemeral",
    });
  });

  it("drops block actions when mismatch guard triggers", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      shouldDropMismatchedSlackEvent: () => true,
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
      },
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("drops modal lifecycle payloads when mismatch guard triggers", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler, getViewClosedHandler } = createContext({
      shouldDropMismatchedSlackEvent: () => true,
    });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const viewHandler = getViewHandler();
    const viewClosedHandler = getViewClosedHandler();

    const ackSubmit = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack: ackSubmit,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        view: {
          id: "V123",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({ userId: "U123" }),
        },
      },
    });
    expect(ackSubmit).toHaveBeenCalledTimes(1);

    const ackClosed = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler({
      ack: ackClosed,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        view: {
          id: "V123",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({ userId: "U123" }),
        },
      },
    });
    expect(ackClosed).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("does not ack unrelated modal lifecycle payloads", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U123" },
        team: { id: "T9" },
        view: {
          id: "V123",
          callback_id: "third_party_modal",
        },
      },
    });

    expect(ack).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
  });

  it("captures select values and updates action rows for non-button actions", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U555" },
        channel: { id: "C1" },
        message: {
          ts: "111.222",
          blocks: [{ type: "actions", block_id: "select_block", elements: [] }],
        },
      },
      action: {
        type: "static_select",
        action_id: "openclaw:pick",
        block_id: "select_block",
        selected_option: {
          text: { type: "plain_text", text: "Canary" },
          value: "canary",
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType: string;
      selectedValues?: string[];
      selectedLabels?: string[];
    };
    expect(payload.actionType).toBe("static_select");
    expect(payload.selectedValues).toEqual(["canary"]);
    expect(payload.selectedLabels).toEqual(["Canary"]);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "111.222",
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: ":white_check_mark: *Canary* selected by <@U555>" }],
        },
      ],
    });
  });

  it("blocks block actions from users outside configured channel users allowlist", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      channelsConfig: {
        C1: { users: ["U_ALLOWED"] },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_DENIED" },
        channel: { id: "C1" },
        message: {
          ts: "201.202",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this control.",
      response_type: "ephemeral",
    });
  });

  it("blocks channel block actions when sender is outside configured global allowFrom", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      allowFrom: ["U_OWNER"],
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_ATTACKER" },
        channel: { id: "C1" },
        message: {
          ts: "250.251",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this control.",
      response_type: "ephemeral",
    });
  });

  it("allows channel block actions when channel users allowlist authorizes the sender", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      allowFrom: ["U_OWNER"],
      channelsConfig: {
        C1: { users: ["U_ALLOWED"] },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_ALLOWED" },
        channel: { id: "C1" },
        message: {
          ts: "260.261",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
  });

  it("blocks wildcard global allowFrom from bypassing configured channel users", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      allowFrom: ["*"],
      channelsConfig: {
        C1: { users: ["U_ALLOWED"] },
      },
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_ATTACKER" },
        channel: { id: "C1" },
        message: {
          ts: "270.271",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this control.",
      response_type: "ephemeral",
    });
  });

  it("keeps channel block actions open when no allowlists are configured", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({ allowFrom: [] });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_ANYONE" },
        channel: { id: "C1" },
        message: {
          ts: "305.306",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
  });

  it("blocks DM block actions when sender is not in allowFrom", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      dmPolicy: "allowlist",
      allowFrom: ["U_OWNER"],
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_ATTACKER" },
        channel: { id: "D222" },
        message: {
          ts: "301.302",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this control.",
      response_type: "ephemeral",
    });
  });

  it("blocks MPIM block actions when sender is outside configured allowFrom", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      allowFrom: ["U_OWNER"],
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_ATTACKER" },
        channel: { id: "G_MPIM" },
        message: {
          ts: "311.312",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this control.",
      response_type: "ephemeral",
    });
  });

  it("allows MPIM block actions when sender is in configured allowFrom", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext({
      allowFrom: ["U_OWNER"],
      resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
    });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      respond,
      body: {
        user: { id: "U_OWNER" },
        channel: { id: "G_MPIM" },
        message: {
          ts: "313.314",
          blocks: [{ type: "actions", block_id: "verify_block", elements: [] }],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
  });

  it("ignores malformed action payloads after ack and logs warning", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler, runtimeLog } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U666" },
        channel: { id: "C1" },
        message: {
          ts: "777.888",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "verify_block",
              elements: [{ type: "button", action_id: "openclaw:verify" }],
            },
          ],
        },
      },
      action: "not-an-action-object" as unknown as Record<string, unknown>,
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledWith(
      "slack:interaction malformed action payload channel=C1 user=U666",
    );
  });

  it("escapes mrkdwn characters in confirmation labels", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U556" },
        channel: { id: "C1" },
        message: {
          ts: "111.223",
          blocks: [{ type: "actions", block_id: "select_block", elements: [] }],
        },
      },
      action: {
        type: "static_select",
        action_id: "openclaw:pick",
        block_id: "select_block",
        selected_option: {
          text: { type: "plain_text", text: "Canary_*`~<&>" },
          value: "canary",
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expectRecordFields(chatUpdateCall(app), {
      channel: "C1",
      ts: "111.223",
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: ":white_check_mark: *Canary\\_\\*\\`\\~&lt;&amp;&gt;* selected by <@U556>",
            },
          ],
        },
      ],
    });
  });

  it("falls back to container channel and message timestamps", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U111" },
        team: { id: "T111" },
        container: { channel_id: "C222", message_ts: "222.333", thread_ts: "222.111" },
      },
      action: {
        type: "button",
        action_id: "openclaw:container",
        block_id: "container_block",
        value: "ok",
        text: { type: "plain_text", text: "Container" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C222",
      channelType: "channel",
      senderId: "U111",
      threadTs: "222.111",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      channelId?: string;
      messageTs?: string;
      threadTs?: string;
      teamId?: string;
    };
    expectRecordFields(payload as unknown as Record<string, unknown>, {
      channelId: "C222",
      messageTs: "222.333",
      threadTs: "222.111",
      teamId: "T111",
    });
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("uses the message thread timestamp when Slack omits the container thread", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U333" },
        team: { id: "T333" },
        channel: { id: "C333" },
        container: { channel_id: "C333", message_ts: "333.444" },
        message: {
          ts: "333.444",
          thread_ts: "333.111",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "reply_actions",
              elements: [{ type: "button", action_id: "openclaw:reply_button" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:reply_button",
        block_id: "reply_actions",
        value: "continue",
        text: { type: "plain_text", text: "Continue" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C333",
      channelType: "channel",
      senderId: "U333",
      threadTs: "333.111",
    });
    expectRecordFields(slackInteractionPayload(), {
      channelId: "C333",
      messageTs: "333.444",
      threadTs: "333.111",
      teamId: "T333",
    });
    const eventOptions = requireRecord(
      mockCallArg(enqueueSystemEventMock, 0, "enqueueSystemEvent", 1),
      "event options",
    );
    expectRecordFields(requireRecord(eventOptions.deliveryContext, "delivery context"), {
      channel: "slack",
      to: "channel:C333",
      accountId: "default",
      threadId: "333.111",
    });
  });

  it("summarizes multi-select confirmations in updated message rows", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U222" },
        channel: { id: "C2" },
        message: {
          ts: "333.444",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "multi_block",
              elements: [{ type: "multi_static_select", action_id: "openclaw:multi" }],
            },
          ],
        },
      },
      action: {
        type: "multi_static_select",
        action_id: "openclaw:multi",
        block_id: "multi_block",
        selected_options: [
          { text: { type: "plain_text", text: "Alpha" }, value: "alpha" },
          { text: { type: "plain_text", text: "Beta" }, value: "beta" },
          { text: { type: "plain_text", text: "Gamma" }, value: "gamma" },
          { text: { type: "plain_text", text: "Delta" }, value: "delta" },
        ],
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expectRecordFields(chatUpdateCall(app), {
      channel: "C2",
      ts: "333.444",
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: ":white_check_mark: *Alpha, Beta, Gamma +1* selected by <@U222>",
            },
          ],
        },
      ],
    });
  });

  it("renders date/time/datetime picker selections in confirmation rows", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U333" },
        channel: { id: "C3" },
        message: {
          ts: "555.666",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "date_block",
              elements: [{ type: "datepicker", action_id: "openclaw:date" }],
            },
            {
              type: "actions",
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
            },
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
      },
      action: {
        type: "datepicker",
        action_id: "openclaw:date",
        block_id: "date_block",
        selected_date: "2026-02-16",
      },
    });

    await handler({
      ack,
      body: {
        user: { id: "U333" },
        channel: { id: "C3" },
        message: {
          ts: "555.667",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
            },
          ],
        },
      },
      action: {
        type: "timepicker",
        action_id: "openclaw:time",
        block_id: "time_block",
        selected_time: "14:30",
      },
    });

    await handler({
      ack,
      body: {
        user: { id: "U333" },
        channel: { id: "C3" },
        message: {
          ts: "555.668",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
      },
      action: {
        type: "datetimepicker",
        action_id: "openclaw:datetime",
        block_id: "datetime_block",
        selected_date_time: selectedDateTimeEpoch,
      },
    });

    const firstUpdate = chatUpdateCall(app, 0);
    const firstBlocks = firstUpdate.blocks as unknown[];
    expectRecordFields(firstUpdate, { channel: "C3", ts: "555.666" });
    expect(firstBlocks).toHaveLength(3);
    expect(firstBlocks[0]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: ":white_check_mark: *2026-02-16* selected by <@U333>" }],
    });

    expectRecordFields(chatUpdateCall(app, 1), {
      channel: "C3",
      ts: "555.667",
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: ":white_check_mark: *14:30* selected by <@U333>" }],
        },
      ],
    });
    expectRecordFields(chatUpdateCall(app, 2), {
      channel: "C3",
      ts: "555.668",
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `:white_check_mark: *${new Date(
                selectedDateTimeEpoch * 1000,
              ).toISOString()}* selected by <@U333>`,
            },
          ],
        },
      ],
    });
  });

  it("captures expanded selection and temporal payload fields", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U321" },
        channel: { id: "C2" },
        message: { ts: "222.333" },
      },
      action: {
        type: "multi_conversations_select",
        action_id: "openclaw:route",
        selected_user: "U777",
        selected_users: ["U777", "U888"],
        selected_channel: "C777",
        selected_channels: ["C777", "C888"],
        selected_conversation: "G777",
        selected_conversations: ["G777", "G888"],
        selected_options: [
          { text: { type: "plain_text", text: "Alpha" }, value: "alpha" },
          { text: { type: "plain_text", text: "Alpha" }, value: "alpha" },
          { text: { type: "plain_text", text: "Beta" }, value: "beta" },
        ],
        selected_date: "2026-02-16",
        selected_time: "14:30",
        selected_date_time: 1_771_700_200,
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType: string;
      selectedValues?: string[];
      selectedUsers?: string[];
      selectedChannels?: string[];
      selectedConversations?: string[];
      selectedLabels?: string[];
      selectedDate?: string;
      selectedTime?: string;
      selectedDateTime?: number;
    };
    expect(payload.actionType).toBe("multi_conversations_select");
    expect(payload.selectedValues).toEqual([
      "alpha",
      "beta",
      "U777",
      "U888",
      "C777",
      "C888",
      "G777",
      "G888",
    ]);
    expect(payload.selectedUsers).toEqual(["U777", "U888"]);
    expect(payload.selectedChannels).toEqual(["C777", "C888"]);
    expect(payload.selectedConversations).toEqual(["G777", "G888"]);
    expect(payload.selectedLabels).toEqual(["Alpha", "Beta"]);
    expect(payload.selectedDate).toBe("2026-02-16");
    expect(payload.selectedTime).toBe("14:30");
    expect(payload.selectedDateTime).toBe(1_771_700_200);
  });

  it("falls back when Slack datetime selection is outside Date range", async () => {
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U333" },
        channel: { id: "C3" },
        message: {
          ts: "555.669",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
      },
      action: {
        type: "datetimepicker",
        action_id: "openclaw:datetime",
        block_id: "datetime_block",
        selected_date_time: 9_000_000_000_000,
      },
    });

    expectRecordFields(chatUpdateCall(app), {
      channel: "C3",
      ts: "555.669",
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: ":white_check_mark: *openclaw:datetime* selected by <@U333>",
            },
          ],
        },
      ],
    });
  });

  it("captures workflow button trigger metadata", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U420" },
        team: { id: "T420" },
        channel: { id: "C420" },
        message: { ts: "420.420" },
      },
      action: {
        type: "workflow_button",
        action_id: "openclaw:workflow",
        block_id: "workflow_block",
        text: { type: "plain_text", text: "Launch workflow" },
        workflow: {
          trigger_url: "https://slack.com/workflows/triggers/T420/12345",
          workflow_id: "Wf12345",
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType?: string;
      workflowTriggerUrl?: string;
      workflowId?: string;
      teamId?: string;
      channelId?: string;
    };
    expectRecordFields(payload as unknown as Record<string, unknown>, {
      actionType: "workflow_button",
      workflowTriggerUrl: "[redacted]",
      workflowId: "Wf12345",
      teamId: "T420",
      channelId: "C420",
    });
  });

  it("captures modal submissions and enqueues view submission event", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler, resolveSessionKey } = createContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U777" },
        team: { id: "T1" },
        view: {
          id: "V123",
          callback_id: "openclaw:deploy_form",
          root_view_id: "VROOT",
          previous_view_id: "VPREV",
          external_id: "deploy-ext-1",
          hash: "view-hash-1",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
            userId: "U777",
          }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: {
                    text: { type: "plain_text", text: "Production" },
                    value: "prod",
                  },
                },
              },
              notes_block: {
                notes_input: {
                  type: "plain_text_input",
                  value: "ship now",
                },
              },
            },
          },
        } as unknown as {
          id?: string;
          callback_id?: string;
          root_view_id?: string;
          previous_view_id?: string;
          external_id?: string;
          hash?: string;
          state?: { values: Record<string, unknown> };
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      actionId: string;
      callbackId: string;
      viewId: string;
      userId: string;
      routedChannelId?: string;
      rootViewId?: string;
      previousViewId?: string;
      externalId?: string;
      viewHash?: string;
      isStackedView?: boolean;
      inputs: Array<{ actionId: string; selectedValues?: string[]; inputValue?: string }>;
    };
    expectRecordFields(payload as unknown as Record<string, unknown>, {
      interactionType: "view_submission",
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      viewId: "V123",
      userId: "U777",
      routedChannelId: "D123",
      rootViewId: "VROOT",
      previousViewId: "VPREV",
      externalId: "deploy-ext-1",
      viewHash: "[redacted]",
      isStackedView: true,
    });
    const envInput = payload.inputs.find((input) => input.actionId === "env_select");
    const notesInput = payload.inputs.find((input) => input.actionId === "notes_input");
    expect(envInput?.selectedValues).toEqual(["prod"]);
    expect(notesInput?.inputValue).toBe("ship now");
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("dispatches plugin-owned modal submissions with full view state before compacting events", async () => {
    enqueueSystemEventMock.mockClear();
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
      result: {
        systemEvent: {
          summary: "Contract form stored",
          reference: "contract-submission-123",
        },
      },
    });
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    const values: Record<string, Record<string, Record<string, unknown>>> = {};
    for (let index = 0; index < 8; index += 1) {
      values[`field_block_${index}`] = {
        [`field_${index}`]: {
          type: "plain_text_input",
          value: `value-${index}-${"x".repeat(500)}`,
        },
      };
    }

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U777" },
        team: { id: "T1" },
        trigger_id: "trigger-777",
        view: {
          id: "V777",
          callback_id: "openclaw:contract_confirm_hearing",
          private_metadata: JSON.stringify({
            channelId: "D777",
            channelType: "im",
            userId: "U777",
            pluginInteractiveData: "dean.contract:confirm_hearing",
          }),
          state: {
            values,
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCall = mockCallArg(
      dispatchPluginInteractiveHandlerMock,
      0,
      "plugin interactive dispatcher",
    ) as
      | {
          channel?: string;
          data?: string;
          dedupeId?: string;
          invoke?: (params: {
            registration: { handler: (ctx: unknown) => unknown };
            namespace: string;
            payload: string;
          }) => Promise<unknown>;
        }
      | undefined;
    expectRecordFields(requireRecord(dispatchCall, "dispatch call"), {
      channel: "slack",
      data: "dean.contract:confirm_hearing",
      dedupeId: "view_submission:openclaw:contract_confirm_hearing:V777:U777",
    });

    const registrationHandler = vi.fn();
    await dispatchCall?.invoke?.({
      registration: { handler: registrationHandler },
      namespace: "dean.contract",
      payload: "confirm_hearing",
    });
    const registrationCtx = requireRecord(
      mockCallArg(registrationHandler, 0, "registration handler"),
      "registration handler ctx",
    );
    expectRecordFields(registrationCtx, {
      accountId: ctx.accountId,
      conversationId: "D777",
      senderId: "U777",
    });
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(true);
    const interaction = requireRecord(registrationCtx.interaction, "registration interaction") as {
      inputs?: unknown[];
      stateValues?: unknown;
    };
    expectRecordFields(interaction, {
      kind: "view_submission",
      data: "dean.contract:confirm_hearing",
      namespace: "dean.contract",
      payload: "confirm_hearing",
      callbackId: "openclaw:contract_confirm_hearing",
      viewId: "V777",
      triggerId: "trigger-777",
    });
    expect(interaction.inputs).toHaveLength(8);
    expect(interaction.stateValues).toEqual(values);

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    expect(eventText.length).toBeLessThanOrEqual(2400);
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      pluginHandled?: boolean;
      pluginNamespace?: string;
      pluginSystemEvent?: { summary?: string; reference?: string };
      inputs?: unknown[];
      inputsOmitted?: number;
      payloadTruncated?: boolean;
    };
    expectRecordFields(payload as unknown as Record<string, unknown>, {
      pluginHandled: true,
      pluginNamespace: "dean.contract",
    });
    expect(payload.pluginSystemEvent).toEqual({
      summary: "Contract form stored",
      reference: "contract-submission-123",
    });
    expect(Array.isArray(payload.inputs) ? payload.inputs.length : 0).toBeLessThanOrEqual(3);
    expect(payload.inputsOmitted).toBe(5);
    expect(payload.payloadTruncated).toBe(true);
  });

  it("dispatches callback-id-only plugin modal submissions without agent routing metadata", async () => {
    enqueueSystemEventMock.mockClear();
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U777" },
        view: {
          id: "V778",
          callback_id: "openclaw:dean.contract:confirm_hearing",
          state: {
            values: {
              contract: {
                name: { type: "plain_text_input", value: "Ari" },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCall = mockCallArg(
      dispatchPluginInteractiveHandlerMock,
      0,
      "plugin interactive dispatcher",
    ) as
      | {
          channel?: string;
          data?: string;
          dedupeId?: string;
          invoke?: (params: {
            registration: { handler: (ctx: unknown) => unknown };
            namespace: string;
            payload: string;
          }) => Promise<unknown>;
        }
      | undefined;
    expectRecordFields(requireRecord(dispatchCall, "dispatch call"), {
      channel: "slack",
      data: "dean.contract:confirm_hearing",
      dedupeId: "view_submission:openclaw:dean.contract:confirm_hearing:V778:U777",
    });

    const registrationHandler = vi.fn();
    await dispatchCall?.invoke?.({
      registration: { handler: registrationHandler },
      namespace: "dean.contract",
      payload: "confirm_hearing",
    });
    const registrationCtx = requireRecord(
      mockCallArg(registrationHandler, 0, "registration handler"),
      "registration handler ctx",
    );
    expect(requireRecord(registrationCtx.auth, "registration auth").isAuthorizedSender).toBe(false);
    expectRecordFields(requireRecord(registrationCtx.interaction, "registration interaction"), {
      kind: "view_submission",
      data: "dean.contract:confirm_hearing",
      namespace: "dean.contract",
      payload: "confirm_hearing",
      callbackId: "openclaw:dean.contract:confirm_hearing",
      viewId: "V778",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("dispatches metadata-routed plugin modal submissions with non-openclaw callback ids", async () => {
    enqueueSystemEventMock.mockClear();
    dispatchPluginInteractiveHandlerMock.mockResolvedValueOnce({
      matched: true,
      handled: true,
      duplicate: false,
    });
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U777" },
        view: {
          id: "V779",
          callback_id: "contract_confirm_hearing",
          private_metadata: JSON.stringify({
            channelId: "D777",
            channelType: "im",
            userId: "U777",
            pluginInteractiveData: "dean.contract:confirm_hearing",
          }),
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    const dispatchCall = mockCallArg(
      dispatchPluginInteractiveHandlerMock,
      0,
      "plugin interactive dispatcher",
    ) as { channel?: string; data?: string; dedupeId?: string } | undefined;
    expectRecordFields(requireRecord(dispatchCall, "dispatch call"), {
      channel: "slack",
      data: "dean.contract:confirm_hearing",
      dedupeId: "view_submission:contract_confirm_hearing:V779:U777",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("blocks modal events when private metadata userId does not match submitter", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U222" },
        view: {
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
            userId: "U111",
          }),
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks modal events when private metadata is missing userId", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U222" },
        view: {
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({
            channelId: "D123",
            channelType: "im",
          }),
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("keeps no-channel modal events open when allowFrom is unset", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext({ allowFrom: [] });
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U444" },
        view: {
          id: "V444",
          callback_id: "openclaw:routing_form",
          private_metadata: JSON.stringify({ userId: "U444" }),
          state: {
            values: {},
          },
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("captures modal input labels and picker values across block types", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U444" },
        view: {
          id: "V400",
          callback_id: "openclaw:routing_form",
          private_metadata: JSON.stringify({ userId: "U444" }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: {
                    text: { type: "plain_text", text: "Production" },
                    value: "prod",
                  },
                },
              },
              assignee_block: {
                assignee_select: {
                  type: "users_select",
                  selected_user: "U900",
                },
              },
              channel_block: {
                channel_select: {
                  type: "channels_select",
                  selected_channel: "C900",
                },
              },
              convo_block: {
                convo_select: {
                  type: "conversations_select",
                  selected_conversation: "G900",
                },
              },
              date_block: {
                date_select: {
                  type: "datepicker",
                  selected_date: "2026-02-16",
                },
              },
              time_block: {
                time_select: {
                  type: "timepicker",
                  selected_time: "12:45",
                },
              },
              datetime_block: {
                datetime_select: {
                  type: "datetimepicker",
                  selected_date_time: 1_771_632_300,
                },
              },
              radio_block: {
                radio_select: {
                  type: "radio_buttons",
                  selected_option: {
                    text: { type: "plain_text", text: "Blue" },
                    value: "blue",
                  },
                },
              },
              checks_block: {
                checks_select: {
                  type: "checkboxes",
                  selected_options: [
                    { text: { type: "plain_text", text: "A" }, value: "a" },
                    { text: { type: "plain_text", text: "B" }, value: "b" },
                  ],
                },
              },
              number_block: {
                number_input: {
                  type: "number_input",
                  value: "42.5",
                },
              },
              email_block: {
                email_input: {
                  type: "email_text_input",
                  value: "team@openclaw.ai",
                },
              },
              url_block: {
                url_input: {
                  type: "url_text_input",
                  value: "https://docs.openclaw.ai",
                },
              },
              richtext_block: {
                richtext_input: {
                  type: "rich_text_input",
                  rich_text_value: {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [
                          { type: "text", text: "Ship this now" },
                          { type: "text", text: "with canary metrics" },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      inputs: Array<{
        actionId: string;
        inputKind?: string;
        selectedValues?: string[];
        selectedUsers?: string[];
        selectedChannels?: string[];
        selectedConversations?: string[];
        selectedLabels?: string[];
        selectedDate?: string;
        selectedTime?: string;
        selectedDateTime?: number;
        inputNumber?: number;
        inputEmail?: string;
        inputUrl?: string;
        richTextValue?: unknown;
        richTextPreview?: string;
      }>;
    };
    const inputs = payload.inputs as Array<Record<string, unknown>>;
    expectRecordFields(inputByActionId(inputs, "env_select"), {
      selectedValues: ["prod"],
      selectedLabels: ["Production"],
    });
    expectRecordFields(inputByActionId(inputs, "assignee_select"), {
      selectedValues: ["U900"],
      selectedUsers: ["U900"],
    });
    expectRecordFields(inputByActionId(inputs, "channel_select"), {
      selectedValues: ["C900"],
      selectedChannels: ["C900"],
    });
    expectRecordFields(inputByActionId(inputs, "convo_select"), {
      selectedValues: ["G900"],
      selectedConversations: ["G900"],
    });
    expect(inputByActionId(inputs, "date_select").selectedDate).toBe("2026-02-16");
    expect(inputByActionId(inputs, "time_select").selectedTime).toBe("12:45");
    expect(inputByActionId(inputs, "datetime_select").selectedDateTime).toBe(1_771_632_300);
    expectRecordFields(inputByActionId(inputs, "radio_select"), {
      selectedValues: ["blue"],
      selectedLabels: ["Blue"],
    });
    expectRecordFields(inputByActionId(inputs, "checks_select"), {
      selectedValues: ["a", "b"],
      selectedLabels: ["A", "B"],
    });
    expectRecordFields(inputByActionId(inputs, "number_input"), {
      inputKind: "number",
      inputNumber: 42.5,
    });
    expectRecordFields(inputByActionId(inputs, "email_input"), {
      inputKind: "email",
      inputEmail: "team@openclaw.ai",
    });
    expectRecordFields(inputByActionId(inputs, "url_input"), {
      inputKind: "url",
      inputUrl: "https://docs.openclaw.ai/",
    });
    expectRecordFields(inputByActionId(inputs, "richtext_input"), {
      inputKind: "rich_text",
      richTextPreview: "Ship this now with canary metrics",
      richTextValue: {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Ship this now" },
              { type: "text", text: "with canary metrics" },
            ],
          },
        ],
      },
    });
  });

  it("truncates rich text preview to keep payload summaries compact", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const longText = "deploy ".repeat(40).trim();
    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U555" },
        view: {
          id: "V555",
          callback_id: "openclaw:long_richtext",
          private_metadata: JSON.stringify({ userId: "U555" }),
          state: {
            values: {
              richtext_block: {
                richtext_input: {
                  type: "rich_text_input",
                  rich_text_value: {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [{ type: "text", text: longText }],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      inputs: Array<{ actionId: string; richTextPreview?: string }>;
    };
    const richInput = payload.inputs.find((input) => input.actionId === "richtext_input");
    if (!richInput?.richTextPreview) {
      throw new Error("Expected rich text input preview");
    }
    expect(richInput.richTextPreview.length).toBeLessThanOrEqual(120);
  });

  it("captures modal close events and enqueues view closed event", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewClosedHandler, resolveSessionKey } = createContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });
    const viewClosedHandler = getViewClosedHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler({
      ack,
      body: {
        user: { id: "U900" },
        team: { id: "T1" },
        is_cleared: true,
        view: {
          id: "V900",
          callback_id: "openclaw:deploy_form",
          root_view_id: "VROOT900",
          previous_view_id: "VPREV900",
          external_id: "deploy-ext-900",
          hash: "view-hash-900",
          private_metadata: JSON.stringify({
            sessionKey: "agent:main:slack:channel:C99",
            userId: "U900",
          }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: {
                    text: { type: "plain_text", text: "Canary" },
                    value: "canary",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const options = requireRecord(
      mockCallArg(enqueueSystemEventMock, 0, "enqueueSystemEvent", 1),
      "enqueueSystemEvent options",
    ) as { sessionKey?: string };
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      actionId: string;
      callbackId: string;
      viewId: string;
      userId: string;
      isCleared: boolean;
      privateMetadata: string;
      rootViewId?: string;
      previousViewId?: string;
      externalId?: string;
      viewHash?: string;
      isStackedView?: boolean;
      inputs: Array<{ actionId: string; selectedValues?: string[] }>;
    };
    expectRecordFields(payload as unknown as Record<string, unknown>, {
      interactionType: "view_closed",
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      viewId: "V900",
      userId: "U900",
      isCleared: true,
      privateMetadata: "[redacted]",
      rootViewId: "VROOT900",
      previousViewId: "VPREV900",
      externalId: "deploy-ext-900",
      viewHash: "[redacted]",
      isStackedView: true,
    });
    expect(
      inputByActionId(payload.inputs as Array<Record<string, unknown>>, "env_select")
        .selectedValues,
    ).toEqual(["canary"]);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(options.sessionKey).toBe("agent:main:slack:channel:C99");
  });

  it("defaults modal close isCleared to false when Slack omits the flag", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewClosedHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewClosedHandler = getViewClosedHandler();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler({
      ack,
      body: {
        user: { id: "U901" },
        view: {
          id: "V901",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({ userId: "U901" }),
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      isCleared?: boolean;
    };
    expect(payload.interactionType).toBe("view_closed");
    expect(payload.isCleared).toBe(false);
  });

  it("caps oversized interaction payloads with compact summaries", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();

    const richTextValue = {
      type: "rich_text",
      elements: Array.from({ length: 20 }, (_, index) => ({
        type: "rich_text_section",
        elements: [{ type: "text", text: `chunk-${index}-${"x".repeat(400)}` }],
      })),
    };
    const values: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 20; index += 1) {
      values[`block_${index}`] = {
        [`input_${index}`]: {
          type: "rich_text_input",
          rich_text_value: richTextValue,
        },
      };
    }

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler({
      ack,
      body: {
        user: { id: "U915" },
        team: { id: "T1" },
        view: {
          id: "V915",
          callback_id: "openclaw:oversize",
          private_metadata: JSON.stringify({
            channelId: "D915",
            channelType: "im",
            userId: "U915",
          }),
          state: {
            values,
          },
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const eventText = enqueueSystemEventText();
    expect(eventText.length).toBeLessThanOrEqual(2400);
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      payloadTruncated?: boolean;
      inputs?: unknown[];
      inputsOmitted?: number;
    };
    expect(payload.payloadTruncated).toBe(true);
    expect(Array.isArray(payload.inputs) ? payload.inputs.length : 0).toBeLessThanOrEqual(3);
    expect((payload.inputsOmitted ?? 0) >= 1).toBe(true);
  });

  it("keeps block action rich text previews UTF-16 safe at the truncation boundary", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const boundaryText = `${"x".repeat(118)}😀y`;
    const ack = vi.fn().mockResolvedValue(undefined);
    await handler({
      ack,
      body: {
        user: { id: "U555" },
        channel: { id: "C1" },
        message: {
          ts: "111.222",
          text: "fallback",
          blocks: [{ type: "actions", block_id: "richtext_block", elements: [] }],
        },
      },
      action: {
        type: "rich_text_input",
        action_id: "openclaw:richtext",
        block_id: "richtext_block",
        rich_text_value: {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: boundaryText }],
            },
          ],
        },
      },
    } as never);

    expect(ack).toHaveBeenCalled();
    const payload = slackInteractionPayload() as { richTextPreview?: string };
    expect(payload.richTextPreview).toBe(`${"x".repeat(118)}…`);
    expect(payload.richTextPreview?.length).toBeLessThanOrEqual(120);
    expect(hasLoneSurrogate(payload.richTextPreview ?? "")).toBe(false);
    expect(() => encodeURIComponent(payload.richTextPreview ?? "")).not.toThrow();
  });

  it("keeps complete emoji in rich text previews when the UTF-16 boundary can include it", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();

    const text = `${"x".repeat(117)}😀yy`;
    await handler({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: "U555" },
        channel: { id: "C1" },
        message: {
          ts: "111.333",
          text: "fallback",
          blocks: [{ type: "actions", block_id: "richtext_block", elements: [] }],
        },
      },
      action: {
        type: "rich_text_input",
        action_id: "openclaw:richtext",
        block_id: "richtext_block",
        rich_text_value: {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text }],
            },
          ],
        },
      },
    } as never);

    const payload = slackInteractionPayload() as { richTextPreview?: string };
    expect(payload.richTextPreview).toBe(`${"x".repeat(117)}😀…`);
    expect(payload.richTextPreview?.length).toBeLessThanOrEqual(120);
    expect(hasLoneSurrogate(payload.richTextPreview ?? "")).toBe(false);
  });
});
const selectedDateTimeEpoch = 1_771_632_300;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
