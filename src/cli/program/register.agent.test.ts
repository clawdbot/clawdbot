// Register agent tests cover agent command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentTurnCommand } from "./register.agent-turn.js";
import { registerAgentsCommands } from "./register.agent.js";

const mocks = vi.hoisted(() => ({
  agentCliCommandMock: vi.fn(),
  agentExecCommandMock: vi.fn(),
  agentsAddCommandMock: vi.fn(),
  agentsBindingsCommandMock: vi.fn(),
  agentsBindCommandMock: vi.fn(),
  agentsDeleteCommandMock: vi.fn(),
  agentsListCommandMock: vi.fn(),
  agentsSetIdentityCommandMock: vi.fn(),
  agentsUnbindCommandMock: vi.fn(),
  requestExitAfterOneShotOutputMock: vi.fn(),
  setVerboseMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const agentCliCommandMock = mocks.agentCliCommandMock;
const agentExecCommandMock = mocks.agentExecCommandMock;
const agentsAddCommandMock = mocks.agentsAddCommandMock;
const agentsBindingsCommandMock = mocks.agentsBindingsCommandMock;
const agentsBindCommandMock = mocks.agentsBindCommandMock;
const agentsDeleteCommandMock = mocks.agentsDeleteCommandMock;
const agentsListCommandMock = mocks.agentsListCommandMock;
const agentsSetIdentityCommandMock = mocks.agentsSetIdentityCommandMock;
const agentsUnbindCommandMock = mocks.agentsUnbindCommandMock;
const requestExitAfterOneShotOutputMock = mocks.requestExitAfterOneShotOutputMock;
const setVerboseMock = mocks.setVerboseMock;
const runtime = mocks.runtime;

vi.mock("../../commands/agent-via-gateway.js", () => ({
  agentCliCommand: mocks.agentCliCommandMock,
}));

vi.mock("../../commands/agent-exec.js", () => ({
  agentExecCommand: mocks.agentExecCommandMock,
}));

vi.mock("../../commands/agents.commands.add.js", () => ({
  agentsAddCommand: mocks.agentsAddCommandMock,
}));

vi.mock("../../commands/agents.commands.bind.js", () => ({
  agentsBindingsCommand: mocks.agentsBindingsCommandMock,
  agentsBindCommand: mocks.agentsBindCommandMock,
  agentsUnbindCommand: mocks.agentsUnbindCommandMock,
}));

vi.mock("../../commands/agents.commands.delete.js", () => ({
  agentsDeleteCommand: mocks.agentsDeleteCommandMock,
}));

vi.mock("../../commands/agents.commands.identity.js", () => ({
  agentsSetIdentityCommand: mocks.agentsSetIdentityCommandMock,
}));

vi.mock("../../commands/agents.commands.list.js", () => ({
  agentsListCommand: mocks.agentsListCommandMock,
}));

vi.mock("../../global-state.js", () => ({
  setVerbose: mocks.setVerboseMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutputMock,
}));

describe("agent command registration", () => {
  async function runCli(args: string[]) {
    const program = new Command().enablePositionalOptions();
    registerAgentTurnCommand(program, { agentChannelOptions: "last|telegram|discord" });
    registerAgentsCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.exit.mockImplementation(() => {});
    agentCliCommandMock.mockResolvedValue(undefined);
    agentExecCommandMock.mockResolvedValue({ exitCode: 0 });
    agentsAddCommandMock.mockResolvedValue(undefined);
    agentsBindingsCommandMock.mockResolvedValue(undefined);
    agentsBindCommandMock.mockResolvedValue(undefined);
    agentsDeleteCommandMock.mockResolvedValue(undefined);
    agentsListCommandMock.mockResolvedValue(undefined);
    agentsSetIdentityCommandMock.mockResolvedValue(undefined);
    agentsUnbindCommandMock.mockResolvedValue(undefined);
  });

  function commandCall(mock: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`expected command call ${index + 1}`);
    }
    return call;
  }

  it("keeps agent help aligned with supported thinking levels and auth sources", () => {
    const program = new Command();
    registerAgentTurnCommand(program, { agentChannelOptions: "last|telegram|discord" });
    const agent = program.commands.find((command) => command.name() === "agent");
    const exec = agent?.commands.find((command) => command.name() === "exec");

    expect(agent?.options.find((option) => option.long === "--thinking")?.description).toContain(
      "ultra",
    );
    expect(exec?.options.find((option) => option.long === "--thinking")?.description).toContain(
      "ultra",
    );
    expect(agent?.options.find((option) => option.long === "--local")?.description).toContain(
      "configured provider credentials or local CLI logins",
    );
  });

  it("runs agent command with verbose enabled for --verbose on", async () => {
    await runCli(["agent", "--message", "hi", "--verbose", "ON", "--json"]);

    expect(setVerboseMock).toHaveBeenCalledWith(true);
    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBe("hi");
    expect((options as { verbose?: string }).verbose).toBe("ON");
    expect((options as { json?: boolean }).json).toBe(true);
    expect(callRuntime).toBe(runtime);
    expect(deps).toBeUndefined();
  });

  it("runs agent command with verbose disabled for --verbose off", async () => {
    await runCli(["agent", "--message", "hi", "--verbose", "off"]);

    expect(setVerboseMock).toHaveBeenCalledWith(false);
    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBe("hi");
    expect((options as { verbose?: string }).verbose).toBe("off");
    expect(callRuntime).toBe(runtime);
    expect(deps).toBeUndefined();
  });

  it("forwards a message file to the agent command", async () => {
    await runCli(["agent", "--message-file", "task.md", "--agent", "ops"]);

    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBeUndefined();
    expect((options as { messageFile?: string }).messageFile).toBe("task.md");
    expect((options as { agent?: string }).agent).toBe("ops");
    expect(callRuntime).toBe(runtime);
    expect(deps).toBeUndefined();
  });

  it("accepts a model override for one-shot agent runs", async () => {
    await runCli(["agent", "--message", "hi", "--agent", "ops", "--model", "openai/gpt-5.4"]);

    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBe("hi");
    expect((options as { agent?: string }).agent).toBe("ops");
    expect((options as { model?: string }).model).toBe("openai/gpt-5.4");
    expect(callRuntime).toBe(runtime);
    expect(deps).toBeUndefined();
  });

  it("forwards an explicit session key to the agent command", async () => {
    await runCli(["agent", "--message", "hi", "--session-key", "agent:ops:incident-42"]);

    const [options, callRuntime, deps] = commandCall(agentCliCommandMock);
    expect((options as { message?: string }).message).toBe("hi");
    expect((options as { sessionKey?: string }).sessionKey).toBe("agent:ops:incident-42");
    expect(callRuntime).toBe(runtime);
    expect(deps).toBeUndefined();
  });

  it("keeps bare agent on the existing parent action", async () => {
    await runCli(["agent", "--message", "hi", "--agent", "ops"]);

    expect(agentCliCommandMock).toHaveBeenCalledTimes(1);
    expect(agentExecCommandMock).not.toHaveBeenCalled();
    expect(requestExitAfterOneShotOutputMock).toHaveBeenCalledWith(runtime, 0);
  });

  it("keeps an exec-valued parent message on the existing parent action", async () => {
    await runCli(["agent", "--message", "exec", "--agent", "ops"]);

    expect(agentCliCommandMock).toHaveBeenCalledTimes(1);
    expect(agentExecCommandMock).not.toHaveBeenCalled();
  });

  it("runs the nested headless exec command with repeatable fallbacks", async () => {
    await runCli([
      "agent",
      "exec",
      "fix it",
      "--cwd",
      "/tmp/project",
      "--model",
      "openai/gpt-5.6-sol",
      "--code-mode",
      "code",
      "--local-model-lean",
      "--fallback",
      "anthropic/claude-sonnet-4-6",
      "--fallback",
      "google/gemini-3.1-pro-preview",
      "--json",
    ]);

    expect(agentCliCommandMock).not.toHaveBeenCalled();
    expect(agentExecCommandMock).toHaveBeenCalledWith(
      "fix it",
      expect.objectContaining({
        cwd: "/tmp/project",
        model: "openai/gpt-5.6-sol",
        codeMode: "code",
        localModelLean: true,
        fallback: ["anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro-preview"],
        // Stored credentials are the default so exec reaches the same logins as
        // the rest of the CLI; --auth-env-only is the opt-in restriction.
        authEnvOnly: false,
        isolated: false,
        timeout: "600",
        json: true,
      }),
      runtime,
    );
  });

  it("restricts credentials and config to the process environment with --auth-env-only", async () => {
    await runCli(["agent", "exec", "fix it", "--auth-env-only"]);

    expect(agentExecCommandMock).toHaveBeenCalledWith(
      "fix it",
      expect.objectContaining({ authEnvOnly: true }),
      runtime,
    );
  });

  it("forwards the pinned-config and isolated run flags", async () => {
    await runCli(["agent", "exec", "fix it", "--config", "/tmp/ci.json", "--isolated"]);

    expect(agentExecCommandMock).toHaveBeenCalledWith(
      "fix it",
      expect.objectContaining({ config: "/tmp/ci.json", isolated: true }),
      runtime,
    );
  });

  it("accepts parent options before the nested exec command", async () => {
    await runCli(["agent", "--model", "openai/gpt-5.6-sol", "exec", "fix it", "--json"]);

    expect(agentCliCommandMock).not.toHaveBeenCalled();
    expect(agentExecCommandMock).toHaveBeenCalledWith(
      "fix it",
      expect.objectContaining({ model: "openai/gpt-5.6-sol", json: true }),
      runtime,
    );
  });

  it("resolves nested exec --timeout from the explicit leaf, then the parent, then the default", async () => {
    await runCli(["agent", "exec", "fix it", "--timeout", "120"]);
    expect(agentExecCommandMock).toHaveBeenLastCalledWith(
      "fix it",
      expect.objectContaining({ timeout: "120" }),
      runtime,
    );

    await runCli(["agent", "--timeout", "30", "exec", "fix it"]);
    expect(agentExecCommandMock).toHaveBeenLastCalledWith(
      "fix it",
      expect.objectContaining({ timeout: "30" }),
      runtime,
    );

    await runCli(["agent", "--timeout", "30", "exec", "fix it", "--timeout", "120"]);
    expect(agentExecCommandMock).toHaveBeenLastCalledWith(
      "fix it",
      expect.objectContaining({ timeout: "120" }),
      runtime,
    );
  });

  it("runs agents add and detects explicit automation options", async () => {
    await runCli(["agents", "add", "alpha"]);
    const [alphaOptions, alphaRuntime, alphaFlags] = commandCall(agentsAddCommandMock, 0);
    expect((alphaOptions as { name?: string }).name).toBe("alpha");
    expect((alphaOptions as { workspace?: string }).workspace).toBeUndefined();
    expect((alphaOptions as { bind?: string[] }).bind).toEqual([]);
    expect(alphaRuntime).toBe(runtime);
    expect(alphaFlags).toEqual({ hasAutomationFlags: false });

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
    expect(betaFlags).toEqual({ hasAutomationFlags: true });
  });

  it("keeps JSON-only agent creation in wizard mode", async () => {
    await runCli(["agents", "add", "alpha", "--json"]);

    const [options, callRuntime, flags] = commandCall(agentsAddCommandMock);
    expect(options).toEqual(
      expect.objectContaining({ name: "alpha", json: true, nonInteractive: false }),
    );
    expect(callRuntime).toBe(runtime);
    expect(flags).toEqual({ hasAutomationFlags: false });
  });

  it("runs agents list when root agents command is invoked", async () => {
    await runCli(["agents"]);
    expect(agentsListCommandMock).toHaveBeenCalledWith({}, runtime);
  });

  it("forwards agents list options", async () => {
    await runCli(["agents", "list", "--json", "--bindings", "--tree"]);
    expect(agentsListCommandMock).toHaveBeenCalledWith(
      {
        json: true,
        bindings: true,
        tree: true,
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
    registerAgentsCommands(program);
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

    expect(runtime.error).toHaveBeenCalledWith("list failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { label: "human", args: ["agent", "--message", "hello"] },
    { label: "JSON", args: ["agent", "--message", "hello", "--json"] },
  ])(
    "renders gateway request errors without internal class names in $label mode",
    async ({ args }) => {
      const message =
        "The selected model was not found by the provider. Check the model id or choose a different model.";
      const error = Object.assign(new Error(message), {
        name: "GatewayClientRequestError",
        code: "UNAVAILABLE",
        gatewayCode: "UNAVAILABLE",
        details: { reason: "model_not_found" },
      });
      agentCliCommandMock.mockRejectedValueOnce(error);

      await runCli(args);

      expect(runtime.error).toHaveBeenCalledWith(message);
      expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("Error:"));
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );
});
