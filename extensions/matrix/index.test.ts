import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import { registerMatrixCliMetadata } from "./cli-metadata.js";
import entry, { registerMatrixFullRuntime } from "./index.js";

const cliMocks = vi.hoisted(() => ({
  registerMatrixCli: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  ensureMatrixCryptoRuntime: vi.fn(async () => {}),
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

    const registrar = registerCli.mock.calls[0]?.[0];
    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), {
      descriptors: [
        {
          name: "matrix",
          description: "Manage Matrix accounts, verification, devices, and profile state",
          hasSubcommands: true,
        },
      ],
    });
    expect(typeof registrar).toBe("function");
    expect(cliMocks.registerMatrixCli).not.toHaveBeenCalled();

    const program = { command: vi.fn() };
    const result = registrar?.({ program } as never);

    await result;
    expect(cliMocks.registerMatrixCli).toHaveBeenCalledWith({ program });
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });

  it("keeps runtime bootstrap and CLI metadata out of setup-only registration", () => {
    expect(entry.kind).toBe("bundled-channel-entry");
    expect(entry.id).toBe("matrix");
    expect(entry.name).toBe("Matrix");
    expect(entry.setChannelRuntime).toEqual(expect.any(Function));
  });

  it("registers CLI metadata during discovery registration", () => {
    const registerChannel = vi.fn();
    const registerCli = vi.fn();
    const registerGatewayMethod = vi.fn();
    const api = createTestPluginApi({
      id: "matrix",
      name: "Matrix",
      source: "test",
      config: {},
      runtime: {} as never,
      registrationMode: "discovery",
      registerChannel,
      registerCli,
      registerGatewayMethod,
    });

    entry.register(api);

    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), {
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

  it("registers subagent lifecycle hooks during full runtime registration", () => {
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

    expect(on.mock.calls.map(([hookName]) => hookName)).toEqual([
      "subagent_spawning",
      "subagent_ended",
      "subagent_delivery_target",
    ]);
    for (const [, handler] of on.mock.calls) {
      expect(handler).toEqual(expect.any(Function));
    }
  });
});
