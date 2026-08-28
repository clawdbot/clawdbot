// Update CLI option collision tests cover update command flag registration boundaries.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerUpdateCli } from "./update-cli.js";

const mocks = vi.hoisted(() => ({
  updateCommand: vi.fn(async (_opts: unknown) => {}),
  updateFinalizeCommand: vi.fn(async (_opts: unknown) => {}),
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

const {
  updateCommand,
  updateFinalizeCommand,
  updateStatusCommand,
  updateWizardCommand,
  defaultRuntime,
} = mocks;

vi.mock("./update-cli/update-command.js", () => ({
  updateCommand: (opts: unknown) => mocks.updateCommand(opts),
  updateFinalizeCommand: (opts: unknown) => mocks.updateFinalizeCommand(opts),
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

function firstCallOptions(mock: { mock: { calls: unknown[][] } }) {
  return mock.mock.calls[0]?.[0];
}

type UpdateFinalizeCommandOptions = {
  channel?: string;
  json?: boolean;
  timeout?: string;
  restart?: boolean;
  yes?: boolean;
};

describe("update cli option collisions", () => {
  beforeEach(() => {
    updateCommand.mockClear();
    updateFinalizeCommand.mockClear();
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
        const opts = firstCallOptions(updateStatusCommand);
        expect((opts as { json?: boolean; timeout?: string } | undefined)?.json).toBe(true);
        expect((opts as { json?: boolean; timeout?: string } | undefined)?.timeout).toBe("9");
      },
    },
    {
      name: "forwards parent-captured options to hidden `update finalize`",
      argv: ["update", "finalize", "--json", "--timeout", "17", "--no-restart"],
      assert: () => {
        expect(updateFinalizeCommand).toHaveBeenCalledTimes(1);
        const opts = firstCallOptions(updateFinalizeCommand) as
          | UpdateFinalizeCommandOptions
          | undefined;
        expect(opts?.json).toBe(true);
        expect(opts?.timeout).toBe("17");
        expect(opts?.restart).toBe(false);
      },
    },
    {
      name: "forwards parent-captured --json/--timeout to `update repair`",
      argv: ["update", "repair", "--json", "--timeout", "19"],
      assert: () => {
        expect(updateFinalizeCommand).toHaveBeenCalledTimes(1);
        const opts = firstCallOptions(updateFinalizeCommand);
        expect(
          (opts as { json?: boolean; timeout?: string; restart?: boolean } | undefined)?.json,
        ).toBe(true);
        expect(
          (opts as { json?: boolean; timeout?: string; restart?: boolean } | undefined)?.timeout,
        ).toBe("19");
        expect(
          (opts as { json?: boolean; timeout?: string; restart?: boolean } | undefined)?.restart,
        ).toBe(false);
      },
    },
    {
      name: "forwards repair channel and confirmation options",
      argv: ["update", "repair", "--channel", "beta", "--yes"],
      assert: () => {
        expect(updateFinalizeCommand).toHaveBeenCalledTimes(1);
        const opts = firstCallOptions(updateFinalizeCommand);
        expect((opts as { channel?: string; yes?: boolean } | undefined)?.channel).toBe("beta");
        expect((opts as { channel?: string; yes?: boolean } | undefined)?.yes).toBe(true);
      },
    },
    {
      name: "keeps hidden `update finalize --no-restart` as a no-op parity flag",
      argv: ["update", "finalize", "--no-restart"],
      assert: () => {
        expect(updateFinalizeCommand).toHaveBeenCalledTimes(1);
        const opts = firstCallOptions(updateFinalizeCommand);
        expect(
          (opts as { json?: boolean; timeout?: string; restart?: boolean } | undefined)?.restart,
        ).toBe(false);
      },
    },
    {
      name: "forwards parent-captured --timeout to `update wizard`",
      argv: ["update", "wizard", "--timeout", "13"],
      assert: () => {
        expect(updateWizardCommand).toHaveBeenCalledTimes(1);
        const opts = firstCallOptions(updateWizardCommand);
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

  it.each([
    { name: "repair", handler: updateFinalizeCommand },
    { name: "finalize", handler: updateFinalizeCommand },
    { name: "wizard", handler: updateWizardCommand },
  ])("rejects parent --dry-run before running update $name", async ({ name, handler }) => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv: ["update", "--dry-run", name],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(updateCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      `--dry-run is not supported for \`openclaw update ${name}\`. Run \`openclaw update --dry-run\` instead.`,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each(["repair", "finalize"])(
    "forwards parent channel and confirmation to update %s",
    async (name) => {
      await runRegisteredCli({
        register: registerUpdateCli as (program: Command) => void,
        argv: ["update", "--channel", "beta", "--yes", name],
      });

      expect(updateFinalizeCommand).toHaveBeenCalledOnce();
      expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
        channel: "beta",
        yes: true,
      });
    },
  );

  it.each(["repair", "finalize"])(
    "lets the explicit update %s channel override its parent",
    async (name) => {
      await runRegisteredCli({
        register: registerUpdateCli as (program: Command) => void,
        argv: ["update", "--channel", "beta", "--yes", name, "--channel", "dev"],
      });

      expect(updateFinalizeCommand).toHaveBeenCalledOnce();
      expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
        channel: "dev",
        yes: true,
      });
    },
  );

  it.each(["repair", "finalize"])(
    "preserves an explicitly empty parent channel for update %s validation",
    async (name) => {
      await runRegisteredCli({
        register: registerUpdateCli as (program: Command) => void,
        argv: ["update", "--channel", "", name],
      });

      expect(updateFinalizeCommand).toHaveBeenCalledOnce();
      expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({ channel: "" });
    },
  );

  it.each(["repair", "finalize"])(
    "lets an explicitly empty update %s channel override its parent",
    async (name) => {
      await runRegisteredCli({
        register: registerUpdateCli as (program: Command) => void,
        argv: ["update", "--channel", "beta", name, "--channel", ""],
      });

      expect(updateFinalizeCommand).toHaveBeenCalledOnce();
      expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({ channel: "" });
    },
  );

  it.each(["repair", "finalize"])(
    "forwards all explicitly inherited options to update %s",
    async (name) => {
      await runRegisteredCli({
        register: registerUpdateCli as (program: Command) => void,
        argv: ["update", "--json", "--timeout", "31", "--channel", "beta", "--yes", name],
      });

      expect(updateFinalizeCommand).toHaveBeenCalledOnce();
      expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
        channel: "beta",
        json: true,
        restart: false,
        timeout: "31",
        yes: true,
      } satisfies UpdateFinalizeCommandOptions);
    },
  );

  it.each([
    {
      name: "status",
      argv: ["update", "status", "--timeout", ""],
      handler: updateStatusCommand,
    },
    {
      name: "wizard",
      argv: ["update", "wizard", "--timeout", ""],
      handler: updateWizardCommand,
    },
    {
      name: "repair",
      argv: ["update", "repair", "--timeout", ""],
      handler: updateFinalizeCommand,
    },
    {
      name: "finalize",
      argv: ["update", "finalize", "--timeout", ""],
      handler: updateFinalizeCommand,
    },
    {
      name: "status with a valid inherited parent timeout",
      argv: ["update", "--timeout", "9", "status", "--timeout", ""],
      handler: updateStatusCommand,
    },
  ])("preserves an explicitly empty $name timeout for validation", async ({ argv, handler }) => {
    await runRegisteredCli({
      register: registerUpdateCli as (program: Command) => void,
      argv,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(firstCallOptions(handler)).toMatchObject({ timeout: "" });
  });
});
