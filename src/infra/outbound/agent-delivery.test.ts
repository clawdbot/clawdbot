import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+1999" })),
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
        threadIdExplicit: params.explicitThreadId != null,
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

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  isDeliverableMessageChannel: (channel: string) => ["directchat", "workspace"].includes(channel),
  isGatewayMessageChannel: (channel: string) =>
    ["directchat", "workspace", "webchat"].includes(channel),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

import type { OpenClawConfig } from "../../config/config.js";
let resolveAgentDeliveryPlan: typeof import("./agent-delivery.js").resolveAgentDeliveryPlan;
let resolveAgentOutboundTarget: typeof import("./agent-delivery.js").resolveAgentOutboundTarget;

beforeAll(async () => {
  ({ resolveAgentDeliveryPlan, resolveAgentOutboundTarget } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundTarget.mockClear();
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
    expect(plan).toMatchObject(expected);
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
});
