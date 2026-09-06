// Discord-style admin command registration for roles, channels, members, events, and moderation.
import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

/** Register Discord admin and moderation message subcommands. */
export function registerMessageDiscordAdminCommands(message: Command, helpers: MessageCliHelpers) {
  const role = message.command("role").description("Role actions");
  helpers
    .withMessageBase(
      role.command("info").description("List roles").requiredOption("--guild-id <id>", "Guild id"),
    )
    .action((opts) => helpers.runMessageAction("role-info", opts));

  helpers
    .withMessageBase(
      role
        .command("add")
        .description("Add role to a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id")
        .requiredOption("--role-id <id>", "Role id"),
    )
    .action((opts) => helpers.runMessageAction("role-add", opts));

  helpers
    .withMessageBase(
      role
        .command("remove")
        .description("Remove role from a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id")
        .requiredOption("--role-id <id>", "Role id"),
    )
    .action((opts) => helpers.runMessageAction("role-remove", opts));

  const channel = message.command("channel").description("Channel actions");
  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(channel.command("info").description("Fetch channel info")),
    )
    .action((opts) => helpers.runMessageAction("channel-info", opts));

  helpers
    .withMessageBase(
      channel
        .command("list")
        .description("List channels")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .action((opts) => helpers.runMessageAction("channel-list", opts));

  const member = message.command("member").description("Member actions");
  helpers
    .withMessageBase(
      member
        .command("info")
        .description("Fetch member info")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--guild-id <id>", "Guild id (Discord)")
    .action((opts) => helpers.runMessageAction("member-info", opts));

  const voice = message.command("voice").description("Voice actions");
  helpers
    .withMessageBase(
      voice
        .command("status")
        .description("Fetch voice status")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .action((opts) => helpers.runMessageAction("voice-status", opts));

  const event = message.command("event").description("Event actions");
  helpers
    .withMessageBase(
      event
        .command("list")
        .description("List scheduled events")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .action((opts) => helpers.runMessageAction("event-list", opts));

  helpers
    .withMessageBase(
      event
        .command("create")
        .description("Create a scheduled event")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--event-name <name>", "Event name")
        .requiredOption("--start-time <iso>", "Event start time"),
    )
    .option("--end-time <iso>", "Event end time")
    .option("--desc <text>", "Event description")
    .option("--channel-id <id>", "Channel id")
    .option("--location <text>", "Event location")
    .option("--event-type <stage|external|voice>", "Event type")
    .option("--image <url>", "Cover image URL or local file path")
    .action((opts) => helpers.runMessageAction("event-create", opts));

  helpers
    .withMessageBase(
      message
        .command("timeout")
        .description("Timeout a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--duration-min <n>", "Timeout duration minutes")
    .option("--until <iso>", "Timeout until")
    .option("--reason <text>", "Moderation reason")
    .action((opts) => helpers.runMessageAction("timeout", opts));

  helpers
    .withMessageBase(
      message
        .command("kick")
        .description("Kick a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--reason <text>", "Moderation reason")
    .action((opts) => helpers.runMessageAction("kick", opts));

  helpers
    .withMessageBase(
      message
        .command("ban")
        .description("Ban a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--reason <text>", "Moderation reason")
    .option("--delete-days <n>", "Ban delete message days")
    .action((opts) => helpers.runMessageAction("ban", opts));
}
