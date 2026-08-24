import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");

function createMutationProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronAddCommand(program);
  registerCronEditCommand(program);
  return program;
}

describe("shared automation mutation options", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("updates an existing automation to an exit-triggered schedule", async () => {
    await createMutationProgram().parseAsync(
      ["edit", "job-1", "--on-exit", "./watch.sh", "--on-exit-cwd", "/repo"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { schedule: { kind: "on-exit", command: "./watch.sh", cwd: "/repo" } },
    });
  });

  it.each([
    [["--on-exit-cwd", "/repo"], "--on-exit-cwd requires --on-exit"],
    [["--on-exit", "./watch.sh", "--every", "5m"], "Choose at most one schedule change"],
  ])("rejects invalid exit-triggered schedule options", async (args, message) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    try {
      await createMutationProgram().parseAsync(["edit", "job-1", ...args], { from: "user" });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("keeps creation defaults out of automation edit patches", () => {
    const program = createMutationProgram();
    const add = program.commands.find((command) => command.name() === "add")!;
    const edit = program.commands.find((command) => command.name() === "edit")!;
    const creationDefaults: Array<[string, string | boolean]> = [
      ["wake", "now"],
      ["tz", ""],
      ["exact", false],
      ["lightContext", false],
      ["announce", false],
      ["channel", "last"],
      ["bestEffortDeliver", false],
    ];

    for (const [name, value] of creationDefaults) {
      expect(add.getOptionValue(name)).toBe(value);
      expect(edit.getOptionValue(name)).toBeUndefined();
    }
  });
});
