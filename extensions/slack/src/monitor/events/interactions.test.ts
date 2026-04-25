import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    matched: false,
    handled: false,
    duplicate: false,
  })),
);
const resolvePluginConversationBindingApprovalMock = vi.hoisted(() => vi.fn());
const buildPluginBindingResolvedTextMock = vi.hoisted(() => vi.fn(() => "Binding updated."));
const resolveApprovalOverGatewayMock = vi.hoisted(() =>
  vi.fn<(arg: unknown) => Promise<void>>(async () => undefined),
);

let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (arg: unknown) => resolveApprovalOverGatewayMock(arg),
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  readStoreAllowFromForDmPolicy: async () => [],
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
    message?: { ts?: string; text?: string; blocks?: unknown[] };
  };
  action: Record<string, unknown>;
  respond?: (payload: { text: string; response_type: string }) => Promise<void>;
}) => Promise<void>;

type RegisteredViewHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user?: { id?: string };
    team?: { id?: string };
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

function createContext(overrides?: {
  dmEnabled?: boolean;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: string[];
  allowNameMatching?: boolean;
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
    getActionMatcher: () => actionMatcher,
    getHandler: () => handler,
    getViewHandler: () => viewHandler,
    getViewClosedHandler: () => viewClosedHandler,
  };
}

describe("registerSlackInteractionEvents", () => {
  beforeAll(async () => {
    ({ registerSlackInteractionEvents } = await import("./interactions.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    dispatchPluginInteractiveHandlerMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockClear();
    resolvePluginConversationBindingApprovalMock.mockResolvedValue({ status: "expired" });
    buildPluginBindingResolvedTextMock.mockClear();
    buildPluginBindingResolvedTextMock.mockReturnValue("Binding updated.");
    resolveApprovalOverGatewayMock.mockClear();
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: false,
      handled: false,
      duplicate: false,
    });
  });

  it("enqueues structured events and updates button rows", async () => {
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    expect(eventText.startsWith("Slack interaction: ")).toBe(true);
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionId: string;
      actionType: string;
      value: string;
      userId: string;
      teamId?: string;
      triggerId?: string;
      responseUrl?: string;
      channelId: string;
      messageTs: string;
      threadTs?: string;
    };
    expect(payload).toMatchObject({
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
    });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("registers a matcher that accepts plugin action ids beyond the OpenClaw prefix", () => {
    const { ctx, getActionMatcher } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const matcher = getActionMatcher();
    expect(matcher).toBeTruthy();
    expect(matcher?.test("openclaw:verify")).toBe(true);
    expect(matcher?.test("codex")).toBe(true);
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    const dispatchCalls = dispatchPluginInteractiveHandlerMock.mock.calls as unknown[][];
    const dispatchCall = dispatchCalls[0]?.[0] as
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
    expect(dispatchCall).toMatchObject({
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
    expect(registrationHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ctx.accountId,
        conversationId: "C1",
        interactionId: "U123:C1:100.200:123.trigger:codex:approve:thread-1",
        threadId: "100.100",
        interaction: expect.objectContaining({
          actionId: "codex",
          value: "approve:thread-1",
          data: "codex:approve:thread-1",
          namespace: "codex",
          payload: "approve:thread-1",
        }),
      }),
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("treats Slack reply buttons as plain interaction events instead of plugin dispatch", async () => {
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining('"actionId":"openclaw:reply_button"'),
      expect.any(Object),
    );
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    await handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "100.200",
        text: "Approve this bind?",
        blocks: [],
      }),
    );
    expect(respond).toHaveBeenCalledWith({
      text: "Binding updated.",
      response_type: "ephemeral",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("resolves exec approvals from shared interactive Slack actions", async () => {
    const { ctx, app, getHandler } = createContext({ allowFrom: ["U999"] });
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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

    expect(ack).toHaveBeenCalled();
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      approvalId: "req-123",
      decision: "allow-once",
      senderId: "U123",
      allowPluginFallback: true,
      clientDisplayName: "Slack approval (U123)",
    });
    expect(resolvePluginConversationBindingApprovalMock).not.toHaveBeenCalled();
    expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "100.200",
        text: "Exec approval required",
        blocks: [],
      }),
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it("keeps exec approval buttons when gateway resolution fails", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValueOnce(new Error("gateway down"));
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await expect(
      handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(viewHandler).toBeTruthy();
    expect(viewClosedHandler).toBeTruthy();

    const ackSubmit = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
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
    await viewClosedHandler!({
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

  it("captures select values and updates action rows for non-button actions", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType: string;
      selectedValues?: string[];
      selectedLabels?: string[];
    };
    expect(payload.actionType).toBe("static_select");
    expect(payload.selectedValues).toEqual(["canary"]);
    expect(payload.selectedLabels).toEqual(["Canary"]);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "111.222",
        blocks: [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: ":white_check_mark: *Canary* selected by <@U555>" }],
          },
        ],
      }),
    );
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
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

  it("ignores malformed action payloads after ack and logs warning", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler, runtimeLog } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("slack:interaction malformed"));
  });

  it("escapes mrkdwn characters in confirmation labels", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
    );
  });

  it("falls back to container channel and message timestamps", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      channelId?: string;
      messageTs?: string;
      threadTs?: string;
      teamId?: string;
    };
    expect(payload).toMatchObject({
      channelId: "C222",
      messageTs: "222.333",
      threadTs: "222.111",
      teamId: "T111",
    });
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("summarizes multi-select confirmations in updated message rows", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
    );
  });

  it("renders date/time/datetime picker selections in confirmation rows", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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

    await handler!({
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

    await handler!({
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

    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C3",
        ts: "555.666",
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: ":white_check_mark: *2026-02-16* selected by <@U333>" },
            ],
          },
          expect.anything(),
          expect.anything(),
        ],
      }),
    );
    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "C3",
        ts: "555.667",
        blocks: [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: ":white_check_mark: *14:30* selected by <@U333>" }],
          },
        ],
      }),
    );
    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
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
      }),
    );
  });

  it("captures expanded selection and temporal payload fields", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
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

  it("captures workflow button trigger metadata", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType?: string;
      workflowTriggerUrl?: string;
      workflowId?: string;
      teamId?: string;
      channelId?: string;
    };
    expect(payload).toMatchObject({
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
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
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
    expect(payload).toMatchObject({
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
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: "env_select", selectedValues: ["prod"] }),
        expect.objectContaining({ actionId: "notes_input", inputValue: "ship now" }),
      ]),
    );
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("blocks modal events when private metadata userId does not match submitter", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
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
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
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
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
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
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
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
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "env_select",
          selectedValues: ["prod"],
          selectedLabels: ["Production"],
        }),
        expect.objectContaining({
          actionId: "assignee_select",
          selectedValues: ["U900"],
          selectedUsers: ["U900"],
        }),
        expect.objectContaining({
          actionId: "channel_select",
          selectedValues: ["C900"],
          selectedChannels: ["C900"],
        }),
        expect.objectContaining({
          actionId: "convo_select",
          selectedValues: ["G900"],
          selectedConversations: ["G900"],
        }),
        expect.objectContaining({ actionId: "date_select", selectedDate: "2026-02-16" }),
        expect.objectContaining({ actionId: "time_select", selectedTime: "12:45" }),
        expect.objectContaining({ actionId: "datetime_select", selectedDateTime: 1_771_632_300 }),
        expect.objectContaining({
          actionId: "radio_select",
          selectedValues: ["blue"],
          selectedLabels: ["Blue"],
        }),
        expect.objectContaining({
          actionId: "checks_select",
          selectedValues: ["a", "b"],
          selectedLabels: ["A", "B"],
        }),
        expect.objectContaining({
          actionId: "number_input",
          inputKind: "number",
          inputNumber: 42.5,
        }),
        expect.objectContaining({
          actionId: "email_input",
          inputKind: "email",
          inputEmail: "team@openclaw.ai",
        }),
        expect.objectContaining({
          actionId: "url_input",
          inputKind: "url",
          inputUrl: "https://docs.openclaw.ai/",
        }),
        expect.objectContaining({
          actionId: "richtext_input",
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
        }),
      ]),
    );
  });

  it("truncates rich text preview to keep payload summaries compact", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const longText = "deploy ".repeat(40).trim();
    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      inputs: Array<{ actionId: string; richTextPreview?: string }>;
    };
    const richInput = payload.inputs.find((input) => input.actionId === "richtext_input");
    expect(richInput?.richTextPreview).toBeTruthy();
    expect((richInput?.richTextPreview ?? "").length).toBeLessThanOrEqual(120);
  });

  it("captures modal close events and enqueues view closed event", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewClosedHandler, resolveSessionKey } = createContext();
    const trackEvent = vi.fn();
    registerSlackInteractionEvents({ ctx: ctx as never, trackEvent });
    const viewClosedHandler = getViewClosedHandler();
    expect(viewClosedHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler!({
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
    const [eventText, options] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey?: string },
    ];
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
    expect(payload).toMatchObject({
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
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: "env_select", selectedValues: ["canary"] }),
      ]),
    );
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(options.sessionKey).toBe("agent:main:slack:channel:C99");
  });

  it("defaults modal close isCleared to false when Slack omits the flag", async () => {
    enqueueSystemEventMock.mockClear();
    const { ctx, getViewClosedHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewClosedHandler = getViewClosedHandler();
    expect(viewClosedHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
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
    expect(viewHandler).toBeTruthy();

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
    await viewHandler!({
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
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
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
});
const selectedDateTimeEpoch = 1_771_632_300;
