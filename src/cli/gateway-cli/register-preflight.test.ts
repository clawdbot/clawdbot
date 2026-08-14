import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { addGatewayPreflightCommand } from "./register-preflight.js";

const mocks = vi.hoisted(() => ({
  gatewayPreflightCommand: vi.fn(),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/gateway-preflight.js", () => ({
  gatewayPreflightCommand: mocks.gatewayPreflightCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function register(program: Command): void {
  addGatewayPreflightCommand(program.command("gateway"));
}

describe("gateway preflight registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the public command and forwards JSON mode", async () => {
    const program = new Command();
    const gateway = program.command("gateway");
    addGatewayPreflightCommand(gateway);
    expect(gateway.helpInformation()).toContain("preflight");

    await runRegisteredCli({
      register,
      argv: ["gateway", "preflight", "--json"],
    });

    expect(mocks.gatewayPreflightCommand).toHaveBeenCalledWith(
      { json: true },
      mocks.defaultRuntime,
    );
  });
});
