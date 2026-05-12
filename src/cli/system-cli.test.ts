import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();
const addGatewayClientOptions = vi.fn((command: Command) => command);

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions,
  callGatewayFromCli,
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime,
  writeRuntimeJson: (runtime: { log: (...args: unknown[]) => void }, value: unknown, space = 2) =>
    runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
}));

const { registerSystemCli } = await import("./system-cli.js");

describe("system-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSystemCli(program);
    try {
      await program.parseAsync(args, { from: "user" });
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("__exit__:"))) {
        throw err;
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("runs system event with default wake mode and text output", async () => {
    await runCli(["system", "event", "--text", "  hello world  "]);

    const [method, payload, options, requestOptions] = callGatewayFromCli.mock.calls.at(0) ?? [];
    expect(method).toBe("wake");
    expect((payload as { text?: string } | undefined)?.text).toBe("  hello world  ");
    expect(options).toEqual({ mode: "next-heartbeat", text: "hello world" });
    expect(requestOptions).toEqual({ expectFinal: false });
    expect(runtimeLogs).toEqual(["ok"]);
  });

  it("prints JSON for event when --json is enabled", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ id: "wake-1" });

    await runCli(["system", "event", "--text", "hello", "--json"]);

    expect(runtimeLogs).toEqual([JSON.stringify({ id: "wake-1" }, null, 2)]);
  });

  it("handles invalid wake mode as runtime error", async () => {
    await runCli(["system", "event", "--text", "hello", "--mode", "later"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toContain("--mode must be now or next-heartbeat");
  });

  it("forwards --session-key on system event", async () => {
    await runCli([
      "system",
      "event",
      "--text",
      "ping",
      "--session-key",
      "agent:main:telegram:dm:42",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [method, gatewayOptions, params, requestOptions] =
      callGatewayFromCli.mock.calls.at(0) ?? [];
    expect(method).toBe("wake");
    expect(typeof gatewayOptions).toBe("object");
    expect(params).toEqual({
      mode: "next-heartbeat",
      text: "ping",
      sessionKey: "agent:main:telegram:dm:42",
    });
    expect(requestOptions).toEqual({ expectFinal: false });
  });

  it("omits sessionKey from payload when --session-key not provided", async () => {
    await runCli(["system", "event", "--text", "ping"]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [, , params] = callGatewayFromCli.mock.calls.at(0) ?? [];
    expect(params).not.toHaveProperty("sessionKey");
  });

  it("treats empty --session-key as omitted", async () => {
    await runCli(["system", "event", "--text", "ping", "--session-key", "  "]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [, , params] = callGatewayFromCli.mock.calls.at(0) ?? [];
    expect(params).not.toHaveProperty("sessionKey");
  });

  it.each([
    { args: ["system", "heartbeat", "last"], method: "last-heartbeat", params: undefined },
    {
      args: ["system", "heartbeat", "enable"],
      method: "set-heartbeats",
      params: { enabled: true },
    },
    {
      args: ["system", "heartbeat", "disable"],
      method: "set-heartbeats",
      params: { enabled: false },
    },
    { args: ["system", "presence"], method: "system-presence", params: undefined },
  ])("routes $args to gateway", async ({ args, method, params }) => {
    callGatewayFromCli.mockResolvedValueOnce({ method });

    await runCli(args);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [calledMethod, gatewayOptions, calledParams, requestOptions] =
      callGatewayFromCli.mock.calls.at(0) ?? [];
    expect(calledMethod).toBe(method);
    expect(typeof gatewayOptions).toBe("object");
    expect(calledParams).toEqual(params);
    expect(requestOptions).toEqual({ expectFinal: false });
    expect(runtimeLogs).toEqual([JSON.stringify({ method }, null, 2)]);
  });
});
