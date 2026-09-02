import { CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerLazyCommand } from "./register-lazy-command.js";

describe("lazy command help", () => {
  it.each(["--help", "-h"])("loads nested leaf options without executing for %s", async (flag) => {
    const action = vi.fn();
    let stdout = "";
    const program = new OpenClawCommand().name("openclaw").exitOverride();
    program.configureOutput({
      writeOut: (text) => {
        stdout += text;
      },
    });
    const parent = program.command("browser");
    registerLazyCommand({
      program: parent,
      name: "inspect",
      description: "Lazy placeholder",
      register: () => {
        parent
          .command("inspect")
          .description("Inspect the selected target")
          .argument("<target>")
          .option("--details", "Include target details")
          .action(action);
      },
    });

    const error = await program
      .parseAsync(["browser", "inspect", flag], { from: "user" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CommanderError);
    expect(error).toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
    expect(stdout).toContain("Inspect the selected target");
    expect(stdout).toContain("<target>");
    expect(stdout).toContain("--details");
    expect(stdout).not.toContain("Lazy placeholder");
    expect(action).not.toHaveBeenCalled();
  });
});
