// Covers option wiring on the message read command.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageReadEditDeleteCommands } from "./register.read-edit-delete.js";

function createHelpers(runMessageAction: MessageCliHelpers["runMessageAction"]): MessageCliHelpers {
  return {
    withMessageBase: (command) => command.option("--channel <channel>", "Channel"),
    withMessageTarget: (command) => command.option("-t, --target <dest>", "Target"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <dest>", "Target"),
    runMessageAction,
  };
}

function createMessageProgram() {
  const runMessageAction = vi.fn(
    async (_action: string, _opts: Record<string, unknown>) => undefined,
  );
  const message = new Command().exitOverride();
  message.configureOutput({ writeErr: () => {} });
  registerMessageReadEditDeleteCommands(message, createHelpers(runMessageAction));
  return { message, runMessageAction };
}

describe("registerMessageReadEditDeleteCommands", () => {
  it("accepts the read options that reach a channel handler", async () => {
    const { message, runMessageAction } = createMessageProgram();

    await message.parseAsync(["read", "-t", "discord:123", "--around", "42"], { from: "user" });

    expect(runMessageAction).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({ around: "42" }),
    );
  });

  it("rejects --include-thread, which no channel reads", async () => {
    const { message, runMessageAction } = createMessageProgram();

    await expect(
      message.parseAsync(["read", "-t", "discord:123", "--include-thread"], { from: "user" }),
    ).rejects.toThrow(/unknown option/i);
    expect(runMessageAction).not.toHaveBeenCalled();
  });
});
