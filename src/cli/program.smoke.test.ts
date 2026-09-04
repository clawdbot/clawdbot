// Program smoke tests cover core CLI command registration and startup behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./program.js";
import {
  programGatewayCallMock,
  configureCommand,
  ensureConfigReadyMock,
  runtime,
  setupCommandMock,
  setupWizardCommandMock,
  systemAgentRunMock,
  tuiRunMock,
} from "./program.test-mocks.js";

vi.mock("./config-cli.js", () => ({
  registerConfigCli: (program: {
    command: (name: string) => { action: (fn: () => unknown) => void };
  }) => {
    program.command("config").action(() => configureCommand({}, runtime));
  },
  runConfigGet: vi.fn(),
  runConfigUnset: vi.fn(),
}));

describe("cli program (smoke)", () => {
  let program = createProgram();

  function createProgram() {
    return buildProgram();
  }

  async function runProgram(argv: string[]) {
    await program.parseAsync(argv, { from: "user" });
  }

  function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error("expected mock to have at least one call");
    }
    return call[0];
  }

  beforeEach(() => {
    program = createProgram();
    vi.clearAllMocks();
    tuiRunMock.mockResolvedValue(undefined);
    systemAgentRunMock.mockResolvedValue(undefined);
    ensureConfigReadyMock.mockResolvedValue(undefined);
  });

  it("registers message + status commands", () => {
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("message");
    expect(names).toContain("status");
  });

  it("runs tui with explicit timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "45000"]);
    const options = firstMockArg(tuiRunMock) as {
      timeoutMs?: number;
      historyLimit?: number;
      forceProcessExitOnReturn?: boolean;
    };
    expect(options?.timeoutMs).toBe(45000);
    expect(options?.historyLimit).toBe(200);
    expect(options?.forceProcessExitOnReturn).toBe(true);
  });

  it("resolves a positional tui short reference before launch", async () => {
    programGatewayCallMock.mockResolvedValue({ ok: true, key: "agent:main:thread:resolved" });

    await runProgram(["tui", "movies-a1166b81"]);

    expect(programGatewayCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: { shortId: "a1166b81", slugHint: "movies" },
      }),
    );
    expect(firstMockArg(tuiRunMock)).toMatchObject({
      local: false,
      session: "agent:main:thread:resolved",
    });
  });

  it("preserves a global-scope URL main session when launching tui", async () => {
    programGatewayCallMock.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [],
    });

    await runProgram(["tui", "https://gateway.example/dashboard/ops"]);

    expect(programGatewayCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agents.list",
        params: {},
      }),
    );
    expect(firstMockArg(tuiRunMock)).toMatchObject({
      local: false,
      session: "global",
      agentId: "ops",
    });
  });

  it("leaves tui agent inference unchanged without a URL agent", async () => {
    await runProgram(["tui"]);

    expect(firstMockArg(tuiRunMock)).not.toHaveProperty("agentId");
  });

  it("rejects a URL target combined with --url", async () => {
    await expect(
      runProgram([
        "tui",
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--url",
        "wss://other.example",
      ]),
    ).rejects.toThrow("exit");

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("pass one target"));
    expect(tuiRunMock).not.toHaveBeenCalled();
  });

  it("runs setup one-shot requests", async () => {
    await runProgram(["setup", "--message", "status"]);
    const options = firstMockArg(systemAgentRunMock) as {
      message?: string;
      yes?: boolean;
      json?: boolean;
    };
    expect(options?.message).toBe("status");
    expect(options?.yes).toBe(false);
    expect(options?.json).toBe(false);
    expect(systemAgentRunMock).toHaveBeenCalledWith(options, runtime);
  });

  it("warns and ignores invalid tui timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "nope"]);
    expect(runtime.error).toHaveBeenCalledWith('warning: invalid --timeout-ms "nope"; ignoring');
    const options = firstMockArg(tuiRunMock) as { timeoutMs?: number };
    expect(options?.timeoutMs).toBeUndefined();
  });

  it("rejects partial tui history limits", async () => {
    await expect(runProgram(["tui", "--history-limit", "10x"])).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith("--history-limit must be a positive integer.");
    expect(tuiRunMock).not.toHaveBeenCalled();
  });

  it("accepts the maximum Gateway tui history limit", async () => {
    await runProgram(["tui", "--history-limit", "1000"]);

    expect(firstMockArg(tuiRunMock)).toMatchObject({ local: false, historyLimit: 1000 });
  });

  it.each([
    { entryPoint: "tui --local", args: ["tui", "--local"] },
    { entryPoint: "terminal", args: ["terminal"] },
    { entryPoint: "chat", args: ["chat"] },
  ])("preserves oversized history limits for local $entryPoint", async ({ args }) => {
    await runProgram([...args, "--history-limit", "1001"]);

    expect(firstMockArg(tuiRunMock)).toMatchObject({ local: true, historyLimit: 1001 });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("rejects tui history limits above the Gateway maximum", async () => {
    await expect(runProgram(["tui", "--history-limit", "1001"])).rejects.toThrow("exit");

    expect(runtime.error).toHaveBeenCalledWith("--history-limit must be at most 1000.");
    expect(tuiRunMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard when wizard flags are present", async () => {
    await runProgram(["setup", "--remote-url", "ws://example"]);

    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledTimes(1);
  });
});
