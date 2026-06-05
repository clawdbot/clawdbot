// Covers agent delivery planning from explicit inputs, session history,
// turn-source overrides, and route-aware target normalization.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn<() => unknown>(() => null),
  resolveOutboundTarget: vi.fn<() => { ok: true; to: string } | { ok: false; error: Error }>(
    () => ({ ok: true, to: "+1999" }),
  ),
  resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(async () => null),
  resolveSessionDeliveryTarget: vi.fn(
    (params: {
      entry?: {
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
        lastChannel?: string;
        lastTo?: string;
        lastAccountId?: string;
        lastThreadId?: string | number;
      };
      requestedChannel?: string;
      explicitTo?: string;
      explicitThreadId?: string | number;
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    }) => {
      const sessionContext = params.entry?.deliveryContext ?? {
        channel: params.entry?.lastChannel,
        to: params.entry?.lastTo,
        accountId: params.entry?.lastAccountId,
        threadId: params.entry?.lastThreadId,
      };
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

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  isDeliverableMessageChannel: (channel: string) => ["directchat", "workspace"].includes(channel),
  isGatewayMessageChannel: (channel: string) =>
    ["directchat", "workspace", "webchat"].includes(channel),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

import type { OpenClawConfig } from "../../config/config.js";
let resolveAgentDeliveryPlan: typeof import("./agent-delivery.js").resolveAgentDeliveryPlan;
let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;
let resolveAgentOutboundTarget: typeof import("./agent-delivery.js").resolveAgentOutboundTarget;

beforeAll(async () => {
  ({
    resolveAgentDeliveryPlan,
    resolveAgentDeliveryPlanWithSessionRoute,
    resolveAgentOutboundTarget,
  } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockReturnValue(null);
  mocks.resolveOutboundTarget.mockClear();
  mocks.resolveOutboundSessionRoute.mockReset();
  mocks.resolveOutboundSessionRoute.mockResolvedValue(null);
  mocks.resolveSessionDeliveryTarget.mockClear();
});

function expectDeliveryPlan(params: Parameters<typeof resolveAgentDeliveryPlan>[0]) {
  return resolveAgentDeliveryPlan(params);
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
  ])("builds delivery plan for %j", ({ params, expected }) => {
    const plan = expectDeliveryPlan(params);
    for (const [key, value] of Object.entries(expected)) {
      expect((plan as Record<string, unknown>)[key]).toEqual(value);
    }
  });

  it("resolves fallback targets when no explicit destination is provided", () => {
    const plan = resolveAgentDeliveryPlan({
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

  it("skips outbound target resolution when explicit target validation is disabled", () => {
    const plan = expectDeliveryPlan({
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
      sessionEntry: {
        sessionId: "s4",
        updatedAt: 4,
        deliveryContext: { channel: "workspace", to: "channel:C999" },
      },
      requestedChannel: "workspace",
      explicitTo: "workspace:channel:C123:thread:1700000000.000100",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      agentId: "agent",
      accountId: "work",
      target: "channel:C123",
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(plan.resolvedTo).toBe("channel:C123");
    expect(plan.resolvedThreadId).toBe("1700000000.000100");
  });

  it("does not session-route explicit targets before outbound normalization succeeds", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("ambiguous target"),
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "workspace",
      explicitTo: "1470130713209602050",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("1470130713209602050");
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
      sessionEntry: {
        sessionId: "s-thread",
        updatedAt: 5,
        deliveryContext: {
          channel: "workspace",
          to: "channel:C999",
          threadId: "old-thread",
        },
      },
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
