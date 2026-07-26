// Gateway restart-handoff command registration and machine JSON contract tests.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { addGatewayRestartHandoffCommands } from "./register-restart-handoff.js";

const mocks = vi.hoisted(() => ({
  consumeGatewayRestartHandoffSync: vi.fn(),
  defaultRuntime: {
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../infra/restart-handoff.js", () => ({
  consumeGatewayRestartHandoffSync: (opts: unknown) => mocks.consumeGatewayRestartHandoffSync(opts),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function registerGatewayRestartHandoffCli(program: Command): void {
  const gateway = program.command("gateway");
  addGatewayRestartHandoffCommands(gateway);
}

describe("gateway restart-handoff commands", () => {
  beforeEach(() => {
    mocks.consumeGatewayRestartHandoffSync.mockReset();
    mocks.defaultRuntime.error.mockReset();
    mocks.defaultRuntime.writeJson.mockReset();
    mocks.defaultRuntime.exit.mockReset();
  });

  it("keeps the machine command group out of normal gateway help", () => {
    const program = new Command();
    const gateway = program.command("gateway");
    addGatewayRestartHandoffCommands(gateway);

    expect(gateway.helpInformation()).not.toContain("restart-handoff");
  });

  it("reports protocol version 1 capabilities", async () => {
    await runRegisteredCli({
      register: registerGatewayRestartHandoffCli,
      argv: ["gateway", "restart-handoff", "capabilities", "--json"],
    });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: true,
      protocol: "openclaw.gateway.restart-handoff",
      protocolVersion: 1,
      operations: ["consume"],
    });
  });

  it("forwards a validated expected PID and wraps the consume result", async () => {
    mocks.consumeGatewayRestartHandoffSync.mockReturnValue({
      status: "none",
      reason: "missing",
    });

    await runRegisteredCli({
      register: registerGatewayRestartHandoffCli,
      argv: ["gateway", "restart-handoff", "consume", "--expected-pid", "4242", "--json"],
    });

    expect(mocks.consumeGatewayRestartHandoffSync).toHaveBeenCalledWith({
      expectedPid: 4242,
    });
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: true,
      protocol: "openclaw.gateway.restart-handoff",
      protocolVersion: 1,
      status: "none",
      reason: "missing",
    });
  });

  it.each([
    {
      name: "missing",
      argv: ["gateway", "restart-handoff", "consume", "--json"],
    },
    {
      name: "valueless",
      argv: ["gateway", "restart-handoff", "consume", "--expected-pid", "--json"],
    },
    {
      name: "unsafe",
      argv: [
        "gateway",
        "restart-handoff",
        "consume",
        "--expected-pid",
        "9007199254740992",
        "--json",
      ],
    },
    {
      name: "dash-prefixed malformed",
      argv: ["gateway", "restart-handoff", "consume", "--expected-pid", "-invalid", "--json"],
    },
    {
      name: "valid with an unknown option",
      argv: [
        "gateway",
        "restart-handoff",
        "consume",
        "--expected-pid",
        "4242",
        "--unknown",
        "--json",
      ],
    },
    {
      name: "repeated",
      argv: [
        "gateway",
        "restart-handoff",
        "consume",
        "--expected-pid",
        "111",
        "--expected-pid",
        "222",
        "--json",
      ],
    },
  ])("rejects $name expected PID values before touching the handoff store", async ({ argv }) => {
    await runRegisteredCli({
      register: registerGatewayRestartHandoffCli,
      argv,
    });

    expect(mocks.consumeGatewayRestartHandoffSync).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      protocol: "openclaw.gateway.restart-handoff",
      protocolVersion: 1,
      status: "error",
      reason: "invalid-expected-pid",
    });
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(2);
  });

  it("returns a stable machine error when the handoff store is unavailable", async () => {
    mocks.consumeGatewayRestartHandoffSync.mockImplementation(() => {
      throw new Error("database locked");
    });

    await runRegisteredCli({
      register: registerGatewayRestartHandoffCli,
      argv: ["gateway", "restart-handoff", "consume", "--expected-pid", "4242", "--json"],
    });

    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      "Gateway restart handoff consume failed: Error: database locked",
    );
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      protocol: "openclaw.gateway.restart-handoff",
      protocolVersion: 1,
      status: "error",
      reason: "store-unavailable",
    });
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});
