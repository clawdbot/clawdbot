import { describe, expect, it, vi } from "vitest";
import type { CommandInteraction, CommandWithSubcommands } from "../internal/discord.js";
import { createPartialDiscordChannelWithThrowingGetters } from "../test-support/partial-channel.js";
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
  defer: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  const defer = vi.fn(async () => undefined);
  const interaction = {
    guild: undefined,
    user: { id: "u1", username: "tester" },
    rawData: { member: { roles: [] } },
    defer,
    reply,
    ...overrides,
  } as unknown as CommandInteraction;
  return { interaction, reply, defer };
}

describe("createDiscordVoiceCommand", () => {
  it("serializes subcommands without top-level command-only fields", () => {
    const { command } = createVoiceCommandHarness(null);
    const serialized = command.serialize();
    const firstOption = serialized.options?.[0] as Record<string, unknown> | undefined;

    expect(firstOption).toMatchObject({
      name: "join",
      type: 1,
      description: expect.any(String),
    });
    expect(firstOption).not.toHaveProperty("contexts");
    expect(firstOption).not.toHaveProperty("integration_types");
    expect(firstOption).not.toHaveProperty("default_member_permissions");
  });

  it("dispatches slash-command subcommand interactions", async () => {
    const { command } = createVoiceCommandHarness(null);
    const { interaction, reply, defer } = createInteraction({
      guild: { id: "g1", name: "Guild" } as CommandInteraction["guild"],
      rawData: {
        data: {
          options: [{ name: "status", type: 1 }],
        },
        member: { roles: [] },
      } as unknown as CommandInteraction["rawData"],
    });

    await command.run(interaction);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({
      content: "Voice manager is not available yet.",
      ephemeral: true,
    });
  });

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

  it("vc status tolerates partial thread channels with throwing getters", async () => {
    const statusSpy = vi.fn(() => []);
    const manager = {
      status: statusSpy,
    } as unknown as DiscordVoiceManager;
    const { status } = createVoiceCommandHarness(manager);
    const partialChannel = createPartialDiscordChannelWithThrowingGetters(
      { id: "123456789012345678" },
      ["name", "parentId"],
    );
    const { interaction, reply } = createInteraction({
      channel: partialChannel as CommandInteraction["channel"],
      client: { fetchChannel: vi.fn(async () => null) } as unknown as CommandInteraction["client"],
      guild: { id: "g1", name: "Guild" } as CommandInteraction["guild"],
    });

    await expect(status.run(interaction)).resolves.toBeUndefined();

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "No active voice sessions.",
      ephemeral: true,
    });
  });
});
