import {
  Button,
  ChannelType,
  Command,
  Row,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  type CommandOptions,
  type ComponentData,
} from "@buape/carbon";
import { ApplicationCommandOptionType, ButtonStyle } from "discord-api-types/v10";

import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  serializeCommandArgs,
} from "../../auto-reply/commands-registry.js";
import type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
  NativeCommandSpec,
} from "../../auto-reply/commands-registry.js";
import { dispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ClawdbotConfig, loadConfig } from "../../config/config.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { loadWebMedia } from "../../web/media.js";
import { chunkDiscordText } from "../chunk.js";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfig,
  resolveDiscordGuildEntry,
  resolveDiscordUserAllowed,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";

type DiscordConfig = NonNullable<ClawdbotConfig["channels"]>["discord"];

function buildDiscordCommandOptions(params: {
  command: ChatCommandDefinition;
  cfg: ReturnType<typeof loadConfig>;
}): CommandOptions | undefined {
  const { command, cfg } = params;
  const args = command.args;
  if (!args || args.length === 0) return undefined;
  return args.map((arg) => {
    const required = arg.required ?? false;
    if (arg.type === "number") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Number,
        required,
      };
    }
    if (arg.type === "boolean") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Boolean,
        required,
      };
    }
    const resolvedChoices = resolveCommandArgChoices({ command, arg, cfg });
    const shouldAutocomplete =
      resolvedChoices.length > 0 &&
      (typeof arg.choices === "function" || resolvedChoices.length > 25);
    const autocomplete = shouldAutocomplete
      ? async (interaction: AutocompleteInteraction) => {
          const focused = interaction.options.getFocused();
          const focusValue =
            typeof focused?.value === "string" ? focused.value.trim().toLowerCase() : "";
          const choices = resolveCommandArgChoices({ command, arg, cfg });
          const filtered = focusValue
            ? choices.filter((choice) => choice.toLowerCase().includes(focusValue))
            : choices;
          await interaction.respond(
            filtered.slice(0, 25).map((choice) => ({ name: choice, value: choice })),
          );
        }
      : undefined;
    const choices =
      resolvedChoices.length > 0 && !autocomplete
        ? resolvedChoices.slice(0, 25).map((choice) => ({ name: choice, value: choice }))
        : undefined;
    return {
      name: arg.name,
      description: arg.description,
      type: ApplicationCommandOptionType.String,
      required,
      choices,
      autocomplete,
    };
  }) satisfies CommandOptions;
}

function readDiscordCommandArgs(
  interaction: CommandInteraction,
  definitions?: CommandArgDefinition[],
): CommandArgs | undefined {
  if (!definitions || definitions.length === 0) return undefined;
  const values: CommandArgValues = {};
  for (const definition of definitions) {
    let value: unknown;
    if (definition.type === "number") {
      value = interaction.options.getNumber(definition.name);
    } else if (definition.type === "boolean") {
      value = interaction.options.getBoolean(definition.name);
    } else {
      value = interaction.options.getString(definition.name);
    }
    if (value != null) {
      values[definition.name] = value;
    }
  }
  return Object.keys(values).length > 0 ? { values } : undefined;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";

function createCommandArgsWithValue(params: { argName: string; value: string }): CommandArgs {
  const values: CommandArgValues = { [params.argName]: params.value };
  return { values };
}

function encodeDiscordCommandArgValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeDiscordCommandArgValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildDiscordCommandArgCustomId(params: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}): string {
  return [
    `${DISCORD_COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeDiscordCommandArgValue(params.command)}`,
    `arg=${encodeDiscordCommandArgValue(params.arg)}`,
    `value=${encodeDiscordCommandArgValue(params.value)}`,
    `user=${encodeDiscordCommandArgValue(params.userId)}`,
  ].join(";");
}

function parseDiscordCommandArgData(
  data: ComponentData,
): { command: string; arg: string; value: string; userId: string } | null {
  if (!data || typeof data !== "object") return null;
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawCommand = coerce(data.command);
  const rawArg = coerce(data.arg);
  const rawValue = coerce(data.value);
  const rawUser = coerce(data.user);
  if (!rawCommand || !rawArg || !rawValue || !rawUser) return null;
  return {
    command: decodeDiscordCommandArgValue(rawCommand),
    arg: decodeDiscordCommandArgValue(rawArg),
    value: decodeDiscordCommandArgValue(rawValue),
    userId: decodeDiscordCommandArgValue(rawUser),
  };
}

class DiscordCommandArgButton extends Button {
  label: string;
  customId: string;
  style = ButtonStyle.Secondary;
  private cfg: ReturnType<typeof loadConfig>;
  private discordConfig: DiscordConfig;
  private accountId: string;
  private sessionPrefix: string;

  constructor(params: {
    label: string;
    customId: string;
    cfg: ReturnType<typeof loadConfig>;
    discordConfig: DiscordConfig;
    accountId: string;
    sessionPrefix: string;
  }) {
    super();
    this.label = params.label;
    this.customId = params.customId;
    this.cfg = params.cfg;
    this.discordConfig = params.discordConfig;
    this.accountId = params.accountId;
    this.sessionPrefix = params.sessionPrefix;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    const parsed = parseDiscordCommandArgData(data);
    if (!parsed) {
      await interaction.update({
        content: "Sorry, that selection is no longer available.",
        components: [],
      });
      return;
    }
    if (interaction.user?.id && interaction.user.id !== parsed.userId) {
      await interaction.acknowledge();
      return;
    }
    const commandDefinition =
      findCommandByNativeName(parsed.command) ??
      listChatCommands().find((entry) => entry.key === parsed.command);
    if (!commandDefinition) {
      await interaction.update({
        content: "Sorry, that command is no longer available.",
        components: [],
      });
      return;
    }
    await interaction.update({
      content: `✅ Selected ${parsed.value}.`,
      components: [],
    });
    const commandArgs = createCommandArgsWithValue({
      argName: parsed.arg,
      value: parsed.value,
    });
    const commandArgsWithRaw: CommandArgs = {
      ...commandArgs,
      raw: serializeCommandArgs(commandDefinition, commandArgs),
    };
    const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
    await dispatchDiscordCommandInteraction({
      interaction,
      prompt,
      command: commandDefinition,
      commandArgs: commandArgsWithRaw,
      cfg: this.cfg,
      discordConfig: this.discordConfig,
      accountId: this.accountId,
      sessionPrefix: this.sessionPrefix,
      preferFollowUp: true,
    });
  }
}

function buildDiscordCommandArgMenu(params: {
  command: ChatCommandDefinition;
  menu: { arg: CommandArgDefinition; choices: string[]; title?: string };
  interaction: CommandInteraction;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
}): { content: string; components: Row<Button>[] } {
  const { command, menu, interaction } = params;
  const commandLabel = command.nativeName ?? command.key;
  const userId = interaction.user?.id ?? "";
  const rows = chunkItems(menu.choices, 4).map((choices) => {
    const buttons = choices.map(
      (choice) =>
        new DiscordCommandArgButton({
          label: choice,
          customId: buildDiscordCommandArgCustomId({
            command: commandLabel,
            arg: menu.arg.name,
            value: choice,
            userId,
          }),
          cfg: params.cfg,
          discordConfig: params.discordConfig,
          accountId: params.accountId,
          sessionPrefix: params.sessionPrefix,
        }),
    );
    return new Row(buttons);
  });
  const content =
    menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
  return { content, components: rows };
}

export function createDiscordNativeCommand(params: {
  command: NativeCommandSpec;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
}) {
  const { command, cfg, discordConfig, accountId, sessionPrefix, ephemeralDefault } = params;
  const commandDefinition =
    findCommandByNativeName(command.name) ??
    ({
      key: command.name,
      nativeName: command.name,
      description: command.description,
      textAliases: [],
      acceptsArgs: command.acceptsArgs,
      args: command.args,
      argsParsing: "none",
      scope: "native",
    } satisfies ChatCommandDefinition);
  const argDefinitions = commandDefinition.args ?? command.args;
  const commandOptions = buildDiscordCommandOptions({
    command: commandDefinition,
    cfg,
  });
  const options = commandOptions
    ? (commandOptions satisfies CommandOptions)
    : command.acceptsArgs
      ? ([
          {
            name: "input",
            description: "Command input",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ] satisfies CommandOptions)
      : undefined;
  return new (class extends Command {
    name = command.name;
    description = command.description;
    defer = true;
    ephemeral = ephemeralDefault;
    options = options;

    async run(interaction: CommandInteraction) {
      const commandArgs = argDefinitions?.length
        ? readDiscordCommandArgs(interaction, argDefinitions)
        : command.acceptsArgs
          ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "")
          : undefined;
      const commandArgsWithRaw = commandArgs
        ? ({
            ...commandArgs,
            raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw,
          } satisfies CommandArgs)
        : undefined;
      const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
      await dispatchDiscordCommandInteraction({
        interaction,
        prompt,
        command: commandDefinition,
        commandArgs: commandArgsWithRaw,
        cfg,
        discordConfig,
        accountId,
        sessionPrefix,
        preferFollowUp: false,
      });
    }
  })();
}

async function dispatchDiscordCommandInteraction(params: {
  interaction: CommandInteraction | ButtonInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
}) {
  const {
    interaction,
    prompt,
    command,
    commandArgs,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    preferFollowUp,
  } = params;
  const respond = async (content: string, options?: { ephemeral?: boolean }) => {
    const payload = {
      content,
      ...(options?.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
    };
    if (preferFollowUp) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  };

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const user = interaction.user;
  if (!user) return;
  const channel = interaction.channel;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const channelName = channel && "name" in channel ? (channel.name as string) : undefined;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildEntries: discordConfig?.guilds,
  });
  const channelConfig = interaction.guild
    ? resolveDiscordChannelConfig({
        guildInfo,
        channelId: channel?.id ?? "",
        channelName,
        channelSlug,
      })
    : null;
  if (channelConfig?.enabled === false) {
    await respond("This channel is disabled.");
    return;
  }
  if (interaction.guild && channelConfig?.allowed === false) {
    await respond("This channel is not allowed.");
    return;
  }
  if (useAccessGroups && interaction.guild) {
    const channelAllowlistConfigured =
      Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
    const channelAllowed = channelConfig?.allowed !== false;
    const allowByPolicy = isDiscordGroupAllowedByPolicy({
      groupPolicy: discordConfig?.groupPolicy ?? "open",
      channelAllowlistConfigured,
      channelAllowed,
    });
    if (!allowByPolicy) {
      await respond("This channel is not allowed.");
      return;
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = discordConfig?.dm?.policy ?? "pairing";
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      await respond("Discord DMs are disabled.");
      return;
    }
    if (dmPolicy !== "open") {
      const storeAllowFrom = await readChannelAllowFromStore("discord").catch(() => []);
      const effectiveAllowFrom = [...(discordConfig?.dm?.allowFrom ?? []), ...storeAllowFrom];
      const allowList = normalizeDiscordAllowList(effectiveAllowFrom, ["discord:", "user:"]);
      const permitted = allowList
        ? allowListMatches(allowList, {
            id: user.id,
            name: user.username,
            tag: formatDiscordUserTag(user),
          })
        : false;
      if (!permitted) {
        commandAuthorized = false;
        if (dmPolicy === "pairing") {
          const { code, created } = await upsertChannelPairingRequest({
            channel: "discord",
            id: user.id,
            meta: {
              tag: formatDiscordUserTag(user),
              name: user.username ?? undefined,
            },
          });
          if (created) {
            await respond(
              buildPairingReply({
                channel: "discord",
                idLine: `Your Discord user id: ${user.id}`,
                code,
              }),
              { ephemeral: true },
            );
          }
        } else {
          await respond("You are not authorized to use this command.", { ephemeral: true });
        }
        return;
      }
      commandAuthorized = true;
    }
  }
  if (!isDirectMessage) {
    const channelUsers = channelConfig?.users ?? guildInfo?.users;
    if (Array.isArray(channelUsers) && channelUsers.length > 0) {
      const userOk = resolveDiscordUserAllowed({
        allowList: channelUsers,
        userId: user.id,
        userName: user.username,
        userTag: formatDiscordUserTag(user),
      });
      if (!userOk) {
        await respond("You are not authorized to use this command.");
        return;
      }
    }
  }
  if (isGroupDm && discordConfig?.dm?.groupEnabled === false) {
    await respond("Discord group DMs are disabled.");
    return;
  }

  const menu = resolveCommandArgMenu({
    command,
    args: commandArgs,
    cfg,
  });
  if (menu) {
    const menuPayload = buildDiscordCommandArgMenu({
      command,
      menu,
      interaction: interaction as CommandInteraction,
      cfg,
      discordConfig,
      accountId,
      sessionPrefix,
    });
    if (preferFollowUp) {
      await interaction.followUp({
        content: menuPayload.content,
        components: menuPayload.components,
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: menuPayload.content,
      components: menuPayload.components,
      ephemeral: true,
    });
    return;
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = channel?.id ?? "unknown";
  const interactionId = interaction.rawData.id;
  const route = resolveAgentRoute({
    cfg,
    channel: "discord",
    accountId,
    guildId: interaction.guild?.id ?? undefined,
    peer: {
      kind: isDirectMessage ? "dm" : isGroupDm ? "group" : "channel",
      id: isDirectMessage ? user.id : channelId,
    },
  });
  const ctxPayload = {
    Body: prompt,
    CommandBody: prompt,
    CommandArgs: commandArgs,
    From: isDirectMessage ? `discord:${user.id}` : `group:${channelId}`,
    To: `slash:${user.id}`,
    SessionKey: `agent:${route.agentId}:${sessionPrefix}:${user.id}`,
    CommandTargetSessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "group",
    GroupSubject: isGuild ? interaction.guild?.name : undefined,
    GroupSystemPrompt: isGuild
      ? (() => {
          const channelTopic =
            channel && "topic" in channel ? (channel.topic ?? undefined) : undefined;
          const channelDescription = channelTopic?.trim();
          const systemPromptParts = [
            channelDescription ? `Channel topic: ${channelDescription}` : null,
            channelConfig?.systemPrompt?.trim() || null,
          ].filter((entry): entry is string => Boolean(entry));
          return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
        })()
      : undefined,
    SenderName: user.globalName ?? user.username,
    SenderId: user.id,
    SenderUsername: user.username,
    SenderTag: formatDiscordUserTag(user),
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    MessageSid: interactionId,
    Timestamp: Date.now(),
    CommandAuthorized: commandAuthorized,
    CommandSource: "native" as const,
  };

  let didReply = false;
  await dispatchReplyWithDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        await deliverDiscordInteractionReply({
          interaction,
          payload,
          textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
            fallbackLimit: 2000,
          }),
          maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
          preferFollowUp: preferFollowUp || didReply,
        });
        didReply = true;
      },
      onError: (err, info) => {
        console.error(`discord slash ${info.kind} reply failed`, err);
      },
    },
    replyOptions: {
      skillFilter: channelConfig?.skills,
      disableBlockStreaming:
        typeof discordConfig?.blockStreaming === "boolean"
          ? !discordConfig.blockStreaming
          : undefined,
    },
  });
}

async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction | ButtonInteraction;
  payload: ReplyPayload;
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
}) {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp } = params;
  const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const text = payload.text ?? "";

  let hasReplied = false;
  const sendMessage = async (content: string, files?: { name: string; data: Buffer }[]) => {
    const payload =
      files && files.length > 0
        ? {
            content,
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { name: file.name, data: file.data };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { name: file.name, data: new Blob([arrayBuffer]) };
            }),
          }
        : { content };
    if (!preferFollowUp && !hasReplied) {
      await interaction.reply(payload);
      hasReplied = true;
      return;
    }
    await interaction.followUp(payload);
    hasReplied = true;
  };

  if (mediaList.length > 0) {
    const media = await Promise.all(
      mediaList.map(async (url) => {
        const loaded = await loadWebMedia(url);
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
        };
      }),
    );
    const chunks = chunkDiscordText(text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
    });
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) continue;
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (!text.trim()) return;
  const chunks = chunkDiscordText(text, {
    maxChars: textLimit,
    maxLines: maxLinesPerMessage,
  });
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    await sendMessage(chunk);
  }
}
