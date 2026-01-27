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
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
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
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MoltbotConfig, loadConfig } from "../../config/config.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { loadWebMedia } from "../../web/media.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordUserAllowed,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

type DiscordConfig = NonNullable<MoltbotConfig["channels"]>["discord"];

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
            ? choices.filter((choice) => choice.label.toLowerCase().includes(focusValue))
            : choices;
          await interaction.respond(
            filtered.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.value })),
          );
        }
      : undefined;
    const choices =
      resolvedChoices.length > 0 && !autocomplete
        ? resolvedChoices
            .slice(0, 25)
            .map((choice) => ({ name: choice.label, value: choice.value }))
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
    let value: string | number | boolean | null | undefined;
    if (definition.type === "number") {
      value = interaction.options.getNumber(definition.name) ?? null;
    } else if (definition.type === "boolean") {
      value = interaction.options.getBoolean(definition.name) ?? null;
    } else {
      value = interaction.options.getString(definition.name) ?? null;
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

function isDiscordUnknownInteraction(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as {
    discordCode?: number;
    status?: number;
    message?: string;
    rawBody?: { code?: number; message?: string };
  };
  if (err.discordCode === 10062 || err.rawBody?.code === 10062) return true;
  if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) return true;
  if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) return true;
  return false;
}

async function safeDiscordInteractionCall<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isDiscordUnknownInteraction(error)) {
      console.warn(`discord: ${label} skipped (interaction expired)`);
      return null;
    }
    throw error;
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

type DiscordCommandArgContext = {
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
};

async function handleDiscordCommandArgInteraction(
  interaction: ButtonInteraction,
  data: ComponentData,
  ctx: DiscordCommandArgContext,
) {
  const parsed = parseDiscordCommandArgData(data);
  if (!parsed) {
    await safeDiscordInteractionCall("command arg update", () =>
      interaction.update({
        content: "Sorry, that selection is no longer available.",
        components: [],
      }),
    );
    return;
  }
  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await safeDiscordInteractionCall("command arg ack", () => interaction.acknowledge());
    return;
  }
  const commandDefinition =
    findCommandByNativeName(parsed.command, "discord") ??
    listChatCommands().find((entry) => entry.key === parsed.command);
  if (!commandDefinition) {
    await safeDiscordInteractionCall("command arg update", () =>
      interaction.update({
        content: "Sorry, that command is no longer available.",
        components: [],
      }),
    );
    return;
  }
  const updated = await safeDiscordInteractionCall("command arg update", () =>
    interaction.update({
      content: `✅ Selected ${parsed.value}.`,
      components: [],
    }),
  );
  if (!updated) return;
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
    cfg: ctx.cfg,
    discordConfig: ctx.discordConfig,
    accountId: ctx.accountId,
    sessionPrefix: ctx.sessionPrefix,
    preferFollowUp: true,
  });
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
    await handleDiscordCommandArgInteraction(interaction, data, {
      cfg: this.cfg,
      discordConfig: this.discordConfig,
      accountId: this.accountId,
      sessionPrefix: this.sessionPrefix,
    });
  }
}

class DiscordCommandArgFallbackButton extends Button {
  label = "cmdarg";
  customId = "cmdarg:seed=1";
  private ctx: DiscordCommandArgContext;

  constructor(ctx: DiscordCommandArgContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await handleDiscordCommandArgInteraction(interaction, data, this.ctx);
  }
}

export function createDiscordCommandArgFallbackButton(params: DiscordCommandArgContext): Button {
  return new DiscordCommandArgFallbackButton(params);
}

function buildDiscordCommandArgMenu(params: {
  command: ChatCommandDefinition;
  menu: {
    arg: CommandArgDefinition;
    choices: Array<{ value: string; label: string }>;
    title?: string;
  };
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
          label: choice.label,
          customId: buildDiscordCommandArgCustomId({
            command: commandLabel,
            arg: menu.arg.name,
            value: choice.value,
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
    findCommandByNativeName(command.name, "discord") ??
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
    await safeDiscordInteractionCall("interaction reply", async () => {
      if (preferFollowUp) {
        await interaction.followUp(payload);
        return;
      }
      await interaction.reply(payload);
    });
  };

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const user = interaction.user;
  if (!user) return;
  const channel = interaction.channel;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const channelName = channel && "name" in channel ? (channel.name as string) : undefined;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const rawChannelId = channel?.id ?? "";
  const ownerAllowList = normalizeDiscordAllowList(discordConfig?.dm?.allowFrom ?? [], [
    "discord:",
    "user:",
  ]);
  const ownerOk =
    ownerAllowList && user
      ? allowListMatches(ownerAllowList, {
          id: user.id,
          name: user.username,
          tag: formatDiscordUserTag(user),
        })
      : false;
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildEntries: discordConfig?.guilds,
  });
  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    // Threads inherit parent channel config unless explicitly overridden.
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: channelName,
        parentId: "parentId" in channel ? (channel.parentId ?? undefined) : undefined,
        parent: undefined,
      },
      channelInfo,
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }
  const channelConfig = interaction.guild
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: rawChannelId,
        channelName,
        channelSlug,
        parentId: threadParentId,
        parentName: threadParentName,
        parentSlug: threadParentSlug,
        scope: isThreadChannel ? "thread" : "channel",
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
      guildAllowlisted: Boolean(guildInfo),
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
    const hasUserAllowlist = Array.isArray(channelUsers) && channelUsers.length > 0;
    const userOk = hasUserAllowlist
      ? resolveDiscordUserAllowed({
          allowList: channelUsers,
          userId: user.id,
          userName: user.username,
          userTag: formatDiscordUserTag(user),
        })
      : false;
    const authorizers = useAccessGroups
      ? [
          { configured: ownerAllowList != null, allowed: ownerOk },
          { configured: hasUserAllowlist, allowed: userOk },
        ]
      : [{ configured: hasUserAllowlist, allowed: userOk }];
    commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers,
      modeWhenAccessGroupsOff: "configured",
    });
    if (!commandAuthorized) {
      await respond("You are not authorized to use this command.", { ephemeral: true });
      return;
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
      await safeDiscordInteractionCall("interaction follow-up", () =>
        interaction.followUp({
          content: menuPayload.content,
          components: menuPayload.components,
          ephemeral: true,
        }),
      );
      return;
    }
    await safeDiscordInteractionCall("interaction reply", () =>
      interaction.reply({
        content: menuPayload.content,
        components: menuPayload.components,
        ephemeral: true,
      }),
    );
    return;
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
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
  const conversationLabel = isDirectMessage ? (user.globalName ?? user.username) : channelId;
  const ctxPayload = finalizeInboundContext({
    Body: prompt,
    RawBody: prompt,
    CommandBody: prompt,
    CommandArgs: commandArgs,
    From: isDirectMessage
      ? `discord:${user.id}`
      : isGroupDm
        ? `discord:group:${channelId}`
        : `discord:channel:${channelId}`,
    To: `slash:${user.id}`,
    SessionKey: `agent:${route.agentId}:${sessionPrefix}:${user.id}`,
    CommandTargetSessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
    ConversationLabel: conversationLabel,
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
  });

  let didReply = false;
  await dispatchReplyWithDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        try {
          await deliverDiscordInteractionReply({
            interaction,
            payload,
            textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
              fallbackLimit: 2000,
            }),
            maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
            preferFollowUp: preferFollowUp || didReply,
            chunkMode: resolveChunkMode(cfg, "discord", accountId),
          });
        } catch (error) {
          if (isDiscordUnknownInteraction(error)) {
            console.warn("discord: interaction reply skipped (interaction expired)");
            return;
          }
          throw error;
        }
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
  chunkMode: "length" | "newline";
}) {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
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
    await safeDiscordInteractionCall("interaction send", async () => {
      if (!preferFollowUp && !hasReplied) {
        await interaction.reply(payload);
        hasReplied = true;
        return;
      }
      await interaction.followUp(payload);
      hasReplied = true;
    });
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
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
      chunkMode,
    });
    if (!chunks.length && text) chunks.push(text);
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) continue;
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (!text.trim()) return;
  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: textLimit,
    maxLines: maxLinesPerMessage,
    chunkMode,
  });
  if (!chunks.length && text) chunks.push(text);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    await sendMessage(chunk);
  }
}
