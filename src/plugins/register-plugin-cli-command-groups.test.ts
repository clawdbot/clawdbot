import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { isCommandJsonOutputMode } from "../cli/program/json-mode.js";
import type { OpenClawPluginCliRegistrationOptions } from "./plugin-registration.types.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";

const descriptor = {
  name: "machine",
  description: "Machine output",
  hasSubcommands: true,
  machineOutput: ({ argv }: { argv: readonly string[] }) => argv.includes("--machine"),
};

function requireCommand(program: Command): Command {
  const command = program.commands.find((candidate) => candidate.name() === descriptor.name);
  if (!command) {
    throw new Error("expected machine command");
  }
  return command;
}

describe("plugin CLI machine-output metadata", () => {
  it("keeps dynamically built legacy parent paths assignable", () => {
    const parentPath: string[] = ["nodes"];
    const options: OpenClawPluginCliRegistrationOptions = {
      parentPath,
      descriptors: [{ name: "camera", description: "Camera", hasSubcommands: true }],
    };

    expect(options.parentPath).toBe(parentPath);
  });

  it.each([
    { mode: "eager" as const, primary: undefined },
    { mode: "lazy" as const, primary: "machine" },
    { mode: "lazy" as const, primary: undefined },
  ])("applies metadata in $mode registration", async ({ mode, primary }) => {
    const program = new Command();
    const register = vi.fn((target: Command) => {
      target.command("machine").action(() => {});
    });

    await registerPluginCliCommandGroups(
      program,
      [{ pluginId: "fixture", placeholders: [descriptor], names: ["machine"], register }],
      {
        mode,
        primary,
        existingCommands: new Set(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    );

    expect(
      isCommandJsonOutputMode(requireCommand(program), [
        "node",
        "openclaw",
        "machine",
        "--machine",
      ]),
    ).toBe(true);
  });
});
