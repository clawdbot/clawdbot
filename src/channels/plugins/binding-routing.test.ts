// Binding routing tests cover channel binding selection and message routing behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveRuntimeConversationBindingRoute,
  resolveRuntimeConversationBindingRouteWithFallback,
} from "./binding-routing.js";
import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

function createRoute(): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "demo",
    accountId: "default",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "main",
    matchedBy: "default",
  };
}

function createBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "binding-1",
    targetSessionKey: "agent:review:acp:session-1",
    targetKind: "session",
    conversation: {
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    },
    status: "active",
    boundAt: 1,
    ...overrides,
  };
}

function registerAdapter(record: SessionBindingRecord | null): {
  resolveByConversation: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
} {
  const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(() => record);
  const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
  registerSessionBindingAdapter({
    channel: "demo",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation,
    touch,
  });
  return { resolveByConversation, touch };
}

describe("runtime conversation binding route", () => {
  beforeEach(() => {
    testing.resetSessionBindingAdaptersForTests();
  });

  it("rewrites the route to a runtime-bound ACP session and touches the binding", () => {
    const binding = createBinding();
    const { resolveByConversation, touch } = registerAdapter(binding);

    const result = resolveRuntimeConversationBindingRoute({
      route: createRoute(),
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    });
    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.boundSessionKey).toBe("agent:review:acp:session-1");
    expect(result.boundAgentId).toBe("review");
    expect(result.route).toEqual({
      agentId: "review",
      accountId: "default",
      channel: "demo",
      sessionKey: "agent:review:acp:session-1",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    });
  });

  it("resolves a core binding before fallback and preserves route scope", () => {
    const { touch } = registerAdapter(createBinding());
    const fallback = vi.fn(createRoute);
    const boundRoute = {
      ...createRoute(),
      agentId: "review",
      dmScope: "per-account-channel-peer" as const,
      groupScope: "main" as const,
      mainSessionKey: "agent:review:home",
    };
    const resolveBoundRoute = vi.fn(() => boundRoute);

    const result = resolveRuntimeConversationBindingRouteWithFallback({
      conversation: { channel: "demo", accountId: "default", conversationId: "room-1" },
      resolveFallbackRoute: fallback,
      resolveBoundRoute,
    });

    expect(fallback).not.toHaveBeenCalled();
    expect(resolveBoundRoute).toHaveBeenCalledWith("review");
    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.route).toEqual({
      ...boundRoute,
      sessionKey: "agent:review:acp:session-1",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    });
  });

  it.each([
    ["absent", null, false, false],
    ["empty", createBinding({ targetSessionKey: " " }), false, false],
    [
      "plugin-owned",
      createBinding({
        metadata: { pluginBindingOwner: "plugin", pluginId: "demo", pluginRoot: "/plugin" },
      }),
      true,
      true,
    ],
    ["cron", createBinding({ targetSessionKey: "agent:review:cron:job:run:1" }), false, false],
  ] as const)("falls back once for %s bindings", (_name, binding, shouldTouch, retainsRecord) => {
    const route = createRoute();
    const { touch } = registerAdapter(binding);
    const fallback = vi.fn(() => route);
    const resolveBoundRoute = vi.fn(() => route);

    const result = resolveRuntimeConversationBindingRouteWithFallback({
      conversation: { channel: "demo", accountId: "default", conversationId: "room-1" },
      resolveFallbackRoute: fallback,
      resolveBoundRoute,
    });

    expect(fallback).toHaveBeenCalledOnce();
    expect(resolveBoundRoute).not.toHaveBeenCalled();
    expect(touch).toHaveBeenCalledTimes(shouldTouch ? 1 : 0);
    expect(result.bindingRecord).toBe(retainsRecord ? binding : null);
    expect(result.route).toBe(route);
  });

  it("rejects malformed bound session keys before resolving either route", () => {
    const { touch } = registerAdapter(createBinding({ targetSessionKey: "agent:" }));
    const fallback = vi.fn(createRoute);
    const resolveBoundRoute = vi.fn(createRoute);

    expect(() =>
      resolveRuntimeConversationBindingRouteWithFallback({
        conversation: { channel: "demo", accountId: "default", conversationId: "room-1" },
        resolveFallbackRoute: fallback,
        resolveBoundRoute,
      }),
    ).toThrow("Malformed agent session key");
    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(fallback).not.toHaveBeenCalled();
    expect(resolveBoundRoute).not.toHaveBeenCalled();
  });
});

describe("ensureConfiguredBindingRouteReady", () => {
  let unregisterDriver: (() => void) | undefined;

  afterEach(() => {
    vi.useRealTimers();
    unregisterDriver?.();
  });

  it("returns a bounded failure when target readiness never settles", async () => {
    vi.useFakeTimers();
    unregisterDriver = registerStatefulBindingTargetDriver({
      id: "slow",
      ensureReady: async () => await new Promise<never>(() => {}),
      ensureSession: async () => ({
        ok: false,
        sessionKey: "agent:slow:binding",
        error: "not used",
      }),
    });

    const resultPromise = ensureConfiguredBindingRouteReady({
      cfg: {} as never,
      bindingResolution: { statefulTarget: { driverId: "slow" } } as never,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Configured binding route ready check timed out",
    });
  });
});
