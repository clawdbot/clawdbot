// Gateway RPC runtime tests cover CLI gateway RPC calls and runtime error handling.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addGatewayClientOptions } from "./gateway-rpc.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";

const callGatewayMock = vi.fn(async () => ({ ok: true }));
const isImplicitLocalGatewayTargetMock = vi.fn(async () => true);
vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
  isImplicitLocalGatewayTarget: isImplicitLocalGatewayTargetMock,
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => await action(),
}));

const { callGatewayFromCliRuntime, isImplicitLocalGatewayTargetFromCliRuntime } =
  await import("./gateway-rpc.runtime.js");

describe("addGatewayClientOptions", () => {
  it.each([
    { name: "token", flag: "--token", value: "test-gateway-token" },
    { name: "password", flag: "--password", value: "test-gateway-password" },
  ])(
    "registers and parses explicit gateway $name authentication",
    async ({ name, flag, value }) => {
      const program = new Command().exitOverride();
      const action = vi.fn((_opts: GatewayRpcOpts) => {});
      addGatewayClientOptions(program.command("gateway-command")).action(action);

      await program.parseAsync(
        ["gateway-command", "--url", "wss://gateway.example/ws", flag, value],
        { from: "user" },
      );

      expect(action).toHaveBeenCalledOnce();
      expect(action.mock.calls[0]?.[0]).toMatchObject({
        url: "wss://gateway.example/ws",
        [name]: value,
      });
    },
  );

  it("registers and parses a local Gateway port", async () => {
    const program = new Command().exitOverride();
    const action = vi.fn((_opts: GatewayRpcOpts) => {});
    addGatewayClientOptions(program.command("gateway-command")).action(action);

    await program.parseAsync(["gateway-command", "--port", "19083"], { from: "user" });

    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ port: "19083" }),
      expect.anything(),
    );
  });
});

describe("callGatewayFromCliRuntime", () => {
  beforeEach(() => {
    callGatewayMock.mockClear().mockResolvedValue({ ok: true });
  });

  it("uses the 30s Gateway RPC default timeout when --timeout is omitted", async () => {
    await callGatewayFromCliRuntime("cron.status", {});

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.status",
        timeoutMs: 30_000,
      }),
    );
  });

  it("accepts a caller-specific default timeout", async () => {
    await callGatewayFromCliRuntime("health", {}, undefined, { defaultTimeoutMs: 10_000 });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "health", timeoutMs: 10_000 }),
    );
  });

  it("forwards specialized connection and authorization context", async () => {
    const config = { gateway: { mode: "local" as const } };
    await callGatewayFromCliRuntime(
      "node.list",
      { config, localPortOverride: 19_083 },
      {},
      {
        timeoutMs: null,
        scopes: ["operator.read", "operator.pairing"],
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
      },
    );

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        localPortOverride: 19_083,
        timeoutMs: null,
        scopes: ["operator.read", "operator.pairing"],
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
      }),
    );
  });

  it("projects --port to the canonical local Gateway override", async () => {
    await callGatewayFromCliRuntime("cron.status", { port: "19083" });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ localPortOverride: 19_083 }),
    );
  });

  it.each([
    { opts: { port: "" }, error: "--port must be an integer between 1 and 65535." },
    { opts: { port: " \t " }, error: "--port must be an integer between 1 and 65535." },
    {
      opts: { url: "ws://127.0.0.1:19083", port: "19083" },
      error: "Use either --url or --port, not both.",
    },
  ])(
    "rejects invalid target $opts before opening a Gateway connection",
    async ({ opts, error }) => {
      await expect(callGatewayFromCliRuntime("cron.status", opts)).rejects.toThrow(error);

      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "token", auth: { token: "test-gateway-token" } },
    { name: "password", auth: { password: "test-gateway-password" } },
  ])("forwards explicit gateway $name authentication", async ({ auth }) => {
    await callGatewayFromCliRuntime("cron.status", {
      url: "wss://gateway.example/ws",
      ...auth,
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example/ws",
        ...auth,
      }),
    );
  });

  it.each([
    ["cron status", "cron.status"],
    ["cron list", "cron.list"],
    ["cron add", "cron.add"],
    ["cron update", "cron.update"],
    ["cron remove", "cron.remove"],
    ["cron get", "cron.get"],
    ["cron runs", "cron.runs"],
    ["cron run", "cron.run"],
    ["logs", "logs.tail"],
    ["secrets reload", "secrets.reload"],
  ])("rejects malformed shared --timeout before gateway call for %s", async (_name, method) => {
    await expect(callGatewayFromCliRuntime(method, { timeout: "10ms" })).rejects.toThrow(
      'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "10ms".',
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects explicit empty shared --timeout value %j", async (timeout) => {
    await expect(callGatewayFromCliRuntime("cron.status", { timeout })).rejects.toThrow(
      "Invalid --timeout",
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5"])("rejects invalid shared --timeout value %j", async (timeout) => {
    await expect(callGatewayFromCliRuntime("cron.status", { timeout })).rejects.toThrow(
      `Received: "${timeout}"`,
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes strict integer timeouts to the gateway call", async () => {
    await callGatewayFromCliRuntime("cron.status", { timeout: "15000" }, undefined, {
      defaultTimeoutMs: 10 * 60_000,
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.status",
        timeoutMs: 15_000,
      }),
    );
  });

  it("forwards caller cancellation to the gateway call", async () => {
    const controller = new AbortController();

    await callGatewayFromCliRuntime("logs.tail", {}, undefined, {
      signal: controller.signal,
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "logs.tail",
        signal: controller.signal,
      }),
    );
  });
});

describe("isImplicitLocalGatewayTargetFromCliRuntime", () => {
  it("forwards CLI target options to the canonical Gateway classifier", async () => {
    isImplicitLocalGatewayTargetMock.mockResolvedValueOnce(false);

    await expect(
      isImplicitLocalGatewayTargetFromCliRuntime({
        url: "ws://127.0.0.1:18789",
        token: "token",
      }),
    ).resolves.toBe(false);
    expect(isImplicitLocalGatewayTargetMock).toHaveBeenCalledWith({
      config: undefined,
      url: "ws://127.0.0.1:18789",
      localPortOverride: undefined,
    });
  });
});
