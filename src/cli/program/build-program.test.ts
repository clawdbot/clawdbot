import process from "node:process";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./build-program.js";
import type { ProgramContext } from "./context.js";

const registerProgramCommandsMock = vi.hoisted(() => vi.fn());
const createProgramContextMock = vi.hoisted(() => vi.fn());
const configureProgramHelpMock = vi.hoisted(() => vi.fn());
const registerPreActionHooksMock = vi.hoisted(() => vi.fn());
const setProgramContextMock = vi.hoisted(() => vi.fn());

vi.mock("./command-registry.js", () => ({
  registerProgramCommands: registerProgramCommandsMock,
}));

vi.mock("./context.js", () => ({
  createProgramContext: createProgramContextMock,
}));

vi.mock("./help.js", () => ({
  configureProgramHelp: configureProgramHelpMock,
}));

vi.mock("./preaction.js", () => ({
  registerPreActionHooks: registerPreActionHooksMock,
}));

vi.mock("./program-context.js", () => ({
  setProgramContext: setProgramContextMock,
}));

describe("buildProgram", () => {
  function mockProcessOutput() {
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as unknown as typeof process.stdout.write,
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (() => true) as unknown as typeof process.stderr.write,
    );
  }

  async function expectCommanderExit(promise: Promise<unknown>, exitCode: number) {
    const error = await promise.catch((err) => err);

    expect(error).toBeInstanceOf(CommanderError);
    expect(error).toMatchObject({ exitCode });
    return error as CommanderError;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessOutput();
    createProgramContextMock.mockReturnValue({
      programVersion: "9.9.9-test",
      channelOptions: ["quietchat"],
      messageChannelOptions: "quietchat",
      agentChannelOptions: "last|quietchat",
    } satisfies ProgramContext);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("wires context/help/preaction/command registration with shared context", () => {
    const argv = ["node", "openclaw", "status"];
    const originalArgv = process.argv;
    process.argv = argv;
    try {
      const program = buildProgram();
      const ctx = createProgramContextMock.mock.results[0]?.value as ProgramContext;

      expect(program).toBeInstanceOf(Command);
      expect(setProgramContextMock).toHaveBeenCalledWith(program, ctx);
      expect(configureProgramHelpMock).toHaveBeenCalledWith(program, ctx);
      expect(registerPreActionHooksMock).toHaveBeenCalledWith(program, ctx.programVersion);
      expect(registerProgramCommandsMock).toHaveBeenCalledWith(program, ctx, argv);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("sets exitCode to 1 on argument errors (fixes #60905)", async () => {
    const program = buildProgram();
    program.command("test").description("Test command");

    const error = await expectCommanderExit(
      program.parseAsync(["test", "unexpected-arg"], { from: "user" }),
      1,
    );

    expect(error.code).toBe("commander.excessArguments");
    expect(process.exitCode).toBe(1);
  });

  it("does not run the command action after an argument error", async () => {
    const program = buildProgram();
    const actionSpy = vi.fn();
    program.command("test").action(actionSpy);

    await expectCommanderExit(program.parseAsync(["test", "unexpected-arg"], { from: "user" }), 1);

    expect(actionSpy).not.toHaveBeenCalled();
  });

  it("preserves exitCode 0 for help display", async () => {
    const program = buildProgram();
    program.command("test").description("Test command");

    const error = await expectCommanderExit(program.parseAsync(["--help"], { from: "user" }), 0);

    expect(error.code).toBe("commander.helpDisplayed");
    expect(process.exitCode).toBe(0);
  });

  it("preserves exitCode 0 for version display", async () => {
    const program = buildProgram();
    program.version("1.0.0");

    const error = await expectCommanderExit(program.parseAsync(["--version"], { from: "user" }), 0);

    expect(error.code).toBe("commander.version");
    expect(process.exitCode).toBe(0);
  });

  it("preserves non-zero exitCode for help error flows", async () => {
    const program = buildProgram();
    program.helpCommand("help [command]");

    const error = await expectCommanderExit(
      program.parseAsync(["help", "missing"], { from: "user" }),
      1,
    );

    expect(error.code).toBe("commander.help");
    expect(process.exitCode).toBe(1);
  });
});
