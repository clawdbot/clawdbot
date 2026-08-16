// System CLI tests cover system command registration and status output.
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

function gatewayCall(callIndex = 0): ReadonlyArray<unknown> {
  const call = callGatewayFromCli.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected gateway call ${callIndex + 1}`);
  }
  return call;
}

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

    const [method, payload, options, requestOptions] = gatewayCall();
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

  it("reports a rejected system event instead of claiming it was enqueued", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ ok: false, reason: "unwakeable-session-key" });

    await runCli(["system", "event", "--text", "hello"]);

    expect(runtimeLogs).toEqual([]);
    expect(runtimeErrors[0]).toContain("unwakeable-session-key");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("handles invalid wake mode as runtime error", async () => {
    await runCli(["system", "event", "--text", "hello", "--mode", "later"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeLogs).toEqual([]);
    expect(runtimeErrors[0]).toContain("--mode must be now or next-heartbeat");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    {
      name: "invalid wake mode",
      args: ["system", "event", "--text", "hello", "--mode", "later", "--json"],
      gatewayResult: undefined,
      expectedError: "--mode must be now or next-heartbeat",
      gatewayCalls: 0,
    },
    {
      name: "rejected Gateway call",
      args: ["system", "event", "--text", "hello", "--json"],
      gatewayResult: { ok: false, reason: "unwakeable-session-key" },
      expectedError: "unwakeable-session-key",
      gatewayCalls: 1,
    },
  ])(
    "writes JSON when $name fails",
    async ({ args, gatewayResult, expectedError, gatewayCalls }) => {
      if (gatewayResult) {
        callGatewayFromCli.mockResolvedValueOnce(gatewayResult);
      }

      await runCli(args);

      expect(runtimeLogs).toEqual([JSON.stringify({ error: expectedError }, null, 2)]);
      expect(runtimeErrors).toEqual([]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ error: expectedError });
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(callGatewayFromCli).toHaveBeenCalledTimes(gatewayCalls);
    },
  );

  it.each([
    { mode: "human", args: ["system", "event", "--text", "hello"] },
    { mode: "JSON", args: ["system", "event", "--text", "hello", "--json"] },
  ])("renders named errors without class names in $mode mode", async ({ mode, args }) => {
    const error = new Error("Multiple agents are configured, but this operation has no owner.");
    error.name = "AgentSelectionRequiredError";
    callGatewayFromCli.mockRejectedValueOnce(error);

    await runCli(args);

    if (mode === "JSON") {
      const payload = JSON.parse(runtimeLogs.at(-1) ?? "");
      expect(payload).toEqual({ error: error.message });
      expect(runtimeErrors).toEqual([]);
    } else {
      expect(runtimeErrors).toEqual([error.message]);
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    }
    expect([...runtimeLogs, ...runtimeErrors].join("\n")).not.toContain(error.name);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
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
    const [method, gatewayOptions, params, requestOptions] = gatewayCall();
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
    const params = gatewayCall()[2];
    expect(params).not.toHaveProperty("sessionKey");
  });

  it("treats empty --session-key as omitted", async () => {
    await runCli(["system", "event", "--text", "ping", "--session-key", "  "]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const params = gatewayCall()[2];
    expect(params).not.toHaveProperty("sessionKey");
  });

  it("writes JSON when an implicit machine-output command fails", async () => {
    callGatewayFromCli.mockRejectedValueOnce(new Error("Gateway unavailable"));

    await runCli(["system", "heartbeat", "last"]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [method, gatewayOptions, params, requestOptions] = gatewayCall();
    expect(method).toBe("last-heartbeat");
    expect(typeof gatewayOptions).toBe("object");
    expect(params).toBeUndefined();
    expect(requestOptions).toEqual({ expectFinal: false });
    const expectedError = "Gateway unavailable";
    expect(runtimeLogs).toEqual([JSON.stringify({ error: expectedError }, null, 2)]);
    expect(runtimeErrors).toEqual([]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ error: expectedError });
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
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
    const [calledMethod, gatewayOptions, calledParams, requestOptions] = gatewayCall();
    expect(calledMethod).toBe(method);
    expect(typeof gatewayOptions).toBe("object");
    expect(calledParams).toEqual(params);
    expect(requestOptions).toEqual({ expectFinal: false });
    expect(runtimeLogs).toEqual([JSON.stringify({ method }, null, 2)]);
  });
});
