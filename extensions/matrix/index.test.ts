import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import { registerMatrixCliMetadata } from "./cli-metadata.js";
import entry from "./index.js";

const cliMocks = vi.hoisted(() => ({
  registerMatrixCli: vi.fn(),
}));

vi.mock("./src/cli.js", () => {
  return {
    registerMatrixCli: cliMocks.registerMatrixCli,
  };
});

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
  });
});
