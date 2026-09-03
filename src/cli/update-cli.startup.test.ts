import { Command } from "commander";
import { expect, it, vi } from "vitest";

const unavailableRuntime = vi.hoisted(() => () => {
  throw new Error("Update execution dependencies are unavailable");
});

vi.mock("./update-cli/update-command.js", unavailableRuntime);
vi.mock("./update-cli/update-command-finalize.js", unavailableRuntime);
vi.mock("./update-cli/status.js", unavailableRuntime);
vi.mock("./update-cli/wizard.js", unavailableRuntime);

it("keeps update help available without loading execution dependencies", async () => {
  const { registerUpdateCli } = await import("./update-cli.js");
  for (const leaf of [undefined, "status", "repair", "finalize", "wizard"]) {
    let output = "";
    const program = new Command()
      .name("openclaw")
      .exitOverride()
      .configureOutput({ writeOut: (text) => (output += text) });
    registerUpdateCli(program);
    const args = ["update", ...(leaf ? [leaf] : []), "--help"];
    await expect(program.parseAsync(args, { from: "user" })).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0,
    });
    expect(output).toContain(`Usage: openclaw update${leaf ? ` ${leaf}` : ""} [options]`);
  }
});
