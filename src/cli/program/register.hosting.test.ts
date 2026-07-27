import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHostingCommands } from "./register.hosting.js";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  inspect: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../commands/hosting-profiles.js", () => ({
  hostingProfilesListCommand: mocks.list,
  hostingProfilesInspectCommand: mocks.inspect,
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

describe("registerHostingCommands", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerHostingCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the hosting profile catalog hierarchy", () => {
    const program = new Command();
    registerHostingCommands(program);

    const hosting = program.commands.find((command) => command.name() === "hosting");
    const profiles = hosting?.commands.find((command) => command.name() === "profiles");
    expect(profiles?.commands.map((command) => command.name())).toEqual(["list", "inspect"]);
  });

  it("forwards list JSON output", async () => {
    await runCli(["hosting", "profiles", "list", "--json"]);

    expect(mocks.list).toHaveBeenCalledWith({ json: true }, mocks.runtime);
  });

  it("forwards inspect identity and JSON output", async () => {
    await runCli(["hosting", "profiles", "inspect", "reverse-proxy", "--json"]);

    expect(mocks.inspect).toHaveBeenCalledWith("reverse-proxy", { json: true }, mocks.runtime);
  });
});
