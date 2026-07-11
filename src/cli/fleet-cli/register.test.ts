import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFleetCli } from "../fleet-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("../test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    runFleetCreateCommand: vi.fn(),
    runFleetListCommand: vi.fn(),
    runFleetStatusCommand: vi.fn(),
    runFleetLogsCommand: vi.fn(),
    runFleetLifecycleCommand: vi.fn(),
    runFleetUpgradeCommand: vi.fn(),
    runFleetRemoveCommand: vi.fn(),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./commands.runtime.js", () => ({
  runFleetCreateCommand: mocks.runFleetCreateCommand,
  runFleetListCommand: mocks.runFleetListCommand,
  runFleetStatusCommand: mocks.runFleetStatusCommand,
  runFleetLogsCommand: mocks.runFleetLogsCommand,
  runFleetLifecycleCommand: mocks.runFleetLifecycleCommand,
  runFleetUpgradeCommand: mocks.runFleetUpgradeCommand,
  runFleetRemoveCommand: mocks.runFleetRemoveCommand,
}));

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  registerFleetCli(program);
  return program;
}

async function runFleetCli(argv: string[]): Promise<void> {
  await createProgram().parseAsync(["fleet", ...argv], { from: "user" });
}

describe("fleet cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
  });

  it("normalizes create options", async () => {
    await runFleetCli([
      "create",
      "tenant-a",
      "--image",
      "registry.example/openclaw:v1",
      "--runtime",
      "podman",
      "--port",
      "19123",
      "--memory",
      "3g",
      "--cpus",
      "1.5",
      "--pids-limit",
      "256",
      "--env",
      "CHANNEL_ID=alpha",
      "--env",
      "FEATURE_FLAG=1",
      "--gateway-token",
      "test-token",
      "--no-start",
      "--json",
    ]);

    expect(mocks.runFleetCreateCommand).toHaveBeenCalledOnce();
    expect(mocks.runFleetCreateCommand).toHaveBeenCalledWith({
      tenant: "tenant-a",
      image: "registry.example/openclaw:v1",
      runtime: "podman",
      port: 19_123,
      memory: "3g",
      cpus: "1.5",
      pidsLimit: 256,
      env: ["CHANNEL_ID=alpha", "FEATURE_FLAG=1"],
      gatewayToken: "test-token",
      start: false,
      json: true,
    });
  });

  it("applies create defaults", async () => {
    await runFleetCli(["create", "tenant-b"]);

    expect(mocks.runFleetCreateCommand).toHaveBeenCalledWith({
      tenant: "tenant-b",
      image: "ghcr.io/openclaw/openclaw:latest",
      runtime: "docker",
      port: undefined,
      memory: "2g",
      cpus: "2",
      pidsLimit: 512,
      env: [],
      gatewayToken: undefined,
      start: true,
      json: false,
    });
  });

  it.each(["list", "ls"])("routes fleet %s JSON output", async (command) => {
    await runFleetCli([command, "--json"]);

    expect(mocks.runFleetListCommand).toHaveBeenCalledOnce();
    expect(mocks.runFleetListCommand).toHaveBeenCalledWith({ json: true });
  });

  it("normalizes logs options", async () => {
    await runFleetCli(["logs", "acme", "--follow", "--tail", "100", "--since", "10m"]);

    expect(mocks.runFleetLogsCommand).toHaveBeenCalledWith({
      tenant: "acme",
      follow: true,
      tail: 100,
      since: "10m",
    });
  });

  it("normalizes remove safety flags", async () => {
    await runFleetCli(["rm", "tenant-a", "--purge-data", "--force"]);

    expect(mocks.runFleetRemoveCommand).toHaveBeenCalledOnce();
    expect(mocks.runFleetRemoveCommand).toHaveBeenCalledWith({
      tenant: "tenant-a",
      purgeData: true,
      force: true,
    });
  });

  it.each([
    {
      argv: ["create", "tenant-a", "--runtime", "containerd"],
      error: /--runtime must be docker or podman/,
    },
    {
      argv: ["create", "tenant-a", "--port", "65536"],
      error: /--port must be between 1 and 65535/,
    },
    {
      argv: ["create", "tenant-a", "--cpus", "0"],
      error: /--cpus must be a positive number/,
    },
    {
      argv: ["logs", "tenant-a", "--tail", "1.5"],
      error: /--tail must be a positive integer/,
    },
  ])("rejects invalid options: $argv", async ({ argv, error }) => {
    await expect(runFleetCli(argv)).rejects.toThrow(error);
    expect(mocks.runFleetCreateCommand).not.toHaveBeenCalled();
    expect(mocks.runFleetLogsCommand).not.toHaveBeenCalled();
  });
});
