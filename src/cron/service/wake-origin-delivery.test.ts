// Covers the "capture origin delivery context, carry it to the wake event"
// half of the cron wake origin fix: a sessionKey-targeted wake() must thread
// the bound channel thread/topic (e.g. Telegram topic 4052) onto the enqueued
// system event's deliveryContext so the delivered heartbeat routes back into
// the originating thread instead of the chat root.
//
// The channel-correct threadId is sourced via the resolveOriginDeliveryContext
// dep (implemented in server-cron from the session store), NOT by splitting the
// composite session-key thread suffix. The tests mock that dep so they exercise
// only wake()'s carry behavior. Scheduled main-session cron jobs resolve their
// delivery context natively in timer.ts (resolveMainSessionCronDeliveryContext)
// and are covered there.
import { describe, expect, it, vi } from "vitest";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronServiceState } from "./state.js";
import { wake } from "./wake.js";

const TOPIC_DELIVERY_CONTEXT: DeliveryContext = {
  channel: "telegram",
  to: "telegram:8661849123:topic:4052",
  accountId: "default",
  threadId: "4052",
};

function makeStateWithMocks(
  resolveOriginDeliveryContext?: (params: {
    sessionKey?: string;
    agentId?: string;
  }) => DeliveryContext | undefined,
): {
  state: CronServiceState;
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
  requestHeartbeat: ReturnType<typeof vi.fn>;
  resolveOriginDeliveryContext: ReturnType<typeof vi.fn>;
} {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const resolveOrigin = vi.fn(resolveOriginDeliveryContext ?? (() => undefined));
  const state = {
    deps: {
      enqueueSystemEvent,
      requestHeartbeat,
      resolveOriginDeliveryContext: resolveOrigin,
    },
  } as unknown as CronServiceState;
  return {
    state,
    enqueueSystemEvent,
    requestHeartbeat,
    resolveOriginDeliveryContext: resolveOrigin,
  };
}

describe("cron wake() origin delivery-context carry", () => {
  it("threads the resolved deliveryContext onto a sessionKey-targeted wake", () => {
    const { state, enqueueSystemEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    const result = wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });

    expect(result).toEqual({ ok: true });
    expect(resolveOriginDeliveryContext).toHaveBeenCalledWith({
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
    });
  });

  it("resolves and carries deliveryContext for a sessionKey-only wake (no agentId)", () => {
    // Caught by mutation testing: `sessionKey || agentId` -> `&&` in the
    // resolver guard survived because every resolver-wired test passed both
    // fields. A sessionKey-only wake (the common tool-path shape for
    // single-agent setups) must still consult the resolver and carry the
    // stored topic/thread context.
    const { state, enqueueSystemEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });

    expect(resolveOriginDeliveryContext).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: undefined,
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      deliveryContext: TOPIC_DELIVERY_CONTEXT,
    });
  });

  it("omits deliveryContext when no origin context resolves (unchanged default routing)", () => {
    const { state, enqueueSystemEvent } = makeStateWithMocks(() => undefined);

    wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });
    const [, options] = enqueueSystemEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty("deliveryContext");
  });

  it("works when no resolveOriginDeliveryContext dep is wired (legacy deps)", () => {
    const { state, enqueueSystemEvent } = makeStateWithMocks();
    // Drop the dep entirely to mirror a deployment whose adapter predates the fix.
    (state.deps as { resolveOriginDeliveryContext?: unknown }).resolveOriginDeliveryContext =
      undefined;

    const result = wake(state, {
      mode: "now",
      text: "check the queue",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });

    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
    });
  });

  it("keeps the no-origin call shape (enqueueSystemEvent(text, undefined)) when untargeted", () => {
    const { state, enqueueSystemEvent, resolveOriginDeliveryContext } = makeStateWithMocks(
      () => TOPIC_DELIVERY_CONTEXT,
    );

    wake(state, { mode: "now", text: "no origin" });

    // Untargeted wakes must not even consult the resolver, preserving the exact
    // pre-fix default-sessionKey binding behavior.
    expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("no origin", undefined);
  });
});
