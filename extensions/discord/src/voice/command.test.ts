import type { CommandInteraction, CommandWithSubcommands } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";
import { createDiscordVoiceCommand } from "./command.js";
import type { DiscordVoiceManager } from "./manager.js";

function findVoiceSubcommand(command: CommandWithSubcommands, name: string) {
  const subcommands = (
    command as unknown as { subcommands?: Array<{ name: string; run: unknown }> }
  ).subcommands;
  const subcommand = subcommands?.find((entry) => entry.name === name) as
    | { run: (interaction: CommandInteraction) => Promise<void> }
    | undefined;
  if (!subcommand) {
    throw new Error(`Missing vc ${name} subcommand`);
  }
  return subcommand;
}

function createVoiceCommandHarness(manager: DiscordVoiceManager | null = null) {
  const command = createDiscordVoiceCommand({
    cfg: {},
    discordConfig: {},
    accountId: "default",
    groupPolicy: "open",
    useAccessGroups: false,
    getManager: () => manager,
    ephemeralDefault: true,
  });
  return {
    command,
    leave: findVoiceSubcommand(command, "leave"),
    status: findVoiceSubcommand(command, "status"),
  };
}

function createInteraction(overrides?: Partial<CommandInteraction>): {
  interaction: CommandInteraction;
  reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  const interaction = {
    guild: undefined,
    user: { id: "u1", username: "tester" },
    rawData: { member: { roles: [] } },
    reply,
    ...overrides,
  } as unknown as CommandInteraction;
  return { interaction, reply };
}

describe("createDiscordVoiceCommand", () => {
  it("vc leave reports missing guild before manager lookup", async () => {
    const { leave } = createVoiceCommandHarness(null);
    const { interaction, reply } = createInteraction();

    await leave.run(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "Unable to resolve guild for this command.",
      ephemeral: true,
    });
  });

  it("vc status reports unavailable voice manager", async () => {
    const { status } = createVoiceCommandHarness(null);
    const { interaction, reply } = createInteraction({
      guild: { id: "g1" } as CommandInteraction["guild"],
    });

    await status.run(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "Voice manager is not available yet.",
      ephemeral: true,
    });
  });

  it("vc status reports no active sessions when manager has none", async () => {
    const statusSpy = vi.fn(() => []);
    const manager = {
      status: statusSpy,
    } as unknown as DiscordVoiceManager;
    const { status } = createVoiceCommandHarness(manager);
    const { interaction, reply } = createInteraction({
      guild: { id: "g1", name: "Guild" } as CommandInteraction["guild"],
    });

    await status.run(interaction);

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "No active voice sessions.",
      ephemeral: true,
    });
  });
});
