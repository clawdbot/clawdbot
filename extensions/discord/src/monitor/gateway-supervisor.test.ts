import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  classifyDiscordGatewayEvent,
  DiscordGatewayLifecycleError,
  createDiscordGatewaySupervisor,
} from "./gateway-supervisor.js";

describe("classifyDiscordGatewayEvent", () => {
  it("maps current gateway errors onto domain events", () => {
    const transientTypeError = new TypeError();
    transientTypeError.stack = "TypeError\n    at gatewayCrash (discord-gateway.js:12:34)";
    const reconnectEvent = classifyDiscordGatewayEvent({
      err: new Error("Max reconnect attempts (0) reached after close code 1006"),
      isDisallowedIntentsError: () => false,
    });
    const fatalEvent = classifyDiscordGatewayEvent({
      err: new Error("Fatal gateway close code: 4000"),
      isDisallowedIntentsError: () => false,
    });
    const disallowedEvent = classifyDiscordGatewayEvent({
      err: new Error("Fatal gateway close code: 4014"),
      isDisallowedIntentsError: (err) => String(err).includes("4014"),
    });
    const transientEvent = classifyDiscordGatewayEvent({
      err: transientTypeError,
      isDisallowedIntentsError: () => false,
    });

    expect(reconnectEvent.type).toBe("reconnect-exhausted");
    expect(reconnectEvent.shouldStopLifecycle).toBe(true);
    expect(fatalEvent.type).toBe("fatal");
    expect(disallowedEvent.type).toBe("disallowed-intents");
    expect(transientEvent.type).toBe("fatal");
    expect(transientEvent.message).toBe("TypeError @ gatewayCrash (discord-gateway.js:12:34)");
    expect(transientEvent.shouldStopLifecycle).toBe(true);
  });

  it("wraps fatal lifecycle stops with discord-specific context", () => {
    const transientTypeError = new TypeError();
    transientTypeError.stack = "TypeError\n    at gatewayCrash (discord-gateway.js:12:34)";
    const event = classifyDiscordGatewayEvent({
      err: transientTypeError,
      isDisallowedIntentsError: () => false,
    });

    const wrapped = new DiscordGatewayLifecycleError(event);

    expect(wrapped.name).toBe("DiscordGatewayLifecycleError");
    expect(wrapped.message).toBe(
      "discord gateway fatal: TypeError @ gatewayCrash (discord-gateway.js:12:34)",
    );
    expect(wrapped.eventType).toBe("fatal");
    expect(wrapped.cause).toBeInstanceOf(TypeError);
  });
});

describe("createDiscordGatewaySupervisor", () => {
  it("buffers early errors, routes active ones, and logs late teardown errors", () => {
    const emitter = new EventEmitter();
    const runtime = {
      error: vi.fn(),
    };
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter },
      isDisallowedIntentsError: (err) => String(err).includes("4014"),
      runtime: runtime as never,
    });
    const seen: string[] = [];

    emitter.emit("error", new Error("Fatal gateway close code: 4014"));
    expect(
      supervisor.drainPending((event) => {
        seen.push(event.type);
        return "continue";
      }),
    ).toBe("continue");

    supervisor.attachLifecycle((event) => {
      seen.push(event.type);
    });
    emitter.emit("error", new Error("Fatal gateway close code: 4000"));

    supervisor.detachLifecycle();
    emitter.emit("error", new Error("Max reconnect attempts (0) reached after close code 1006"));

    expect(seen).toEqual(["disallowed-intents", "fatal"]);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]).toHaveLength(1);
    expect(String(runtime.error.mock.calls[0]?.[0])).toContain(
      "suppressed late gateway reconnect-exhausted error during teardown",
    );
  });

  it("is idempotent on dispose and noops without an emitter", () => {
    const supervisor = createDiscordGatewaySupervisor({
      gateway: undefined,
      isDisallowedIntentsError: () => false,
      runtime: { error: vi.fn() } as never,
    });

    expect(supervisor.drainPending(() => "continue")).toBe("continue");
    supervisor.attachLifecycle(() => {});
    supervisor.detachLifecycle();
    supervisor.dispose();
    supervisor.dispose();
  });

  it("keeps suppressing late gateway errors after dispose", () => {
    const emitter = new EventEmitter();
    const runtime = { error: vi.fn() };
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter },
      isDisallowedIntentsError: () => false,
      runtime: runtime as never,
    });

    supervisor.dispose();

    emitter.emit("error", new Error("Max reconnect attempts (0) reached after close code 1005"));
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]).toHaveLength(1);
    expect(String(runtime.error.mock.calls[0]?.[0])).toContain(
      "suppressed late gateway reconnect-exhausted error after dispose",
    );
  });

  it("dedupes identical late gateway errors after dispose", () => {
    const emitter = new EventEmitter();
    const runtime = { error: vi.fn() };
    const supervisor = createDiscordGatewaySupervisor({
      gateway: { emitter },
      isDisallowedIntentsError: () => false,
      runtime: runtime as never,
    });

    supervisor.dispose();
    const first = new TypeError();
    first.stack = "TypeError\n    at gatewayCrash (discord-gateway.js:12:34)";
    const second = new TypeError();
    second.stack = "TypeError\n    at gatewayCrash (discord-gateway.js:12:34)";
    emitter.emit("error", first);
    emitter.emit("error", second);

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]).toHaveLength(1);
    expect(String(runtime.error.mock.calls[0]?.[0])).toContain(
      "suppressed late gateway fatal error after dispose: TypeError @ gatewayCrash (discord-gateway.js:12:34)",
    );
  });
});
