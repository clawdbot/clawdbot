import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { registerMatrixCliMetadata } from "./cli-metadata.js";
import entry, { registerMatrixFullRuntime } from "./index.js";

const cliMocks = vi.hoisted(() => ({
  registerMatrixCli: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  ensureMatrixCryptoRuntime: vi.fn(async () => {}),
  handleMatrixSubagentDeliveryTarget: vi.fn(() => "delivery-target"),
  handleMatrixSubagentEnded: vi.fn(async () => {}),
  handleMatrixSubagentSpawning: vi.fn(async () => "spawned"),
  handleVerificationBootstrap: vi.fn(async () => {}),
  handleVerificationStatus: vi.fn(async () => {}),
  handleVerifyRecoveryKey: vi.fn(async () => {}),
  setMatrixRuntime: vi.fn(),
}));

vi.mock("./src/cli.js", () => {
  return {
    registerMatrixCli: cliMocks.registerMatrixCli,
  };
});

vi.mock("./plugin-entry.handlers.runtime.js", () => runtimeMocks);
vi.mock("./runtime-setter-api.js", () => ({ setMatrixRuntime: runtimeMocks.setMatrixRuntime }));
vi.mock("./src/matrix/subagent-hooks.js", () => runtimeMocks);

function requireFirstCliRegistration(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call || typeof call[0] !== "function") {
    throw new Error("expected Matrix CLI registration");
  }
  return call as [(ctx: unknown) => unknown, unknown];
}

describe("matrix plugin", () => {
  it("registers matrix CLI through a descriptor-backed lazy registrar", async () => {
    const registerCli = vi.fn();
    const registerGatewayMethod = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: {} as never,
      registrationMode: "cli-metadata",
      registerCli,
      registerGatewayMethod,
    });

    registerMatrixCliMetadata(api);

    expect(registerCli).toHaveBeenCalledTimes(1);
    const [registrar, options] = requireFirstCliRegistration(registerCli);
    expect(typeof registrar).toBe("function");
    expect(options).toEqual({
      descriptors: [
        {
          name: "matrix",
          description: "Manage Matrix accounts, verification, devices, and profile state",
          hasSubcommands: true,
        },
      ],
    });
    expect(cliMocks.registerMatrixCli).not.toHaveBeenCalled();

    const program = { command: vi.fn() };
    const result = registrar({ program } as never);

    await result;
    expect(cliMocks.registerMatrixCli).toHaveBeenCalledWith({ program });
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });

  it("keeps runtime bootstrap and CLI metadata out of setup-only registration", () => {
    expect(entry.kind).toBe("bundled-channel-entry");
    expect(entry.id).toBe("matrix");
    expect(entry.name).toBe("Matrix");
    if (!entry.setChannelRuntime) {
      throw new Error("expected Matrix runtime setter");
    }
    entry.setChannelRuntime({ marker: "runtime" } as never);
    expect(runtimeMocks.setMatrixRuntime).not.toHaveBeenCalled();
  });

  it("wires CLI metadata through the bundled entry", () => {
    const registerCli = vi.fn();
    const registerGatewayMethod = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: {} as never,
      registrationMode: "cli-metadata",
      registerCli,
      registerGatewayMethod,
    });

    entry.register(api);

    expect(registerCli).toHaveBeenCalledTimes(1);
    const [registrar, options] = requireFirstCliRegistration(registerCli);
    expect(typeof registrar).toBe("function");
    expect(options).toEqual({
      descriptors: [
        {
          name: "matrix",
          description: "Manage Matrix accounts, verification, devices, and profile state",
          hasSubcommands: true,
        },
      ],
    });
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });

  it("registers subagent lifecycle hooks during full runtime registration", async () => {
    const on = vi.fn();
    const registerGatewayMethod = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: {} as never,
      registrationMode: "full",
      on,
      registerGatewayMethod,
    });

    registerMatrixFullRuntime(api);

    expect(runtimeMocks.ensureMatrixCryptoRuntime).not.toHaveBeenCalled();
    expect(on.mock.calls.map(([hookName]) => hookName)).toEqual([
      "subagent_spawning",
      "subagent_ended",
      "subagent_delivery_target",
    ]);
    const handlers = Object.fromEntries(on.mock.calls);
    await expect(handlers.subagent_spawning({ id: "spawn" })).resolves.toBe("spawned");
    await expect(handlers.subagent_ended({ id: "ended" })).resolves.toBeUndefined();
    await expect(handlers.subagent_delivery_target({ id: "target" })).resolves.toBe(
      "delivery-target",
    );
    expect(runtimeMocks.handleMatrixSubagentSpawning).toHaveBeenCalledWith(api, { id: "spawn" });
    expect(runtimeMocks.handleMatrixSubagentEnded).toHaveBeenCalledWith({ id: "ended" });
    expect(runtimeMocks.handleMatrixSubagentDeliveryTarget).toHaveBeenCalledWith({ id: "target" });
  });
});
