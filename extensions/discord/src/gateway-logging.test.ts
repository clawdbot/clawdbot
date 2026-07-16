import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
}));

let logVerbose: typeof import("openclaw/plugin-sdk/runtime-env").logVerbose;
let attachDiscordGatewayLogging: typeof import("./gateway-logging.js").attachDiscordGatewayLogging;

const makeRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

describe("attachDiscordGatewayLogging", () => {
  beforeAll(async () => {
    ({ logVerbose } = await import("openclaw/plugin-sdk/runtime-env"));
    ({ attachDiscordGatewayLogging } = await import("./gateway-logging.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("logs debug events and promotes reconnect/close to info", () => {
    const emitter = new EventEmitter();
    const runtime = makeRuntime();

    const cleanup = attachDiscordGatewayLogging({
      emitter,
      runtime,
    });

    emitter.emit("debug", "Gateway websocket opened");
    emitter.emit("debug", "Gateway websocket closed: 1001");
    emitter.emit("debug", "Gateway reconnect scheduled in 1000ms (close, resume=true)");
    emitter.emit("debug", "Gateway forcing fresh IDENTIFY after 3 failed resume attempts");

    const logVerboseMock = vi.mocked(logVerbose);
    expect(logVerboseMock).toHaveBeenCalledTimes(4);
    expect(runtime.log).toHaveBeenCalledTimes(3);
    expect(runtime.log).toHaveBeenNthCalledWith(
      1,
      "discord gateway: Gateway websocket closed: 1001",
    );
    expect(runtime.log).toHaveBeenNthCalledWith(
      2,
      "discord gateway: Gateway reconnect scheduled in 1000ms (close, resume=true)",
    );
    expect(runtime.log).toHaveBeenNthCalledWith(
      3,
      "discord gateway: Gateway forcing fresh IDENTIFY after 3 failed resume attempts",
    );

    cleanup();
  });

  it("logs warnings and metrics only to verbose", () => {
    const emitter = new EventEmitter();
    const runtime = makeRuntime();

    const cleanup = attachDiscordGatewayLogging({
      emitter,
      runtime,
    });

    emitter.emit("warning", "High latency detected: 1200ms");
    emitter.emit("metrics", { latency: 42, errors: 1 });

    const logVerboseMock = vi.mocked(logVerbose);
    expect(logVerboseMock).toHaveBeenCalledTimes(2);
    expect(runtime.log).not.toHaveBeenCalled();

    cleanup();
  });

  it("removes listeners on cleanup", () => {
    const emitter = new EventEmitter();
    const runtime = makeRuntime();

    const cleanup = attachDiscordGatewayLogging({
      emitter,
      runtime,
    });
    cleanup();

    const logVerboseMock = vi.mocked(logVerbose);
    logVerboseMock.mockClear();

    emitter.emit("debug", "Gateway websocket closed: 1001");
    emitter.emit("warning", "High latency detected: 1200ms");
    emitter.emit("metrics", { latency: 42 });

    expect(logVerboseMock).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
