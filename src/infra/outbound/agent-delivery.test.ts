// Covers agent delivery planning from explicit inputs, session history,
// turn-source overrides, and route-aware target normalization.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn<() => unknown>(() => null),
  resolveChannelTarget: vi.fn<(params: { input: string }) => Promise<unknown>>(async (params) => ({
    ok: true,
    target: {
      to: params.input,
      kind: "group",
      source: "normalized",
      resolutionSource: "normalized",
    },
  })),
  resolveOutboundTarget: vi.fn<() => { ok: true; to: string } | { ok: false; error: Error }>(
    () => ({ ok: true, to: "+1999" }),
  ),
  resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(async () => null),
  resolveSessionDeliveryTarget: vi.fn(
    (params: {
      entry?: {
        delivery?: {
          kind?: string;
          context?: {
            channel?: string;
            to?: string;
            accountId?: string;
            threadId?: string | number;
          };
        };
      };
      requestedChannel?: string;
      explicitTo?: string;
      explicitThreadId?: string | number;
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    }) => {
      const sessionContext =
        params.entry?.delivery?.kind === "external" ? (params.entry.delivery.context ?? {}) : {};
      const lastChannel = params.turnSourceChannel ?? sessionContext.channel;
      const lastTo = params.turnSourceChannel ? params.turnSourceTo : sessionContext.to;
      const lastAccountId = params.turnSourceChannel
        ? params.turnSourceAccountId
        : sessionContext.accountId;
      const lastThreadId = params.turnSourceChannel
        ? params.turnSourceThreadId
        : sessionContext.threadId;
      const channel =
        params.requestedChannel === "last" || params.requestedChannel == null
          ? lastChannel
          : params.requestedChannel;
      const mode = params.explicitTo ? "explicit" : "implicit";
      const resolvedTo =
        params.explicitTo ?? (channel && channel === lastChannel ? lastTo : undefined);

      return {
        channel,
        to: resolvedTo,
        accountId: channel && channel === lastChannel ? lastAccountId : undefined,
        threadId:
          params.explicitThreadId ??
          (channel && channel === lastChannel ? lastThreadId : undefined),
        mode,
        lastChannel,
        lastTo,
        lastAccountId,
        lastThreadId,
      };
    },
  ),
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
  resolveSessionDeliveryTarget: mocks.resolveSessionDeliveryTarget,
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

vi.mock("./outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
}));

vi.mock("./target-resolver.js", () => ({
  resolveChannelTarget: mocks.resolveChannelTarget,
}));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  isDeliverableMessageChannel: (channel: string) =>
    [
      "directchat",
      "line",
      "provider",
      "signal",
      "synology-chat",
      "workspace",
      "telegram",
      "whatsapp",
    ].includes(channel),
  isGatewayMessageChannel: (channel: string) =>
    ["directchat", "workspace", "telegram", "whatsapp", "webchat"].includes(channel),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeLegacySessionEntryDelivery } from "../state-migrations.legacy-session-store.js";
let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;
let resolveAgentExplicitRecipientSession: typeof import("./agent-delivery.js").resolveAgentExplicitRecipientSession;
let resolveAgentOutboundTarget: typeof import("./agent-delivery.js").resolveAgentOutboundTarget;

beforeAll(async () => {
  ({
    resolveAgentDeliveryPlanWithSessionRoute,
    resolveAgentExplicitRecipientSession,
    resolveAgentOutboundTarget,
  } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockReturnValue(null);
  mocks.resolveChannelTarget.mockReset();
  mocks.resolveChannelTarget.mockImplementation(async (params: { input: string }) => ({
    ok: true,
    target: {
      to: params.input,
      kind: "group",
      source: "normalized",
      resolutionSource: "normalized",
    },
  }));
  mocks.resolveOutboundTarget.mockReset();
  mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "+1999" });
  mocks.resolveOutboundSessionRoute.mockReset();
  mocks.resolveOutboundSessionRoute.mockResolvedValue(null);
  mocks.resolveSessionDeliveryTarget.mockClear();
});

async function buildDeliveryPlan(
  params: Omit<
    Parameters<typeof resolveAgentDeliveryPlanWithSessionRoute>[0],
    "cfg" | "agentId" | "sessionEntry"
  > & { sessionEntry?: SessionEntry & { deliveryContext?: DeliveryContext } },
) {
  return await resolveAgentDeliveryPlanWithSessionRoute({
    cfg: {} as OpenClawConfig,
    agentId: "agent",
    ...params,
    sessionEntry: params.sessionEntry
      ? normalizeLegacySessionEntryDelivery(params.sessionEntry)
      : undefined,
  });
}

function sessionEntry(context: DeliveryContext): SessionEntry {
  return normalizeLegacySessionEntryDelivery({
    sessionId: "fixture",
    updatedAt: 1,
    deliveryContext: context,
  } as unknown as SessionEntry);
}

describe("agent delivery helpers", () => {
  it.each([
    {
      params: {
        sessionEntry: {
          sessionId: "s1",
          updatedAt: 1,
          deliveryContext: { channel: "directchat", to: "+1555", accountId: "work" },
        },
        requestedChannel: "last",
        explicitTo: undefined,
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "directchat",
        resolvedTo: "+1555",
        resolvedAccountId: "work",
        deliveryTargetMode: "implicit",
      },
    },
    {
      params: {
        sessionEntry: undefined,
        requestedChannel: "last",
        explicitTo: undefined,
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "webchat",
        deliveryTargetMode: undefined,
      },
    },
    {
      params: {
        sessionEntry: {
          sessionId: "s4",
          updatedAt: 4,
          deliveryContext: { channel: "workspace", to: "U_WRONG", accountId: "wrong" },
        },
        requestedChannel: "last",
        turnSourceChannel: "directchat",
        turnSourceTo: "+17775550123",
        turnSourceAccountId: "work",
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "directchat",
        resolvedTo: "+17775550123",
        resolvedAccountId: "work",
      },
    },
    {
      params: {
        sessionEntry: {
          sessionId: "s5",
          updatedAt: 5,
          deliveryContext: { channel: "workspace", to: "U_WRONG" },
        },
        requestedChannel: "last",
        turnSourceChannel: "directchat",
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "directchat",
        resolvedTo: undefined,
      },
    },
  ])("builds delivery plan for %j", async ({ params, expected }) => {
    const plan = await buildDeliveryPlan(params);
    for (const [key, value] of Object.entries(expected)) {
      expect((plan as Record<string, unknown>)[key]).toEqual(value);
    }
  });

  it("resolves fallback targets when no explicit destination is provided", async () => {
    const plan = await buildDeliveryPlan({
      sessionEntry: {
        sessionId: "s2",
        updatedAt: 2,
        deliveryContext: { channel: "directchat" },
      },
      requestedChannel: "last",
      explicitTo: undefined,
      accountId: undefined,
      wantsDelivery: true,
    });

    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "implicit",
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledTimes(1);
    expect(resolved.resolvedTarget?.ok).toBe(true);
    expect(resolved.resolvedTo).toBe("+1999");
  });

  it("skips outbound target resolution when explicit target validation is disabled", async () => {
    const plan = await buildDeliveryPlan({
      sessionEntry: {
        sessionId: "s3",
        updatedAt: 3,
        deliveryContext: { channel: "directchat", to: "+1555" },
      },
      requestedChannel: "last",
      explicitTo: "+1555",
      accountId: undefined,
      wantsDelivery: true,
    });

    mocks.resolveOutboundTarget.mockClear();
    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "explicit",
      validateExplicitTarget: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(resolved.resolvedTo).toBe("+1555");
  });

  it("resolves explicit delivery targets through plugin session routing", async () => {
    const pluginRouteResolver = vi.fn();
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: pluginRouteResolver },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "channel:C123",
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:workspace:channel:C123",
      baseSessionKey: "agent:workspace:channel:C123",
      peer: { kind: "channel", id: "C123" },
      chatType: "channel",
      from: "workspace:channel:C123",
      to: "channel:C123",
      threadId: "1700000000.000100",
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: sessionEntry({ channel: "workspace", to: "channel:C999" }),
      requestedChannel: "workspace",
      explicitTo: "workspace:channel:C123:thread:1700000000.000100",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      plugin: {
        messaging: { resolveOutboundSessionRoute: pluginRouteResolver },
      },
      agentId: "agent",
      accountId: "work",
      target: "channel:C123",
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(plan.resolvedTo).toBe("channel:C123");
    expect(plan.resolvedSessionKey).toBe("agent:workspace:channel:C123");
    expect(plan.resolvedThreadId).toBe("1700000000.000100");
  });

  it("resolves recipient sessions through native target routing with account identity", async () => {
    const plugin = {
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "120363040000000000@g.us",
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:whatsapp:group:120363040000000000@g.us",
      baseSessionKey: "agent:ops:whatsapp:group:120363040000000000@g.us",
      recipientSessionExact: true,
      peer: { kind: "group", id: "120363040000000000@g.us" },
      chatType: "group",
      from: "120363040000000000@g.us",
      to: "120363040000000000@g.us",
      threadId: "topic-42",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "ops",
      channel: "whatsapp",
      to: "120363040000000000@g.us",
      accountId: "work",
      threadId: "topic-42",
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "whatsapp",
      plugin,
      agentId: "ops",
      accountId: "work",
      target: "120363040000000000@g.us",
      threadId: "topic-42",
    });
    expect(result).toEqual({
      sessionKey: "agent:ops:whatsapp:group:120363040000000000@g.us",
      channel: "whatsapp",
      to: "120363040000000000@g.us",
      accountId: "work",
      threadId: "topic-42",
      error: undefined,
    });
  });

  it("applies binding-level DM isolation to exact provider recipients", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:main:thread:topic-1",
      baseSessionKey: "agent:ops:main",
      recipientSessionExact: true,
      peer: { kind: "direct", id: "+15551234567" },
      chatType: "direct",
      from: "signal:+15551234567",
      to: "+15551234567",
      threadId: "topic-1",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {
        agents: { entries: { ops: { default: true } } },
        session: { dmScope: "main" },
        bindings: [
          {
            agentId: "ops",
            match: { channel: "signal", peer: { kind: "direct", id: "+15551234567" } },
            session: { dmScope: "per-channel-peer" },
          },
        ],
      } as OpenClawConfig,
      agentId: "ops",
      channel: "signal",
      to: "+15551234567",
      threadId: "topic-1",
    });

    expect(result).toMatchObject({
      sessionKey: "agent:ops:signal:direct:+15551234567:thread:topic-1",
      channel: "signal",
      to: "+15551234567",
      threadId: "topic-1",
    });
  });

  it("rejects best-effort plugin routes for explicit recipient sessions", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      recipientSessionExact: false,
      peer: { kind: "direct", id: "@ambiguous" },
      chatType: "direct",
      from: "provider:@ambiguous",
      to: "@ambiguous",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      channel: "provider",
      to: "@ambiguous",
    });

    expect(result.sessionKey).toBeUndefined();
    expect(result.error?.message).toBe('Unable to resolve a session route for channel "provider"');
  });

  it("accepts best-effort direct aliases that collapse to the selected agent main session", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:main",
      baseSessionKey: "agent:ops:main",
      recipientSessionExact: "direct-alias",
      peer: { kind: "direct", id: "username:alice.01" },
      chatType: "direct",
      from: "signal:username:alice.01",
      to: "username:alice.01",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "ops",
      channel: "signal",
      to: "username:alice.01",
    });

    expect(result).toMatchObject({
      sessionKey: "agent:ops:main",
      channel: "signal",
      to: "username:alice.01",
    });
    expect(result.error).toBeUndefined();
  });

  it("rejects main-session aliases when a channel binding can isolate direct peers", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:main",
      baseSessionKey: "agent:ops:main",
      recipientSessionExact: "direct-alias",
      peer: { kind: "direct", id: "username:alice.01" },
      chatType: "direct",
      from: "signal:username:alice.01",
      to: "username:alice.01",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {
        session: { dmScope: "main" },
        bindings: [
          {
            agentId: "ops",
            match: { channel: "signal", peer: { kind: "direct", id: "+15551234567" } },
            session: { dmScope: "per-channel-peer" },
          },
        ],
      } as OpenClawConfig,
      agentId: "ops",
      channel: "signal",
      to: "username:alice.01",
    });

    expect(result.sessionKey).toBeUndefined();
    expect(result.error?.message).toBe('Unable to resolve a session route for channel "signal"');
  });

  it("rejects best-effort aliases that do not use the configured main session key", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:main",
      baseSessionKey: "agent:ops:main",
      recipientSessionExact: "direct-alias",
      peer: { kind: "direct", id: "username:alice.01" },
      chatType: "direct",
      from: "signal:username:alice.01",
      to: "username:alice.01",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: { session: { mainKey: "work" } } as OpenClawConfig,
      agentId: "ops",
      channel: "signal",
      to: "username:alice.01",
    });

    expect(result.sessionKey).toBeUndefined();
    expect(result.error?.message).toBe('Unable to resolve a session route for channel "signal"');
  });

  it("preserves authoritative routes from legacy plugin hooks", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:main:provider:direct:user-1",
      baseSessionKey: "agent:main:provider:direct:user-1",
      peer: { kind: "direct", id: "user-1" },
      chatType: "direct",
      from: "provider:user-1",
      to: "user-1",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      channel: "provider",
      to: "user-1",
    });

    expect(result.sessionKey).toBe("agent:main:provider:direct:user-1");
  });

  it("accepts stable outbound-only identities that stay isolated from main", async () => {
    const plugin = {
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
      },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: "42" });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
      baseSessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
      recipientSessionExact: "delivery-identity",
      peer: { kind: "direct", id: "chat-api-42" },
      chatType: "direct",
      from: "synology-chat:chat-api:42",
      to: "42",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "ops",
      channel: "synology-chat",
      to: "42",
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "synology-chat",
      plugin,
      agentId: "ops",
      accountId: "default",
      target: "42",
      currentSessionKey: undefined,
      threadId: undefined,
    });
    expect(result).toMatchObject({
      sessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
      channel: "synology-chat",
      to: "42",
      accountId: "default",
      error: undefined,
    });
  });

  it("rejects outbound-only identities that collapse to the agent main session", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: "42" });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:main",
      baseSessionKey: "agent:ops:main",
      recipientSessionExact: "delivery-identity",
      peer: { kind: "direct", id: "chat-api-42" },
      chatType: "direct",
      from: "synology-chat:chat-api:42",
      to: "42",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "ops",
      channel: "synology-chat",
      to: "42",
    });

    expect(result.sessionKey).toBeUndefined();
    expect(result.error?.message).toBe(
      'Unable to resolve a session route for channel "synology-chat"',
    );
  });

  it("rejects outbound-only identities outside the real provider namespace", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: "42" });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:synthetic:direct:42",
      baseSessionKey: "agent:ops:synthetic:direct:42",
      recipientSessionExact: "delivery-identity",
      peer: { kind: "direct", id: "42" },
      chatType: "direct",
      from: "synthetic:42",
      to: "42",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "ops",
      channel: "synology-chat",
      to: "42",
    });

    expect(result.sessionKey).toBeUndefined();
    expect(result.error?.message).toBe(
      'Unable to resolve a session route for channel "synology-chat"',
    );
  });

  it("rejects explicit recipients when no usable route can be inferred", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: "missing" });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "ops",
      channel: "provider",
      to: "missing",
    });

    expect(result.sessionKey).toBeUndefined();
    expect(result.error?.message).toBe('Unable to resolve a session route for channel "provider"');
  });

  it("uses the channel default account when recipient routing omits an account", async () => {
    const plugin = {
      config: {
        listAccountIds: () => ["work"],
        defaultAccountId: () => "work",
      },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:whatsapp:work:direct:+15551234567",
      baseSessionKey: "agent:ops:whatsapp:work:direct:+15551234567",
      recipientSessionExact: true,
      peer: { kind: "direct", id: "+15551234567" },
      chatType: "direct",
      from: "+15551234567",
      to: "+15551234567",
    });

    const result = await resolveAgentExplicitRecipientSession({
      cfg: {} as OpenClawConfig,
      agentId: "ops",
      channel: "whatsapp",
      to: "+15551234567",
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith({
      channel: "whatsapp",
      to: "+15551234567",
      cfg: {},
      accountId: "work",
      mode: "explicit",
    });
    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "whatsapp",
      plugin,
      agentId: "ops",
      accountId: "work",
      target: "+1999",
      threadId: undefined,
    });
    expect(result.sessionKey).toBe("agent:ops:whatsapp:work:direct:+15551234567");
  });

  it("resolves reserved explicit targets through directory-capable resolution before session routing", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error('Reserved target "current" for Telegram'),
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:telegram:group:-1002458651455",
      baseSessionKey: "agent:telegram:group:-1002458651455",
      peer: { kind: "group", id: "-1002458651455" },
      chatType: "group",
      from: "telegram:group:-1002458651455",
      to: "telegram:-1002458651455",
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: undefined,
      requestedChannel: "telegram",
      explicitTo: "current",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      input: "current",
      accountId: "work",
      unknownTargetMode: "normalized",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function), targetResolver: {} },
      },
    });
    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function), targetResolver: {} },
      },
      agentId: "agent",
      accountId: "work",
      target: "telegram:-1002458651455",
      resolvedTarget: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(plan.resolvedTo).toBe("telegram:-1002458651455");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("keeps reserved explicit target errors when directory-capable resolution misses", async () => {
    const reservedError = new Error('Reserved target "current" for Telegram');
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: reservedError,
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: false,
      error: reservedError,
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "telegram",
      explicitTo: "current",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      input: "current",
      accountId: undefined,
      unknownTargetMode: "normalized",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function), targetResolver: {} },
      },
    });
    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("current");
    expect(plan.targetResolutionError).toBe(reservedError);
  });

  it("keeps directory-resolved reserved explicit targets when session-route canonicalization misses", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error('Reserved target "current" for Telegram'),
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: undefined,
      requestedChannel: "telegram",
      explicitTo: "current",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function), targetResolver: {} },
      },
      agentId: "agent",
      accountId: "work",
      target: "telegram:-1002458651455",
      resolvedTarget: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(plan.resolvedTo).toBe("telegram:-1002458651455");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("surfaces stored explicit target errors even when explicit validation is disabled", () => {
    const targetResolutionError = new Error('reserved target "current"');

    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan: {
        baseDelivery: { mode: "explicit" },
        resolvedChannel: "workspace",
        resolvedTo: "current",
        deliveryTargetMode: "explicit",
        targetResolutionError,
      },
      targetMode: "explicit",
      validateExplicitTarget: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(resolved.resolvedTarget).toEqual({ ok: false, error: targetResolutionError });
    expect(resolved.resolvedTo).toBeUndefined();
  });

  it("falls back to the original plan when session-route canonicalization fails", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "channel:C123",
    });
    mocks.resolveOutboundSessionRoute.mockRejectedValueOnce(new Error("route lookup failed"));

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "workspace",
      explicitTo: "channel:C123",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedTo).toBe("channel:C123");
    expect(plan.resolvedThreadId).toBeUndefined();
  });

  it("does not session-route targets when delivery is disabled", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "workspace",
      explicitTo: "channel:C123",
      accountId: undefined,
      wantsDelivery: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("channel:C123");
  });

  it("does not pass inherited session threads into explicit retarget routing", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "channel:C123",
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:workspace:channel:C123",
      baseSessionKey: "agent:workspace:channel:C123",
      peer: { kind: "channel", id: "C123" },
      chatType: "channel",
      from: "workspace:channel:C123",
      to: "channel:C123",
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: sessionEntry({
        channel: "workspace",
        to: "channel:C999",
        threadId: "old-thread",
      }),
      requestedChannel: "workspace",
      explicitTo: "channel:C123",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "channel:C123",
        threadId: undefined,
      }),
    );
    expect(plan.resolvedThreadId).toBeUndefined();
  });
});
