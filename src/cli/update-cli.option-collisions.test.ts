import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerUpdateCli } from "./update-cli.js";

const mocks = vi.hoisted(() => ({
  updateCommand: vi.fn(async (_opts: unknown) => {}),
  updateStatusCommand: vi.fn(async (_opts: unknown) => {}),
  updateWizardCommand: vi.fn(async (_opts: unknown) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const { updateCommand, updateStatusCommand, updateWizardCommand, defaultRuntime } = mocks;

vi.mock("./update-cli/update-command.js", () => ({
  updateCommand: (opts: unknown) => mocks.updateCommand(opts),
}));

vi.mock("./update-cli/status.js", () => ({
  updateStatusCommand: (opts: unknown) => mocks.updateStatusCommand(opts),
}));

vi.mock("./update-cli/wizard.js", () => ({
  updateWizardCommand: (opts: unknown) => mocks.updateWizardCommand(opts),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

describe("update cli option collisions", () => {
  beforeEach(() => {
    updateCommand.mockClear();
    updateStatusCommand.mockClear();
    updateWizardCommand.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it.each([
    {
      name: "forwards parent-captured --json/--timeout to `update status`",
      argv: ["update", "status", "--json", "--timeout", "9"],
      assert: () => {
        expect(updateStatusCommand).toHaveBeenCalledTimes(1);
        const [opts] = updateStatusCommand.mock.calls[0] ?? [];
        expect((opts as { json?: boolean; timeout?: string } | undefined)?.json).toBe(true);
        expect((opts as { json?: boolean; timeout?: string } | undefined)?.timeout).toBe("9");
      },
    },
    {
      name: "forwards parent-captured --timeout to `update wizard`",
      argv: ["update", "wizard", "--timeout", "13"],
      assert: () => {
        expect(updateWizardCommand).toHaveBeenCalledTimes(1);
        const [opts] = updateWizardCommand.mock.calls[0] ?? [];
        expect((opts as { timeout?: string } | undefined)?.timeout).toBe("13");
      },
    },
  ])("$name", async ({ argv, assert }) => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv,
    });

    assert();
  });
});
