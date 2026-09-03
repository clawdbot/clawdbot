import { Command } from "commander";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  itWithFish,
  itWithPowerShell,
  PowerShellCompletionRunner,
  runGeneratedBashCompletion,
  runGeneratedFishCompletion,
} from "../../completion-cli.test-support.js";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageReadEditDeleteCommands } from "./register.read-edit-delete.js";

const powerShellCompletion = new PowerShellCompletionRunner();
afterAll(async () => {
  await powerShellCompletion.close();
});

function createReadProgram() {
  const program = new Command().name("openclaw").exitOverride();
  program.configureOutput({ writeErr: () => {} });
  const message = program.command("message");
  const runMessageAction = vi.fn(async () => undefined);
  const helpers: MessageCliHelpers = {
    withMessageBase: (command) => command.option("--channel <channel>"),
    withMessageTarget: (command) => command.option("-t, --target <target>"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <target>"),
    runMessageAction,
  };
  registerMessageReadEditDeleteCommands(message, helpers);
  return { program, message, runMessageAction };
}

describe("message read legacy option visibility", () => {
  it("keeps the shipped spelling accepted while forwarding supported read options", async () => {
    const { program, runMessageAction } = createReadProgram();
    await program.parseAsync(
      ["message", "read", "--target", "channel:123", "--include-thread", "--around", "42"],
      { from: "user" },
    );
    expect(runMessageAction).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({
        target: "channel:123",
        around: "42",
        includeThread: true,
      }),
    );
  });

  it("rejects an unknown option at the same parser boundary", async () => {
    const { program, runMessageAction } = createReadProgram();
    await expect(
      program.parseAsync(["message", "read", "--target", "channel:123", "--unknown-read-option"], {
        from: "user",
      }),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
    expect(runMessageAction).not.toHaveBeenCalled();
  });

  it("shows supported read flags while omitting the inert spelling", () => {
    const { message } = createReadProgram();
    const read = message.commands.find((command) => command.name() === "read");
    expect(read).toBeDefined();
    const help = read!.helpInformation();
    expect(help).toContain("--around <id>");
    expect(help).toContain("--thread-id <id>");
    expect(help).not.toContain("--include-thread");
  });

  const engines = [
    {
      name: "Bash",
      test: it.skipIf(process.platform === "win32"),
      complete: (program: Command) =>
        runGeneratedBashCompletion(program, ["openclaw", "message", "read", "--"]),
    },
    {
      name: "Fish",
      test: itWithFish,
      complete: (program: Command) =>
        runGeneratedFishCompletion(program, "openclaw message read --"),
    },
    {
      name: "PowerShell",
      test: itWithPowerShell,
      complete: (program: Command) =>
        powerShellCompletion.complete(program, "openclaw message read --"),
    },
  ];
  for (const engine of engines) {
    engine.test(`hides the inert spelling from real ${engine.name} completions`, async () => {
      const completions = await engine.complete(createReadProgram().program);
      expect(completions).toContain("--around");
      expect(completions).toContain("--thread-id");
      expect(completions).not.toContain("--include-thread");
    });
  }
});
