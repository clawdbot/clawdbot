// Proves the shipped Commander topology reaches each state-mutating channel owner.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { registerChannelsCli } from "./channels-cli.js";

const requireValidConfigForWrite = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../commands/config-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/config-validation.js")>()),
  requireValidConfigForWrite,
}));

async function runChannelMutation(verb: string, account?: string) {
  const args = ["channels", verb, "--channel", "telegram"];
  if (account !== undefined) {
    args.push("--account", account);
  }
  if (verb === "remove") {
    args.push("--delete");
  }
  const program = new Command()
    .name("openclaw")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
}

describe.each(["add", "remove", "login", "logout"])("channels %s account selection", (verb) => {
  beforeEach(() => {
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    requireValidConfigForWrite.mockClear();
  });

  it.each(["", "   "])("rejects an explicit blank before loading config", async (account) => {
    await runChannelMutation(verb, account);

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("--account must not be blank"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(requireValidConfigForWrite).not.toHaveBeenCalled();
  });

  it("keeps an omitted account on the default-selection path", async () => {
    await runChannelMutation(verb);

    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(requireValidConfigForWrite).toHaveBeenCalledTimes(1);
  });
});
