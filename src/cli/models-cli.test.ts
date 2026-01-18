import { describe, expect, it, vi } from "vitest";

const githubCopilotLoginCommand = vi.fn();

vi.mock("../commands/models.js", async () => {
  const actual = (await vi.importActual<typeof import("../commands/models.js")>(
    "../commands/models.js",
  )) as typeof import("../commands/models.js");

  return {
    ...actual,
    githubCopilotLoginCommand,
  };
});

describe("models cli", () => {
  it("registers github-copilot login command", { timeout: 60_000 }, async () => {
    const { Command } = await import("commander");
    const { registerModelsCli } = await import("./models-cli.js");

    const program = new Command();
    registerModelsCli(program);

    const models = program.commands.find((cmd) => cmd.name() === "models");
    expect(models).toBeTruthy();

    const auth = models?.commands.find((cmd) => cmd.name() === "auth");
    expect(auth).toBeTruthy();

    const login = auth?.commands.find((cmd) => cmd.name() === "login-github-copilot");
    expect(login).toBeTruthy();

    await program.parseAsync(["models", "auth", "login-github-copilot", "--yes"], {
      from: "user",
    });

    expect(githubCopilotLoginCommand).toHaveBeenCalledTimes(1);
    expect(githubCopilotLoginCommand).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true }),
      expect.any(Object),
    );
  });
});
