import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerNodeCli } from "./register.js";

const daemonMocks = vi.hoisted(() => ({
  runNodeDaemonInstall: vi.fn(),
  runNodeDaemonRestart: vi.fn(),
  runNodeDaemonStart: vi.fn(),
  runNodeDaemonStatus: vi.fn(),
  runNodeDaemonStop: vi.fn(),
  runNodeDaemonUninstall: vi.fn(),
}));

vi.mock("./daemon.js", () => daemonMocks);

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: vi.fn(async () => null),
}));

vi.mock("../../node-host/runner.js", () => ({
  runNodeHost: vi.fn(),
}));

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  registerNodeCli(program);
  return program;
}

describe("registerNodeCli", () => {
  it("registers node start for the macOS app node service manager", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "start", "--json"], { from: "user" });

    expect(daemonMocks.runNodeDaemonStart).toHaveBeenCalledWith(
      expect.objectContaining({ json: true }),
    );
  });
});
