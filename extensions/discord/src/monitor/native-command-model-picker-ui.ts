import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveStoredModelOverride,
  serializeCommandArgs,
  type ChatCommandDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  Container,
  TextDisplay,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import {
  readDiscordModelPickerRecentModels,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import {
  loadDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  toDiscordModelPickerMessagePayload,
  type DiscordModelPickerCommandContext,
} from "./model-picker.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import type { SafeDiscordInteractionCall } from "./native-command-ui.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordNativeChoiceInteraction =
  | AutocompleteInteraction
  | CommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction;

function resolveDiscordModelPickerCommandContext(
  command: ChatCommandDefinition,
): DiscordModelPickerCommandContext | null {
  const normalized = normalizeLowercaseStringOrEmpty(command.nativeName ?? command.key);
  if (normalized === "model" || normalized === "models") {
    return normalized;
  }
  return null;
}

function resolveCommandArgStringValue(args: CommandArgs | undefined, key: string): string {
  const value = args?.values?.[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export function shouldOpenDiscordModelPickerFromCommand(params: {
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
}): DiscordModelPickerCommandContext | null {
  const context = resolveDiscordModelPickerCommandContext(params.command);
  if (!context) {
    return null;
  }

  const serializedArgs =
    normalizeOptionalString(serializeCommandArgs(params.command, params.commandArgs)) ?? "";
  if (context === "model") {
    const modelValue = resolveCommandArgStringValue(params.commandArgs, "model");
    return !modelValue && !serializedArgs ? context : null;
  }

  return serializedArgs ? null : context;
}

function buildDiscordModelPickerCurrentModel(
  defaultProvider: string,
  defaultModel: string,
): string {
  return `${defaultProvider}/${defaultModel}`;
}

export function buildDiscordModelPickerAllowedModelRefs(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
): Set<string> {
  const out = new Set<string>();
  for (const provider of data.providers) {
    const models = data.byProvider.get(provider);
    if (!models) {
      continue;
    }
    for (const model of models) {
      out.add(`${provider}/${model}`);
    }
  }
  return out;
}

export function resolveDiscordModelPickerPreferenceScope(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  accountId: string;
  userId: string;
}): DiscordModelPickerPreferenceScope {
  return {
    accountId: params.accountId,
    guildId: params.interaction.guild?.id ?? undefined,
    userId: params.userId,
  };
}

export function buildDiscordModelPickerNoticePayload(message: string): { components: Container[] } {
  return {
    components: [new Container([new TextDisplay(message)])],
  };
}

async function resolveDiscordModelPickerRouteState(params: {
  interaction:
    | CommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | AutocompleteInteraction;
  cfg: OpenClawConfig;
  accountId: string;
  threadBindings: ThreadBindingManager;
  enforceConfiguredBindingReadiness?: boolean;
}) {
  const { interaction, cfg, accountId } = params;
  const { isDirectMessage, isGroupDm, isThreadChannel, rawChannelId, threadParentId } =
    await resolveDiscordNativeInteractionChannelContext({
      channel: interaction.channel,
      client: interaction.client,
      hasGuild: Boolean(interaction.guild),
      channelIdFallback: "unknown",
    });
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];

  const threadBinding = isThreadChannel
    ? params.threadBindings.getByThreadId(rawChannelId)
    : undefined;
  return await resolveDiscordNativeInteractionRouteState({
    cfg,
    accountId,
    guildId: interaction.guild?.id ?? undefined,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    directUserId: interaction.user?.id ?? rawChannelId,
    conversationId: rawChannelId,
    parentConversationId: threadParentId,
    threadBinding,
    enforceConfiguredBindingReadiness: params.enforceConfiguredBindingReadiness,
  });
}

export async function resolveDiscordModelPickerRoute(params: {
  interaction:
    | CommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | AutocompleteInteraction;
  cfg: OpenClawConfig;
  accountId: string;
  threadBindings: ThreadBindingManager;
}) {
  const resolved = await resolveDiscordModelPickerRouteState(params);
  return resolved.effectiveRoute;
}

export async function resolveDiscordNativeChoiceContext(params: {
  interaction: DiscordNativeChoiceInteraction;
  cfg: OpenClawConfig;
  accountId: string;
  threadBindings: ThreadBindingManager;
}): Promise<{ provider?: string; model?: string } | null> {
  try {
    const resolved = await resolveDiscordModelPickerRouteState({
      interaction: params.interaction,
      cfg: params.cfg,
      accountId: params.accountId,
      threadBindings: params.threadBindings,
      enforceConfiguredBindingReadiness: true,
    });
    if (resolved.bindingReadiness && !resolved.bindingReadiness.ok) {
      return null;
    }
    const route = resolved.effectiveRoute;
    const fallback = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: route.agentId,
    });
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: route.agentId,
    });
    const sessionStore = loadSessionStore(storePath);
    const sessionEntry = sessionStore[route.sessionKey];
    const override = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey: route.sessionKey,
      defaultProvider: fallback.provider,
    });
    if (!override?.model) {
      return {
        provider: fallback.provider,
        model: fallback.model,
      };
    }
    return {
      provider: override.provider || fallback.provider,
      model: override.model,
    };
  } catch {
    return null;
  }
}

export function resolveDiscordModelPickerCurrentModel(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
}): string {
  const fallback = buildDiscordModelPickerCurrentModel(
    params.data.resolvedDefault.provider,
    params.data.resolvedDefault.model,
  );
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    });
    const sessionStore = loadSessionStore(storePath, { skipCache: true });
    const sessionEntry = sessionStore[params.route.sessionKey];
    const override = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey: params.route.sessionKey,
      defaultProvider: params.data.resolvedDefault.provider,
    });
    if (!override?.model) {
      return fallback;
    }
    const provider = (override.provider || params.data.resolvedDefault.provider).trim();
    if (!provider) {
      return fallback;
    }
    return `${provider}/${override.model}`;
  } catch {
    return fallback;
  }
}

export async function replyWithDiscordModelPickerProviders(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  cfg: OpenClawConfig;
  command: DiscordModelPickerCommandContext;
  userId: string;
  accountId: string;
  threadBindings: ThreadBindingManager;
  preferFollowUp: boolean;
  safeInteractionCall: SafeDiscordInteractionCall;
}) {
  const route = await resolveDiscordModelPickerRoute({
    interaction: params.interaction,
    cfg: params.cfg,
    accountId: params.accountId,
    threadBindings: params.threadBindings,
  });
  const data = await loadDiscordModelPickerData(params.cfg, route.agentId);
  const currentModel = resolveDiscordModelPickerCurrentModel({
    cfg: params.cfg,
    route,
    data,
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: resolveDiscordModelPickerPreferenceScope({
      interaction: params.interaction,
      accountId: params.accountId,
      userId: params.userId,
    }),
    allowedModelRefs: buildDiscordModelPickerAllowedModelRefs(data),
    limit: 5,
  });
  const currentProvider = splitDiscordModelRef(currentModel ?? "")?.provider;
  const initialProvider =
    currentProvider && data.byProvider.has(currentProvider)
      ? currentProvider
      : (data.providers[0] ?? data.resolvedDefault.provider);

  const rendered = renderDiscordModelPickerModelsView({
    command: params.command,
    userId: params.userId,
    data,
    provider: initialProvider,
    page: 1,
    providerPage: 1,
    currentModel,
    quickModels,
  });
  const payload = {
    ...toDiscordModelPickerMessagePayload(rendered),
    ephemeral: true,
  };

  await params.safeInteractionCall("model picker reply", async () => {
    if (params.preferFollowUp) {
      await params.interaction.followUp(payload);
      return;
    }
    await params.interaction.reply(payload);
  });
}

export function splitDiscordModelRef(modelRef: string): { provider: string; model: string } | null {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}
