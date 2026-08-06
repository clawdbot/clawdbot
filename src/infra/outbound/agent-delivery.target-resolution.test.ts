import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn<() => unknown>(),
  resolveChannelTarget: vi.fn<(params: { input: string }) => Promise<unknown>>(),
  resolveOutboundTarget: vi.fn<() => { ok: true; to: string } | { ok: false; error: Error }>(),
  resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(),
  resolveSessionDeliveryTarget: vi.fn(
    (params: { requestedChannel?: string; explicitTo?: string }) => ({
      channel: params.requestedChannel,
      to: params.explicitTo,
      mode: params.explicitTo ? "explicit" : "implicit",
    }),
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
  isDeliverableMessageChannel: (channel: string) => channel === "workspace",
  isGatewayMessageChannel: (channel: string) => ["webchat", "workspace"].includes(channel),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

import type { OpenClawConfig } from "../../config/config.js";

let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;

beforeAll(async () => {
  ({ resolveAgentDeliveryPlanWithSessionRoute } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveChannelTarget.mockReset();
  mocks.resolveOutboundTarget.mockReset();
  mocks.resolveOutboundSessionRoute.mockReset();
  mocks.resolveOutboundSessionRoute.mockResolvedValue(null);
  mocks.resolveSessionDeliveryTarget.mockClear();
});

describe("agent delivery target resolution", () => {
  it("does not session-route targets when outbound validation fails", async () => {
    const targetError = new Error("ambiguous target");
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValue({ ok: false, error: targetError });
    mocks.resolveChannelTarget.mockResolvedValue({
      ok: true,
      target: {
        to: "1470130713209602050",
        kind: "group",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      requestedChannel: "workspace",
      explicitTo: "1470130713209602050",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("1470130713209602050");
    expect(plan.targetResolutionError).toBe(targetError);
  });

  it("resolves named targets through the shared directory resolver", async () => {
    const plugin = {
      messaging: {
        resolveOutboundSessionRoute: vi.fn(),
        targetResolver: { resolveTarget: vi.fn() },
      },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "channel:general" });
    mocks.resolveChannelTarget.mockResolvedValue({
      ok: true,
      target: {
        to: "channel:1524410080953634829",
        kind: "channel",
        source: "directory",
        resolutionSource: "directory",
      },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      requestedChannel: "workspace",
      explicitTo: "channel:general",
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      input: "channel:general",
      accountId: undefined,
      unknownTargetMode: "error",
      plugin,
    });
    expect(plan.resolvedTo).toBe("channel:1524410080953634829");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("rejects named targets when directory and plugin resolution miss", async () => {
    const targetError = new Error('Unknown target "channel:missing"');
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: {
        resolveOutboundSessionRoute: vi.fn(),
        targetResolver: { resolveTarget: vi.fn() },
      },
    });
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "channel:missing" });
    mocks.resolveChannelTarget.mockResolvedValue({ ok: false, error: targetError });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      requestedChannel: "workspace",
      explicitTo: "channel:missing",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("channel:missing");
    expect(plan.targetResolutionError).toBe(targetError);
  });

  it("resolves plugin default targets before returning the delivery plan", async () => {
    const plugin = { messaging: { targetResolver: { resolveTarget: vi.fn() } } };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "channel:default-room" });
    mocks.resolveChannelTarget.mockResolvedValue({
      ok: true,
      target: {
        to: "channel:1524410080953634830",
        kind: "channel",
        source: "directory",
        resolutionSource: "directory",
      },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      requestedChannel: "workspace",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith({
      channel: "workspace",
      to: undefined,
      cfg: {},
      accountId: undefined,
      mode: "implicit",
    });
    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      input: "channel:default-room",
      accountId: undefined,
      unknownTargetMode: "error",
      plugin,
    });
    expect(plan.resolvedTo).toBe("channel:1524410080953634830");
  });

  it("preserves normalized fallback for session-route-only plugins", async () => {
    const plugin = { messaging: { resolveOutboundSessionRoute: vi.fn() } };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "some-channel" });
    mocks.resolveChannelTarget.mockResolvedValue({
      ok: true,
      target: {
        to: "some-channel",
        kind: "group",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      requestedChannel: "workspace",
      explicitTo: "some-channel",
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      input: "some-channel",
      accountId: undefined,
      unknownTargetMode: "normalized",
      plugin,
    });
    expect(plan.resolvedTo).toBe("some-channel");
  });

  it("preserves normalized fallback for heuristic-only target resolvers", async () => {
    const plugin = {
      messaging: {
        resolveOutboundSessionRoute: vi.fn(),
        targetResolver: { looksLikeId: vi.fn() },
      },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "some-channel" });
    mocks.resolveChannelTarget.mockResolvedValue({
      ok: true,
      target: {
        to: "some-channel",
        kind: "group",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      requestedChannel: "workspace",
      explicitTo: "some-channel",
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      input: "some-channel",
      accountId: undefined,
      unknownTargetMode: "normalized",
      plugin,
    });
    expect(plan.resolvedTo).toBe("some-channel");
    expect(plan.targetResolutionError).toBeUndefined();
  });
});
