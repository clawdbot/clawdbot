// Program smoke tests cover core CLI command registration and startup behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./program.js";
import {
  configureCommand,
  ensureConfigReady,
  runSystemAgentWithInference,
  runTui,
  runtime,
  setupCommand,
  setupWizardCommand,
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
    runTui.mockResolvedValue(undefined);
    runSystemAgentWithInference.mockResolvedValue(undefined);
    ensureConfigReady.mockResolvedValue(undefined);
  });

  it("registers message + status commands", () => {
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("message");
    expect(names).toContain("status");
  });

  it("runs tui with explicit timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "45000"]);
    const options = firstMockArg(runTui) as {
      timeoutMs?: number;
      forceProcessExitOnReturn?: boolean;
    };
    expect(options?.timeoutMs).toBe(45000);
    expect(options?.forceProcessExitOnReturn).toBe(true);
  });

  it("runs setup one-shot requests", async () => {
    await runProgram(["setup", "--message", "status"]);
    const options = firstMockArg(runSystemAgentWithInference) as {
      message?: string;
      yes?: boolean;
      json?: boolean;
    };
    expect(options?.message).toBe("status");
    expect(options?.yes).toBe(false);
    expect(options?.json).toBe(false);
    expect(runSystemAgentWithInference).toHaveBeenCalledWith(options, runtime);
  });

  it("warns and ignores invalid tui timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "nope"]);
    expect(runtime.error).toHaveBeenCalledWith('warning: invalid --timeout-ms "nope"; ignoring');
    const options = firstMockArg(runTui) as { timeoutMs?: number };
    expect(options?.timeoutMs).toBeUndefined();
  });

  it("rejects partial tui history limits", async () => {
    await expect(runProgram(["tui", "--history-limit", "10x"])).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(
      "Error: --history-limit must be a positive integer.",
    );
    expect(runTui).not.toHaveBeenCalled();
  });

  it("runs setup wizard when wizard flags are present", async () => {
    await runProgram(["setup", "--remote-url", "ws://example"]);

    expect(setupCommand).not.toHaveBeenCalled();
    expect(setupWizardCommand).toHaveBeenCalledTimes(1);
  });
});
