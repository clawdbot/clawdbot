import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentCommands } from "./register.agent.js";

const mocks = vi.hoisted(() => ({
  agentCliCommandMock: vi.fn(),
  agentsAddCommandMock: vi.fn(),
  agentsBindingsCommandMock: vi.fn(),
  agentsBindCommandMock: vi.fn(),
  agentsDeleteCommandMock: vi.fn(),
  agentsListCommandMock: vi.fn(),
  agentsSetIdentityCommandMock: vi.fn(),
  agentsUnbindCommandMock: vi.fn(),
  setVerboseMock: vi.fn(),
  createDefaultDepsMock: vi.fn(() => ({ deps: true })),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const agentCliCommandMock = mocks.agentCliCommandMock;
const agentsAddCommandMock = mocks.agentsAddCommandMock;
const agentsBindingsCommandMock = mocks.agentsBindingsCommandMock;
const agentsBindCommandMock = mocks.agentsBindCommandMock;
const agentsDeleteCommandMock = mocks.agentsDeleteCommandMock;
const agentsListCommandMock = mocks.agentsListCommandMock;
const agentsSetIdentityCommandMock = mocks.agentsSetIdentityCommandMock;
const agentsUnbindCommandMock = mocks.agentsUnbindCommandMock;
const setVerboseMock = mocks.setVerboseMock;
const createDefaultDepsMock = mocks.createDefaultDepsMock;
const runtime = mocks.runtime;

vi.mock("../../commands/agent-via-gateway.js", () => ({
  agentCliCommand: mocks.agentCliCommandMock,
}));

vi.mock("../../commands/agents.js", () => ({
  agentsAddCommand: mocks.agentsAddCommandMock,
  agentsBindingsCommand: mocks.agentsBindingsCommandMock,
  agentsBindCommand: mocks.agentsBindCommandMock,
  agentsDeleteCommand: mocks.agentsDeleteCommandMock,
  agentsListCommand: mocks.agentsListCommandMock,
  agentsSetIdentityCommand: mocks.agentsSetIdentityCommandMock,
  agentsUnbindCommand: mocks.agentsUnbindCommandMock,
}));

vi.mock("../../globals.js", () => ({
  setVerbose: mocks.setVerboseMock,
}));

vi.mock("../deps.js", () => ({
  createDefaultDeps: mocks.createDefaultDepsMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerAgentCommands", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerAgentCommands(program, { agentChannelOptions: "last|telegram|discord" });
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.exit.mockImplementation(() => {});
    agentCliCommandMock.mockResolvedValue(undefined);
    agentsAddCommandMock.mockResolvedValue(undefined);
    agentsBindingsCommandMock.mockResolvedValue(undefined);
    agentsBindCommandMock.mockResolvedValue(undefined);
    agentsDeleteCommandMock.mockResolvedValue(undefined);
    agentsListCommandMock.mockResolvedValue(undefined);
    agentsSetIdentityCommandMock.mockResolvedValue(undefined);
    agentsUnbindCommandMock.mockResolvedValue(undefined);
    createDefaultDepsMock.mockReturnValue({ deps: true });
  });

  function commandCall(mock: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`expected command call ${index + 1}`);
    }
    return call;
  }

  it("runs agent command with deps and verbose enabled for --verbose on", async () => {
    await runCli(["agent", "--message", "hi", "--verbose", "ON", "--json"]);

    expect(setVerboseMock).toHaveBeenCalledWith(true);
    expect(createDefaultDepsMock).toHaveBeenCalledTimes(1);
    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBe("hi");
    expect((options as { verbose?: string }).verbose).toBe("ON");
    expect((options as { json?: boolean }).json).toBe(true);
    expect(callRuntime).toBe(runtime);
    expect(deps).toEqual({ deps: true });
  });

  it("runs agent command with verbose disabled for --verbose off", async () => {
    await runCli(["agent", "--message", "hi", "--verbose", "off"]);

    expect(setVerboseMock).toHaveBeenCalledWith(false);
    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBe("hi");
    expect((options as { verbose?: string }).verbose).toBe("off");
    expect(callRuntime).toBe(runtime);
    expect(deps).toEqual({ deps: true });
  });

  it("accepts a model override for one-shot agent runs", async () => {
    await runCli(["agent", "--message", "hi", "--agent", "ops", "--model", "openai/gpt-5.4"]);

    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBe("hi");
    expect((options as { agent?: string }).agent).toBe("ops");
    expect((options as { model?: string }).model).toBe("openai/gpt-5.4");
    expect(callRuntime).toBe(runtime);
    expect(deps).toEqual({ deps: true });
  });

  it("runs agents add and computes hasFlags based on explicit options", async () => {
    await runCli(["agents", "add", "alpha"]);
    const [alphaOptions, alphaRuntime, alphaFlags] = commandCall(agentsAddCommandMock, 0);
    expect((alphaOptions as { name?: string }).name).toBe("alpha");
    expect((alphaOptions as { workspace?: string }).workspace).toBeUndefined();
    expect((alphaOptions as { bind?: string[] }).bind).toEqual([]);
    expect(alphaRuntime).toBe(runtime);
    expect(alphaFlags).toEqual({ hasFlags: false });

    await runCli([
      "agents",
      "add",
      "beta",
      "--workspace",
      "/tmp/ws",
      "--bind",
      "telegram",
      "--bind",
      "discord:acct",
      "--non-interactive",
      "--json",
    ]);
    const [betaOptions, betaRuntime, betaFlags] = commandCall(agentsAddCommandMock, 1);
    expect((betaOptions as { name?: string }).name).toBe("beta");
    expect((betaOptions as { workspace?: string }).workspace).toBe("/tmp/ws");
    expect((betaOptions as { bind?: string[] }).bind).toEqual(["telegram", "discord:acct"]);
    expect((betaOptions as { nonInteractive?: boolean }).nonInteractive).toBe(true);
    expect((betaOptions as { json?: boolean }).json).toBe(true);
    expect(betaRuntime).toBe(runtime);
    expect(betaFlags).toEqual({ hasFlags: true });
  });

  it("runs agents list when root agents command is invoked", async () => {
    await runCli(["agents"]);
    expect(agentsListCommandMock).toHaveBeenCalledWith({}, runtime);
  });

  it("forwards agents list options", async () => {
    await runCli(["agents", "list", "--json", "--bindings"]);
    expect(agentsListCommandMock).toHaveBeenCalledWith(
      {
        json: true,
        bindings: true,
      },
      runtime,
    );
  });

  it("forwards agents bindings options", async () => {
    await runCli(["agents", "bindings", "--agent", "ops", "--json"]);
    expect(agentsBindingsCommandMock).toHaveBeenCalledWith(
      {
        agent: "ops",
        json: true,
      },
      runtime,
    );
  });

  it("forwards agents bind options", async () => {
    await runCli([
      "agents",
      "bind",
      "--agent",
      "ops",
      "--bind",
      "matrix:ops",
      "--bind",
      "telegram",
      "--json",
    ]);
    expect(agentsBindCommandMock).toHaveBeenCalledWith(
      {
        agent: "ops",
        bind: ["matrix:ops", "telegram"],
        json: true,
      },
      runtime,
    );
  });

  it("documents bind accountId resolution behavior in help text", () => {
    const program = new Command();
    registerAgentCommands(program, { agentChannelOptions: "last|telegram|discord" });
    const agents = program.commands.find((command) => command.name() === "agents");
    const bind = agents?.commands.find((command) => command.name() === "bind");
    const help = bind?.helpInformation() ?? "";
    expect(help).toContain("accountId is resolved by channel defaults/hooks");
  });

  it("forwards agents unbind options", async () => {
    await runCli(["agents", "unbind", "--agent", "ops", "--all", "--json"]);
    expect(agentsUnbindCommandMock).toHaveBeenCalledWith(
      {
        agent: "ops",
        bind: [],
        all: true,
        json: true,
      },
      runtime,
    );
  });

  it("forwards agents delete options", async () => {
    await runCli(["agents", "delete", "worker-a", "--force", "--json"]);
    const [options, callRuntime] = commandCall(agentsDeleteCommandMock);
    expect((options as { id?: string }).id).toBe("worker-a");
    expect((options as { force?: boolean }).force).toBe(true);
    expect((options as { json?: boolean }).json).toBe(true);
    expect(callRuntime).toBe(runtime);
  });

  it("forwards set-identity options", async () => {
    await runCli([
      "agents",
      "set-identity",
      "--agent",
      "main",
      "--workspace",
      "/tmp/ws",
      "--identity-file",
      "/tmp/ws/IDENTITY.md",
      "--from-identity",
      "--name",
      "OpenClaw",
      "--theme",
      "ops",
      "--emoji",
      ":lobster:",
      "--avatar",
      "https://example.com/openclaw.png",
      "--json",
    ]);
    expect(agentsSetIdentityCommandMock).toHaveBeenCalledWith(
      {
        agent: "main",
        workspace: "/tmp/ws",
        identityFile: "/tmp/ws/IDENTITY.md",
        fromIdentity: true,
        name: "OpenClaw",
        theme: "ops",
        emoji: ":lobster:",
        avatar: "https://example.com/openclaw.png",
        json: true,
      },
      runtime,
    );
  });

  it("reports errors via runtime when a command fails", async () => {
    agentsListCommandMock.mockRejectedValueOnce(new Error("list failed"));

    await runCli(["agents"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: list failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports errors via runtime when agent command fails", async () => {
    agentCliCommandMock.mockRejectedValueOnce(new Error("agent failed"));

    await runCli(["agent", "--message", "hello"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: agent failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
