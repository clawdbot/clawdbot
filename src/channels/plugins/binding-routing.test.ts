// Binding routing tests cover channel binding selection and message routing behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
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
} from "./binding-routing.js";
import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

vi.mock("../../config/sessions/session-accessor.js", { spy: true });

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
    // Binding targets resolve by default; the stale-target case opts out explicitly.
    vi.mocked(loadSessionEntryReadOnly).mockReturnValue({} as SessionEntry);
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

  it("touches plugin-owned bindings without rewriting the channel route", () => {
    const route = createRoute();
    const binding = createBinding({
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo-plugin",
        pluginRoot: "/tmp/demo-plugin",
      },
    });
    const { touch } = registerAdapter(binding);

    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.bindingRecord).toBe(binding);
    expect(result.boundSessionKey).toBeUndefined();
    expect(result.route).toBe(route);
  });

  it("ignores runtime bindings that target isolated cron run sessions", () => {
    const route = createRoute();
    const binding = createBinding({
      targetSessionKey: "agent:youtube:cron:monthly-report:run:closed-run-1",
    });
    const { touch } = registerAdapter(binding);

    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(touch).not.toHaveBeenCalled();
    expect(result.bindingRecord).toBeNull();
    expect(result.boundSessionKey).toBeUndefined();
    expect(result.route).toBe(route);
  });

  it("ignores runtime bindings whose target session no longer exists", () => {
    const route = createRoute();
    const binding = createBinding();
    registerAdapter(binding);
    vi.mocked(loadSessionEntryReadOnly).mockReturnValue(undefined);

    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    // A null record is what lets callers fall back to their configured binding instead of
    // treating the dead runtime target as authoritative.
    expect(result.bindingRecord).toBeNull();
    expect(result.boundSessionKey).toBeUndefined();
    expect(result.route).toBe(route);
  });

  it("keeps the runtime binding when the session store read throws", () => {
    const binding = createBinding();
    registerAdapter(binding);
    vi.mocked(loadSessionEntryReadOnly).mockImplementation(() => {
      throw new Error("session store unavailable");
    });

    const result = resolveRuntimeConversationBindingRoute({
      route: createRoute(),
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(result.bindingRecord).toBe(binding);
    expect(result.boundSessionKey).toBe("agent:review:acp:session-1");
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
