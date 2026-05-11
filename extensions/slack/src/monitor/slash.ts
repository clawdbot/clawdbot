import type { SlackActionMiddlewareArgs, SlackCommandMiddlewareArgs } from "@slack/bolt";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-message";
import {
  formatCommandArgMenuTitle,
  resolveStoredModelOverride,
  type ChatCommandDefinition,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  type CommandArgs,
  resolveNativeCommandSessionTargets,
} from "openclaw/plugin-sdk/command-auth-native";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import type { ResolvedSlackAccount } from "../accounts.js";
import { SLACK_MAX_BLOCKS } from "../blocks-input.js";
import { formatSlackError } from "../errors.js";
import { truncateSlackText } from "../truncate.js";
import { resolveSlackCommandIngress, resolveSlackEffectiveAllowFrom } from "./auth.js";
import { resolveSlackChannelConfig, type SlackChannelConfigResolved } from "./channel-config.js";
import { buildSlackSlashCommandMatcher, resolveSlackSlashCommandConfig } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import { normalizeSlackChannelType, resolveSlackChatType } from "./context.js";
import { authorizeSlackDirectMessage } from "./dm-auth.js";
import {
  createSlackExternalArgMenuStore,
  SLACK_EXTERNAL_ARG_MENU_PREFIX,
  type SlackExternalArgMenuChoice,
} from "./external-arg-menu-store.js";
import { escapeSlackMrkdwn } from "./mrkdwn.js";
import { isSlackChannelAllowedByPolicy } from "./policy.js";
import { resolveSlackRoomContextHints } from "./room-context.js";

type SlackBlock = { type: string; [key: string]: unknown };

const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
const SLACK_COMMAND_ARG_ACTION_LISTENER = /^openclaw_cmdarg/;
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_OVERFLOW_MIN = 3;
const SLACK_COMMAND_ARG_OVERFLOW_MAX = 5;
const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
const SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 150;
const SLACK_COMMAND_ARG_BUTTON_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_BUTTON_VALUE_MAX = 2000;
const SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX = 300;
const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_COMMAND_ARG_CHROME_BLOCKS = 3;
const SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX = SLACK_MAX_BLOCKS - SLACK_COMMAND_ARG_CHROME_BLOCKS;
let slashCommandsRuntimePromise: Promise<typeof import("./slash-commands.runtime.js")> | null =
  null;
let slashDispatchRuntimePromise: Promise<typeof import("./slash-dispatch.runtime.js")> | null =
  null;
let slackPluginCommandsRuntimePromise: Promise<
  typeof import("./slash-plugin-commands.runtime.js")
> | null = null;
let slashSkillCommandsRuntimePromise: Promise<
  typeof import("./slash-skill-commands.runtime.js")
> | null = null;

function loadSlashCommandsRuntime() {
  slashCommandsRuntimePromise ??= import("./slash-commands.runtime.js");
  return slashCommandsRuntimePromise;
}

function loadSlashDispatchRuntime() {
  slashDispatchRuntimePromise ??= import("./slash-dispatch.runtime.js");
  return slashDispatchRuntimePromise;
}

function loadSlackPluginCommandsRuntime() {
  slackPluginCommandsRuntimePromise ??= import("./slash-plugin-commands.runtime.js");
  return slackPluginCommandsRuntimePromise;
}

function loadSlashSkillCommandsRuntime() {
  slashSkillCommandsRuntimePromise ??= import("./slash-skill-commands.runtime.js");
  return slashSkillCommandsRuntimePromise;
}

function resolveSlackCommandMenuModelContext(params: {
  cfg: SlackMonitorContext["cfg"];
  agentId: string;
  sessionKey: string;
}): { provider?: string; model?: string } {
  if (!params.sessionKey.trim()) {
    return {};
  }
  try {
    const defaultModel = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const store = loadSessionStore(storePath);
    const entry = store[params.sessionKey];
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      return { provider: defaultModel.provider, model: defaultModel.model };
    }
    const override = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: params.sessionKey,
      defaultProvider: defaultModel.provider,
    });
    if (override?.model) {
      return {
        provider: override.provider || defaultModel.provider,
        model: override.model,
      };
    }
    const provider =
      normalizeOptionalString(entry?.providerOverride) ??
      normalizeOptionalString(entry?.modelProvider);
    const model =
      normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
    return {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
  } catch {
    return {};
  }
}

type EncodedMenuChoice = SlackExternalArgMenuChoice;
const slackExternalArgMenuStore = createSlackExternalArgMenuStore();

function buildSlackArgMenuConfirm(params: { command: string; arg: string }) {
  const command = escapeSlackMrkdwn(params.command);
  const arg = escapeSlackMrkdwn(params.arg);
  return {
    title: { type: "plain_text", text: "Confirm selection" },
    text: {
      type: "mrkdwn",
      text: truncateSlackText(
        `Run */${command}* with *${arg}* set to this value?`,
        SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX,
      ),
    },
    confirm: { type: "plain_text", text: "Run command" },
    deny: { type: "plain_text", text: "Cancel" },
  };
}

function storeSlackExternalArgMenu(params: {
  choices: EncodedMenuChoice[];
  userId: string;
}): string {
  return slackExternalArgMenuStore.create({
    choices: params.choices,
    userId: params.userId,
  });
}

function readSlackExternalArgMenuToken(raw: unknown): string | undefined {
  return slackExternalArgMenuStore.readToken(raw);
}

function encodeSlackCommandArgValue(parts: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}) {
  return [
    SLACK_COMMAND_ARG_VALUE_PREFIX,
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function parseSlackCommandArgValue(raw?: string | null): {
  command: string;
  arg: string;
  value: string;
  userId: string;
} | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) {
    return null;
  }
  const [, command, arg, value, userId] = parts;
  if (!command || !arg || !value || !userId) {
    return null;
  }
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return null;
    }
  };
  const decodedCommand = decode(command);
  const decodedArg = decode(arg);
  const decodedValue = decode(value);
  const decodedUserId = decode(userId);
  if (!decodedCommand || !decodedArg || !decodedValue || !decodedUserId) {
    return null;
  }
  return {
    command: decodedCommand,
    arg: decodedArg,
    value: decodedValue,
    userId: decodedUserId,
  };
}

function buildSlackArgMenuOptions(choices: EncodedMenuChoice[]) {
  return choices.map((choice) => ({
    text: {
      type: "plain_text",
      text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX),
    },
    value: choice.value,
  }));
}

function buildSlackCommandArgMenuBlocks(params: {
  title: string;
  command: string;
  arg: string;
  choices: Array<{ value: string; label: string }>;
  userId: string;
  supportsExternalSelect: boolean;
  createExternalMenuToken: (choices: EncodedMenuChoice[]) => string;
}) {
  const encodedChoices = params.choices.map((choice) => ({
    label: choice.label,
    value: encodeSlackCommandArgValue({
      command: params.command,
      arg: params.arg,
      value: choice.value,
      userId: params.userId,
    }),
  }));
  const canUseStaticSelect = encodedChoices.every(
    (choice) => choice.value.length <= SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX,
  );
  const canUseOverflow =
    canUseStaticSelect &&
    encodedChoices.length >= SLACK_COMMAND_ARG_OVERFLOW_MIN &&
    encodedChoices.length <= SLACK_COMMAND_ARG_OVERFLOW_MAX;
  const canUseExternalSelect =
    params.supportsExternalSelect &&
    canUseStaticSelect &&
    encodedChoices.length > SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX;
  const rows = canUseOverflow
    ? [
        {
          type: "actions",
          elements: [
            {
              type: "overflow",
              action_id: SLACK_COMMAND_ARG_ACTION_ID,
              confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
              options: buildSlackArgMenuOptions(encodedChoices),
            },
          ],
        },
      ]
    : canUseExternalSelect
      ? [
          {
            type: "actions",
            block_id: `${SLACK_EXTERNAL_ARG_MENU_PREFIX}${params.createExternalMenuToken(
              encodedChoices,
            )}`,
            elements: [
              {
                type: "external_select",
                action_id: SLACK_COMMAND_ARG_ACTION_ID,
                confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
                min_query_length: 0,
                placeholder: {
                  type: "plain_text",
                  text: `Search ${params.arg}`,
                },
              },
            ],
          },
        ]
      : encodedChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE || !canUseStaticSelect
        ? chunkItems(
            encodedChoices.filter(
              (choice) => choice.value.length <= SLACK_COMMAND_ARG_BUTTON_VALUE_MAX,
            ),
            SLACK_COMMAND_ARG_BUTTON_ROW_SIZE,
          ).map((choices, rowIndex) => ({
            type: "actions",
            elements: choices.map((choice, colIndex) => ({
              type: "button",
              action_id: `${SLACK_COMMAND_ARG_ACTION_ID}_${rowIndex}_${colIndex}`,
              text: {
                type: "plain_text",
                text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_BUTTON_TEXT_MAX),
              },
              value: choice.value,
              confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
            })),
          }))
        : chunkItems(encodedChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map(
            (choices, index) => ({
              type: "actions",
              elements: [
                {
                  type: "static_select",
                  action_id: SLACK_COMMAND_ARG_ACTION_ID,
                  confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
                  placeholder: {
                    type: "plain_text",
                    text:
                      index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`,
                  },
                  options: buildSlackArgMenuOptions(choices),
                },
              ],
            }),
          );
  const headerText = truncateSlackText(
    `/${params.command}: choose ${params.arg}`,
    SLACK_HEADER_TEXT_MAX,
  );
  const sectionText = truncateSlackText(params.title, 3000);
  const contextText = truncateSlackText(
    `Select one option to continue /${params.command} (${params.arg})`,
    3000,
  );
  const visibleRows = rows.slice(0, SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX);
  return [
    {
      type: "header",
      text: { type: "plain_text", text: headerText },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: sectionText },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextText }],
    },
    ...visibleRows,
  ];
}

export async function registerSlackMonitorSlashCommands(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  trackEvent?: () => void;
}): Promise<void> {
  const { ctx, account, trackEvent } = params;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  const supportsInteractiveArgMenus =
    typeof (ctx.app as { action?: unknown }).action === "function";
  let supportsExternalArgMenus = typeof (ctx.app as { options?: unknown }).options === "function";

  const slashCommand = resolveSlackSlashCommandConfig(
    ctx.slashCommand ?? account.config.slashCommand,
  );

  const handleSlashCommand = async (p: {
    command: SlackCommandMiddlewareArgs["command"];
    ack: SlackCommandMiddlewareArgs["ack"];
    respond: SlackCommandMiddlewareArgs["respond"];
    body?: unknown;
    prompt: string;
    commandArgs?: CommandArgs;
    commandDefinition?: ChatCommandDefinition;
  }) => {
    const { command, ack, respond, body, prompt, commandArgs, commandDefinition } = p;
    try {
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        await ack();
        runtime.log?.(
          `slack: drop slash command from user=${command.user_id ?? "unknown"} channel=${command.channel_id ?? "unknown"} (mismatched app/team)`,
        );
        return;
      }
      trackEvent?.();
      if (!prompt.trim()) {
        await ack({
          text: "Message required.",
          response_type: "ephemeral",
        });
        return;
      }
      await ack();

      if (ctx.botUserId && command.user_id === ctx.botUserId) {
        return;
      }

      const channelInfo = await ctx.resolveChannelName(command.channel_id);
      const rawChannelType =
        channelInfo?.type ?? (command.channel_name === "directmessage" ? "im" : undefined);
      const channelType = normalizeSlackChannelType(rawChannelType, command.channel_id);
      const chatType = resolveSlackChatType(channelType);
      const isDirectMessage = channelType === "im";
      const isGroupDm = channelType === "mpim";
      const isRoom = channelType === "channel" || channelType === "group";
      const isRoomish = isRoom || isGroupDm;

      if (
        !ctx.isChannelAllowed({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channelType,
        })
      ) {
        await respond({
          text: "This channel is not allowed.",
          response_type: "ephemeral",
        });
        return;
      }

      const effectiveAllowFromLower = await resolveSlackEffectiveAllowFrom(ctx, {
        includePairingStore: isDirectMessage,
      });

      // Privileged command surface: compute CommandAuthorized, don't assume true.
      // Keep this aligned with the Slack message path (message-handler/prepare.ts).
      let commandAuthorized = false;
      let channelConfig: SlackChannelConfigResolved | null = null;
      if (isDirectMessage) {
        const allowed = await authorizeSlackDirectMessage({
          ctx,
          accountId: ctx.accountId,
          senderId: command.user_id,
          allowFromLower: effectiveAllowFromLower,
          resolveSenderName: ctx.resolveUserName,
          sendPairingReply: async (text) => {
            await respond({
              text,
              response_type: "ephemeral",
            });
          },
          onDisabled: async () => {
            await respond({
              text: "Slack DMs are disabled.",
              response_type: "ephemeral",
            });
          },
          onUnauthorized: async ({ allowMatchMeta }) => {
            logVerbose(
              `slack: blocked slash sender ${command.user_id} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
            );
            await respond({
              text: "You are not authorized to use this command.",
              response_type: "ephemeral",
            });
          },
          log: logVerbose,
        });
        if (!allowed) {
          return;
        }
      }

      if (isRoom) {
        channelConfig = resolveSlackChannelConfig({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channels: ctx.channelsConfig,
          channelKeys: ctx.channelsConfigKeys,
          defaultRequireMention: ctx.defaultRequireMention,
          allowNameMatching: ctx.allowNameMatching,
        });
        if (ctx.useAccessGroups) {
          const channelAllowlistConfigured = (ctx.channelsConfigKeys?.length ?? 0) > 0;
          const channelAllowed = channelConfig?.allowed !== false;
          if (
            !isSlackChannelAllowedByPolicy({
              groupPolicy: ctx.groupPolicy,
              channelAllowlistConfigured,
              channelAllowed,
            })
          ) {
            await respond({
              text: "This channel is not allowed.",
              response_type: "ephemeral",
            });
            return;
          }
          // When groupPolicy is "open", only block channels that are EXPLICITLY denied
          // (i.e., have a matching config entry with allow:false). Channels not in the
          // config (matchSource undefined) should be allowed under open policy.
          const hasExplicitConfig = Boolean(channelConfig?.matchSource);
          if (!channelAllowed && (ctx.groupPolicy !== "open" || hasExplicitConfig)) {
            await respond({
              text: "This channel is not allowed.",
              response_type: "ephemeral",
            });
            return;
          }
        }
      }

      const sender = await ctx.resolveUserName(command.user_id);
      const senderName = sender?.name ?? command.user_name ?? command.user_id;
      const slashIngress = await resolveSlackCommandIngress({
        ctx,
        senderId: command.user_id,
        senderName,
        channelType: channelType ?? "channel",
        channelId: command.channel_id,
        ownerAllowFromLower: effectiveAllowFromLower,
        channelUsers: isRoom ? channelConfig?.users : undefined,
        allowTextCommands: false,
        hasControlCommand: false,
        eventKind: "slash-command",
        modeWhenAccessGroupsOff: "configured",
      });
      const senderGate = slashIngress.senderAccess.gate;
      if (isRoom && senderGate?.allowed === false) {
        await respond({
          text: "You are not authorized to use this command here.",
          response_type: "ephemeral",
        });
        return;
      }

      // DMs: allow chatting in dmPolicy=open, but keep privileged command gating intact by setting
      // CommandAuthorized based on allowlists/access-groups (downstream decides which commands need it).
      commandAuthorized = slashIngress.commandAccess.authorized;
      if (isRoomish) {
        if (ctx.useAccessGroups && !commandAuthorized) {
          await respond({
            text: "You are not authorized to use this command.",
            response_type: "ephemeral",
          });
          return;
        }
      }

      let resolvedSlashRoute: ResolvedAgentRoute | undefined;
      const resolveSlashRoute = async () => {
        if (resolvedSlashRoute) {
          return resolvedSlashRoute;
        }
        const { resolveAgentRoute } = await loadSlashDispatchRuntime();
        resolvedSlashRoute = resolveAgentRoute({
          cfg,
          channel: "slack",
          accountId: account.accountId,
          teamId: ctx.teamId || undefined,
          peer: {
            kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
            id: isDirectMessage ? command.user_id : command.channel_id,
          },
        });
        return resolvedSlashRoute;
      };

      if (commandDefinition && supportsInteractiveArgMenus) {
        const { resolveCommandArgMenu } = await loadSlashCommandsRuntime();
        const menuNeedsModelContext =
          !(commandArgs?.raw && !commandArgs.values) &&
          commandDefinition.args?.some(
            (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
          );
        const menuRoute = menuNeedsModelContext ? await resolveSlashRoute() : undefined;
        const menuModelContext = menuRoute
          ? resolveSlackCommandMenuModelContext({
              cfg,
              agentId: menuRoute.agentId,
              sessionKey: menuRoute.sessionKey,
            })
          : {};
        const menu = resolveCommandArgMenu({
          command: commandDefinition,
          args: commandArgs,
          cfg,
          ...menuModelContext,
        });
        if (menu) {
          const commandLabel = commandDefinition.nativeName ?? commandDefinition.key;
          const title = formatCommandArgMenuTitle({ command: commandDefinition, menu });
          const blocks = buildSlackCommandArgMenuBlocks({
            title,
            command: commandLabel,
            arg: menu.arg.name,
            choices: menu.choices,
            userId: command.user_id,
            supportsExternalSelect: supportsExternalArgMenus,
            createExternalMenuToken: (choices) =>
              storeSlackExternalArgMenu({ choices, userId: command.user_id }),
          });
          await respond({
            text: title,
            blocks,
            response_type: "ephemeral",
          });
          return;
        }
      }

      const channelName = channelInfo?.name;
      const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
      const {
        deliverSlackSlashReplies,
        dispatchReplyWithDispatcher,
        finalizeInboundContext,
        recordInboundSessionMetaSafe,
        resolveAgentRoute,
        resolveChunkMode,
        resolveConversationLabel,
        resolveMarkdownTableMode,
      } = await loadSlashDispatchRuntime();

      const route =
        resolvedSlashRoute ??
        resolveAgentRoute({
          cfg,
          channel: "slack",
          accountId: account.accountId,
          teamId: ctx.teamId || undefined,
          peer: {
            kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
            id: isDirectMessage ? command.user_id : command.channel_id,
          },
        });

      const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
        isRoomish,
        channelInfo,
        channelConfig,
      });

      const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
        agentId: route.agentId,
        sessionPrefix: slashCommand.sessionPrefix,
        userId: command.user_id,
        targetSessionKey: route.sessionKey,
        lowercaseSessionKey: true,
      });
      const ctxPayload = finalizeInboundContext({
        Body: prompt,
        BodyForAgent: prompt,
        RawBody: prompt,
        CommandBody: prompt,
        CommandArgs: commandArgs,
        From: isDirectMessage
          ? `slack:${command.user_id}`
          : isRoom
            ? `slack:channel:${command.channel_id}`
            : `slack:group:${command.channel_id}`,
        To: `slash:${command.user_id}`,
        ChatType: chatType,
        ConversationLabel:
          resolveConversationLabel({
            ChatType: chatType,
            SenderName: senderName,
            GroupSubject: isRoomish ? roomLabel : undefined,
            From: isDirectMessage
              ? `slack:${command.user_id}`
              : isRoom
                ? `slack:channel:${command.channel_id}`
                : `slack:group:${command.channel_id}`,
          }) ?? (isDirectMessage ? senderName : roomLabel),
        GroupSubject: isRoomish ? roomLabel : undefined,
        GroupSpace: ctx.teamId || undefined,
        GroupSystemPrompt: groupSystemPrompt,
        UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
        SenderName: senderName,
        SenderId: command.user_id,
        Provider: "slack" as const,
        Surface: "slack" as const,
        WasMentioned: true,
        MessageSid: command.trigger_id,
        Timestamp: Date.now(),
        SessionKey: sessionKey,
        CommandTargetSessionKey: commandTargetSessionKey,
        AccountId: route.accountId,
        CommandSource: "native" as const,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "slack" as const,
        OriginatingTo: `user:${command.user_id}`,
      });

      await recordInboundSessionMetaSafe({
        cfg,
        agentId: route.agentId,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onError: (err) =>
          runtime.error?.(
            danger(`slack slash: failed updating session meta: ${formatErrorMessage(err)}`),
          ),
      });

      const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
        cfg,
        agentId: route.agentId,
        channel: "slack",
        accountId: route.accountId,
      });

      const deliverSlashPayloads = async (replies: ReplyPayload[]) => {
        await deliverSlackSlashReplies({
          replies,
          respond,
          ephemeral: slashCommand.ephemeral,
          textLimit: ctx.textLimit,
          chunkMode: resolveChunkMode(cfg, "slack", route.accountId),
          tableMode: resolveMarkdownTableMode({
            cfg,
            channel: "slack",
            accountId: route.accountId,
          }),
        });
      };

      const { counts } = await dispatchReplyWithDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload) => deliverSlashPayloads([payload]),
          onError: (err, info) => {
            runtime.error?.(
              danger(`slack slash ${info.kind} reply failed: ${formatSlackError(err)}`),
            );
          },
        },
        replyOptions: {
          skillFilter: channelConfig?.skills,
          onModelSelected,
        },
      });
      if (counts.final + counts.tool + counts.block === 0) {
        await deliverSlashPayloads([]);
      }
    } catch (err) {
      runtime.error?.(danger(`slack slash handler failed: ${formatErrorMessage(err)}`));
      await respond({
        text: "Sorry, something went wrong handling that command.",
        response_type: "ephemeral",
      });
    }
  };

  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "slack",
    providerSetting: account.config.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });

  let nativeCommands: Array<{ name: string }> = [];
  let slashCommandsRuntime: typeof import("./slash-commands.runtime.js") | null = null;
  if (nativeEnabled) {
    slashCommandsRuntime = await loadSlashCommandsRuntime();
    const skillCommands = nativeSkillsEnabled
      ? (await loadSlashSkillCommandsRuntime()).listSkillCommandsForAgents({ cfg })
      : [];
    nativeCommands = slashCommandsRuntime.listNativeCommandSpecsForConfig(cfg, {
      skillCommands,
      provider: "slack",
    });
    const existingNativeNames = new Set(
      nativeCommands.map((c) => normalizeLowercaseStringOrEmpty(c.name)).filter(Boolean),
    );
    const { listProviderPluginCommandSpecs } = await loadSlackPluginCommandsRuntime();
    for (const pluginCommand of listProviderPluginCommandSpecs("slack")) {
      const normalizedName = normalizeLowercaseStringOrEmpty(pluginCommand.name);
      if (!normalizedName || existingNativeNames.has(normalizedName)) {
        continue;
      }
      existingNativeNames.add(normalizedName);
      nativeCommands.push(pluginCommand);
    }
  }

  if (nativeCommands.length > 0) {
    if (!slashCommandsRuntime) {
      throw new Error("Missing commands runtime for native Slack commands.");
    }
    for (const command of nativeCommands) {
      ctx.app.command(
        `/${command.name}`,
        async ({ command: cmd, ack, respond, body }: SlackCommandMiddlewareArgs) => {
          const commandDefinition = slashCommandsRuntime.findCommandByNativeName(
            command.name,
            "slack",
          );
          const rawText = cmd.text?.trim() ?? "";
          const commandArgs = commandDefinition
            ? slashCommandsRuntime.parseCommandArgs(commandDefinition, rawText)
            : rawText
              ? ({ raw: rawText } satisfies CommandArgs)
              : undefined;
          const prompt = commandDefinition
            ? slashCommandsRuntime.buildCommandTextFromArgs(commandDefinition, commandArgs)
            : rawText
              ? `/${command.name} ${rawText}`
              : `/${command.name}`;
          await handleSlashCommand({
            command: cmd,
            ack,
            respond,
            body,
            prompt,
            commandArgs,
            commandDefinition: commandDefinition ?? undefined,
          });
        },
      );
    }
  } else if (slashCommand.enabled) {
    ctx.app.command(
      buildSlackSlashCommandMatcher(slashCommand.name),
      async ({ command, ack, respond, body }: SlackCommandMiddlewareArgs) => {
        await handleSlashCommand({
          command,
          ack,
          respond,
          body,
          prompt: command.text?.trim() ?? "",
        });
      },
    );
  } else {
    logVerbose("slack: slash commands disabled");
  }

  if (nativeCommands.length === 0 || !supportsInteractiveArgMenus) {
    return;
  }

  const registerArgOptions = () => {
    const appWithOptions = ctx.app as unknown as {
      options?: (
        actionId: string,
        handler: (args: {
          ack: (payload: { options: unknown[] }) => Promise<void>;
          body: unknown;
        }) => Promise<void>,
      ) => void;
    };
    if (typeof appWithOptions.options !== "function") {
      return;
    }
    appWithOptions.options(SLACK_COMMAND_ARG_ACTION_ID, async ({ ack, body }) => {
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        await ack({ options: [] });
        runtime.log?.("slack: drop slash arg options payload (mismatched app/team)");
        return;
      }
      trackEvent?.();
      const typedBody = body as {
        value?: string;
        user?: { id?: string };
        actions?: Array<{ block_id?: string }>;
        block_id?: string;
      };
      const blockId = typedBody.actions?.[0]?.block_id ?? typedBody.block_id;
      const token = readSlackExternalArgMenuToken(blockId);
      if (!token) {
        await ack({ options: [] });
        return;
      }
      const entry = slackExternalArgMenuStore.get(token);
      if (!entry) {
        await ack({ options: [] });
        return;
      }
      const requesterUserId = typedBody.user?.id?.trim();
      if (!requesterUserId || requesterUserId !== entry.userId) {
        await ack({ options: [] });
        return;
      }
      const query = normalizeLowercaseStringOrEmpty(typedBody.value);
      const options = entry.choices
        .filter((choice) => !query || normalizeLowercaseStringOrEmpty(choice.label).includes(query))
        .slice(0, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX)
        .map((choice) => ({
          text: { type: "plain_text", text: choice.label.slice(0, 75) },
          value: choice.value,
        }));
      await ack({ options });
    });
  };
  // Treat external arg-menu registration as best-effort: if Bolt's app.options()
  // throws (e.g. from receiver init issues), disable external selects and fall back
  // to static_select/button menus instead of crashing the entire provider startup.
  try {
    registerArgOptions();
  } catch (err) {
    supportsExternalArgMenus = false;
    logVerbose(
      `slack: external arg-menu registration failed, falling back to static menus: ${formatErrorMessage(err)}`,
    );
  }

  const registerArgAction = (actionId: string | RegExp) => {
    (
      ctx.app as unknown as {
        action: NonNullable<(typeof ctx.app & { action?: unknown })["action"]>;
      }
    ).action(actionId, async (args: SlackActionMiddlewareArgs) => {
      const { ack, body, respond } = args;
      const action = args.action as { value?: string; selected_option?: { value?: string } };
      await ack();
      if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
        runtime.log?.("slack: drop slash arg action payload (mismatched app/team)");
        return;
      }
      const respondFn =
        respond ??
        (async (payload: { text: string; blocks?: SlackBlock[]; response_type?: string }) => {
          if (!body.channel?.id || !body.user?.id) {
            return;
          }
          await ctx.app.client.chat.postEphemeral({
            token: ctx.botToken,
            channel: body.channel.id,
            user: body.user.id,
            text: payload.text,
            blocks: payload.blocks,
          });
        });
      const actionValue = action?.value ?? action?.selected_option?.value;
      const parsed = parseSlackCommandArgValue(actionValue);
      if (!parsed) {
        await respondFn({
          text: "Sorry, that button is no longer valid.",
          response_type: "ephemeral",
        });
        return;
      }
      if (body.user?.id && parsed.userId !== body.user.id) {
        await respondFn({
          text: "That menu is for another user.",
          response_type: "ephemeral",
        });
        return;
      }
      const { buildCommandTextFromArgs, findCommandByNativeName } =
        await loadSlashCommandsRuntime();
      const commandDefinition = findCommandByNativeName(parsed.command, "slack");
      const commandArgs: CommandArgs = {
        values: { [parsed.arg]: parsed.value },
      };
      const prompt = commandDefinition
        ? buildCommandTextFromArgs(commandDefinition, commandArgs)
        : `/${parsed.command} ${parsed.value}`;
      const user = body.user;
      const userName =
        user && "name" in user && user.name
          ? user.name
          : user && "username" in user && user.username
            ? user.username
            : (user?.id ?? "");
      const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
      const commandPayload = {
        user_id: user?.id ?? "",
        user_name: userName,
        channel_id: body.channel?.id ?? "",
        channel_name: body.channel?.name ?? body.channel?.id ?? "",
        trigger_id: triggerId,
      } as SlackCommandMiddlewareArgs["command"];
      await handleSlashCommand({
        command: commandPayload,
        ack: async () => {},
        respond: respondFn,
        body,
        prompt,
        commandArgs,
        commandDefinition: commandDefinition ?? undefined,
      });
    });
  };
  registerArgAction(SLACK_COMMAND_ARG_ACTION_LISTENER);
}
