import {
  Button,
  Container,
  Row,
  StringSelectMenu,
  TextDisplay,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  type ComponentData,
  type StringSelectMenuInteraction,
} from "@buape/carbon";
import { ButtonStyle } from "discord-api-types/v10";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  resolveStoredModelOverride,
  serializeCommandArgs,
  type ChatCommandDefinition,
  type CommandArgDefinition,
  type CommandArgValues,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  chunkItems,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  withTimeout,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import {
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
  type DiscordModelPickerCommandContext,
} from "./model-picker.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";

export type DiscordCommandArgContext = {
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
};

export type DiscordModelPickerContext = DiscordCommandArgContext;

export type DispatchDiscordCommandInteractionParams = {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
  threadBindings: ThreadBindingManager;
  responseEphemeral?: boolean;
  suppressReplies?: boolean;
};

export type DispatchDiscordCommandInteraction = (
  params: DispatchDiscordCommandInteractionParams,
) => Promise<void>;

export type SafeDiscordInteractionCall = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T | null>;

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

export function buildDiscordCommandArgCustomId(params: {
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
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawCommand = coerce(data.command);
  const rawArg = coerce(data.arg);
  const rawValue = coerce(data.value);
  const rawUser = coerce(data.user);
  if (!rawCommand || !rawArg || !rawValue || !rawUser) {
    return null;
  }
  return {
    command: decodeDiscordCommandArgValue(rawCommand),
    arg: decodeDiscordCommandArgValue(rawArg),
    value: decodeDiscordCommandArgValue(rawValue),
    userId: decodeDiscordCommandArgValue(rawUser),
  };
}

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

function buildDiscordModelPickerAllowedModelRefs(
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

function resolveDiscordModelPickerPreferenceScope(params: {
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

function buildDiscordModelPickerNoticePayload(message: string): { components: Container[] } {
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
  cfg: ReturnType<typeof loadConfig>;
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

async function resolveDiscordModelPickerRoute(params: {
  interaction:
    | CommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | AutocompleteInteraction;
  cfg: ReturnType<typeof loadConfig>;
  accountId: string;
  threadBindings: ThreadBindingManager;
}) {
  const resolved = await resolveDiscordModelPickerRouteState(params);
  return resolved.effectiveRoute;
}

export async function resolveDiscordNativeChoiceContext(params: {
  interaction: AutocompleteInteraction;
  cfg: ReturnType<typeof loadConfig>;
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

function resolveDiscordModelPickerCurrentModel(params: {
  cfg: ReturnType<typeof loadConfig>;
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
  cfg: ReturnType<typeof loadConfig>;
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

  const rendered = renderDiscordModelPickerModelsView({
    command: params.command,
    userId: params.userId,
    data,
    provider: splitDiscordModelRef(currentModel ?? "")?.provider ?? data.resolvedDefault.provider,
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

function resolveModelPickerSelectionValue(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | null {
  const rawValues = (interaction as { values?: string[] }).values;
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    return null;
  }
  const first = rawValues[0];
  if (typeof first !== "string") {
    return null;
  }
  const trimmed = first.trim();
  return trimmed || null;
}

function buildDiscordModelPickerSelectionCommand(params: {
  modelRef: string;
}): { command: ChatCommandDefinition; args: CommandArgs; prompt: string } | null {
  const commandDefinition =
    findCommandByNativeName("model", "discord") ??
    listChatCommands().find((entry) => entry.key === "model");
  if (!commandDefinition) {
    return null;
  }
  const commandArgs: CommandArgs = {
    values: {
      model: params.modelRef,
    },
    raw: params.modelRef,
  };
  return {
    command: commandDefinition,
    args: commandArgs,
    prompt: buildCommandTextFromArgs(commandDefinition, commandArgs),
  };
}

function listDiscordModelPickerProviderModels(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
  provider: string,
): string[] {
  const modelSet = data.byProvider.get(provider);
  if (!modelSet) {
    return [];
  }
  return [...modelSet].toSorted();
}

function resolveDiscordModelPickerModelIndex(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  model: string;
}): number | null {
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  const index = models.indexOf(params.model);
  if (index < 0) {
    return null;
  }
  return index + 1;
}

function resolveDiscordModelPickerModelByIndex(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  modelIndex?: number;
}): string | null {
  if (!params.modelIndex || params.modelIndex < 1) {
    return null;
  }
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  return models[params.modelIndex - 1] ?? null;
}

function splitDiscordModelRef(modelRef: string): { provider: string; model: string } | null {
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

export async function handleDiscordModelPickerInteraction(params: {
  interaction: ButtonInteraction | StringSelectMenuInteraction;
  data: ComponentData;
  ctx: DiscordModelPickerContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}) {
  const { interaction, data, ctx } = params;
  const parsed = parseDiscordModelPickerData(data);
  if (!parsed) {
    await params.safeInteractionCall("model picker update", () =>
      interaction.update(
        buildDiscordModelPickerNoticePayload(
          "Sorry, that model picker interaction is no longer available.",
        ),
      ),
    );
    return;
  }

  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await params.safeInteractionCall("model picker ack", () => interaction.acknowledge());
    return;
  }

  const route = await resolveDiscordModelPickerRoute({
    interaction,
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    threadBindings: ctx.threadBindings,
  });
  const pickerData = await loadDiscordModelPickerData(ctx.cfg, route.agentId);
  const currentModelRef = resolveDiscordModelPickerCurrentModel({
    cfg: ctx.cfg,
    route,
    data: pickerData,
  });
  const allowedModelRefs = buildDiscordModelPickerAllowedModelRefs(pickerData);
  const preferenceScope = resolveDiscordModelPickerPreferenceScope({
    interaction,
    accountId: ctx.accountId,
    userId: parsed.userId,
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: preferenceScope,
    allowedModelRefs,
    limit: 5,
  });

  if (parsed.action === "recents") {
    const rendered = renderDiscordModelPickerRecentsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      quickModels,
      currentModel: currentModelRef,
      provider: parsed.provider,
      page: parsed.page,
      providerPage: parsed.providerPage,
    });

    await params.safeInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "back" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      page: parsed.page,
      currentModel: currentModelRef,
    });

    await params.safeInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "back" && parsed.view === "models") {
    const provider =
      parsed.provider ??
      splitDiscordModelRef(currentModelRef ?? "")?.provider ??
      pickerData.resolvedDefault.provider;

    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page ?? 1,
      providerPage: parsed.providerPage ?? 1,
      currentModel: currentModelRef,
      quickModels,
    });

    await params.safeInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "provider") {
    const selectedProvider = resolveModelPickerSelectionValue(interaction) ?? parsed.provider;
    if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
      await params.safeInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, that provider isn't available anymore."),
        ),
      );
      return;
    }

    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider: selectedProvider,
      page: 1,
      providerPage: parsed.providerPage ?? parsed.page,
      currentModel: currentModelRef,
      quickModels,
    });

    await params.safeInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "model") {
    const selectedModel = resolveModelPickerSelectionValue(interaction);
    const provider = parsed.provider;
    if (!provider || !selectedModel) {
      await params.safeInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, I couldn't read that model selection."),
        ),
      );
      return;
    }

    const modelIndex = resolveDiscordModelPickerModelIndex({
      data: pickerData,
      provider,
      model: selectedModel,
    });
    if (!modelIndex) {
      await params.safeInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, that model isn't available anymore."),
        ),
      );
      return;
    }

    const modelRef = `${provider}/${selectedModel}`;
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      currentModel: currentModelRef,
      pendingModel: modelRef,
      pendingModelIndex: modelIndex,
      quickModels,
    });

    await params.safeInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
    let modelRef: string | null = null;

    if (parsed.action === "reset") {
      modelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
    } else if (parsed.action === "quick") {
      const slot = parsed.recentSlot ?? 0;
      modelRef = slot >= 1 ? (quickModels[slot - 1] ?? null) : null;
    } else if (parsed.view === "recents") {
      const defaultModelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
      const dedupedRecents = quickModels.filter((ref) => ref !== defaultModelRef);
      const slot = parsed.recentSlot ?? 0;
      if (slot === 1) {
        modelRef = defaultModelRef;
      } else if (slot >= 2) {
        modelRef = dedupedRecents[slot - 2] ?? null;
      }
    } else {
      const provider = parsed.provider;
      const selectedModel = resolveDiscordModelPickerModelByIndex({
        data: pickerData,
        provider: provider ?? "",
        modelIndex: parsed.modelIndex,
      });
      modelRef = provider && selectedModel ? `${provider}/${selectedModel}` : null;
    }
    const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
    if (
      !parsedModelRef ||
      !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)
    ) {
      await params.safeInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload(
            "That selection expired. Please choose a model again.",
          ),
        ),
      );
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;

    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      modelRef: resolvedModelRef,
    });
    if (!selectionCommand) {
      await params.safeInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, /model is unavailable right now."),
        ),
      );
      return;
    }

    const updateResult = await params.safeInteractionCall("model picker update", () =>
      interaction.update(
        buildDiscordModelPickerNoticePayload(`Applying model change to ${resolvedModelRef}...`),
      ),
    );
    if (updateResult === null) {
      return;
    }

    try {
      await withTimeout(
        params.dispatchCommandInteraction({
          interaction,
          prompt: selectionCommand.prompt,
          command: selectionCommand.command,
          commandArgs: selectionCommand.args,
          cfg: ctx.cfg,
          discordConfig: ctx.discordConfig,
          accountId: ctx.accountId,
          sessionPrefix: ctx.sessionPrefix,
          preferFollowUp: true,
          threadBindings: ctx.threadBindings,
          suppressReplies: true,
        }),
        12000,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        await params.safeInteractionCall("model picker follow-up", () =>
          interaction.followUp({
            ...buildDiscordModelPickerNoticePayload(
              `⏳ Model change to ${resolvedModelRef} is still processing. Check /status in a few seconds.`,
            ),
            ephemeral: true,
          }),
        );
        return;
      }

      await params.safeInteractionCall("model picker follow-up", () =>
        interaction.followUp({
          ...buildDiscordModelPickerNoticePayload(
            `❌ Failed to apply ${resolvedModelRef}. Try /model ${resolvedModelRef} directly.`,
          ),
          ephemeral: true,
        }),
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    const effectiveModelRef = resolveDiscordModelPickerCurrentModel({
      cfg: ctx.cfg,
      route,
      data: pickerData,
    });
    const persisted = effectiveModelRef === resolvedModelRef;

    if (!persisted) {
      logVerbose(
        `discord: model picker override mismatch — expected ${resolvedModelRef} but read ${effectiveModelRef} from session key ${route.sessionKey}`,
      );
    }

    if (persisted) {
      await recordDiscordModelPickerRecentModel({
        scope: preferenceScope,
        modelRef: resolvedModelRef,
        limit: 5,
      }).catch(() => undefined);
    }

    await params.safeInteractionCall("model picker follow-up", () =>
      interaction.followUp({
        ...buildDiscordModelPickerNoticePayload(
          persisted
            ? `✅ Model set to ${resolvedModelRef}.`
            : `⚠️ Tried to set ${resolvedModelRef}, but current model is ${effectiveModelRef}.`,
        ),
        ephemeral: true,
      }),
    );
    return;
  }

  if (parsed.action === "cancel") {
    const displayModel = currentModelRef ?? "default";
    await params.safeInteractionCall("model picker update", () =>
      interaction.update(buildDiscordModelPickerNoticePayload(`ℹ️ Model kept as ${displayModel}.`)),
    );
  }
}

export async function handleDiscordCommandArgInteraction(params: {
  interaction: ButtonInteraction;
  data: ComponentData;
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}) {
  const { interaction, data, ctx } = params;
  const parsed = parseDiscordCommandArgData(data);
  if (!parsed) {
    await params.safeInteractionCall("command arg update", () =>
      interaction.update({
        content: "Sorry, that selection is no longer available.",
        components: [],
      }),
    );
    return;
  }
  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await params.safeInteractionCall("command arg ack", () => interaction.acknowledge());
    return;
  }
  const commandDefinition =
    findCommandByNativeName(parsed.command, "discord") ??
    listChatCommands().find((entry) => entry.key === parsed.command);
  if (!commandDefinition) {
    await params.safeInteractionCall("command arg update", () =>
      interaction.update({
        content: "Sorry, that command is no longer available.",
        components: [],
      }),
    );
    return;
  }
  const argUpdateResult = await params.safeInteractionCall("command arg update", () =>
    interaction.update({
      content: `✅ Selected ${parsed.value}.`,
      components: [],
    }),
  );
  if (argUpdateResult === null) {
    return;
  }
  const commandArgs = createCommandArgsWithValue({
    argName: parsed.arg,
    value: parsed.value,
  });
  const commandArgsWithRaw: CommandArgs = {
    ...commandArgs,
    raw: serializeCommandArgs(commandDefinition, commandArgs),
  };
  const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
  await params.dispatchCommandInteraction({
    interaction,
    prompt,
    command: commandDefinition,
    commandArgs: commandArgsWithRaw,
    cfg: ctx.cfg,
    discordConfig: ctx.discordConfig,
    accountId: ctx.accountId,
    sessionPrefix: ctx.sessionPrefix,
    preferFollowUp: true,
    threadBindings: ctx.threadBindings,
    responseEphemeral: resolveDiscordSlashCommandConfig(ctx.discordConfig?.slashCommand).ephemeral,
  });
}

class DiscordCommandArgButton extends Button {
  label: string;
  customId: string;
  style = ButtonStyle.Secondary;
  private ctx: DiscordCommandArgContext;
  private safeInteractionCall: SafeDiscordInteractionCall;
  private dispatchCommandInteraction: DispatchDiscordCommandInteraction;

  constructor(params: {
    label: string;
    customId: string;
    ctx: DiscordCommandArgContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
  }) {
    super();
    this.label = params.label;
    this.customId = params.customId;
    this.ctx = params.ctx;
    this.safeInteractionCall = params.safeInteractionCall;
    this.dispatchCommandInteraction = params.dispatchCommandInteraction;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await handleDiscordCommandArgInteraction({
      interaction,
      data,
      ctx: this.ctx,
      safeInteractionCall: this.safeInteractionCall,
      dispatchCommandInteraction: this.dispatchCommandInteraction,
    });
  }
}

export function buildDiscordCommandArgMenu(params: {
  command: ChatCommandDefinition;
  menu: {
    arg: CommandArgDefinition;
    choices: Array<{ value: string; label: string }>;
    title?: string;
  };
  interaction: CommandInteraction;
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
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
          ctx: params.ctx,
          safeInteractionCall: params.safeInteractionCall,
          dispatchCommandInteraction: params.dispatchCommandInteraction,
        }),
    );
    return new Row(buttons);
  });
  const content =
    menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
  return { content, components: rows };
}

class DiscordCommandArgFallbackButton extends Button {
  label = "cmdarg";
  customId = "cmdarg:seed=1";
  private ctx: DiscordCommandArgContext;
  private safeInteractionCall: SafeDiscordInteractionCall;
  private dispatchCommandInteraction: DispatchDiscordCommandInteraction;

  constructor(params: {
    ctx: DiscordCommandArgContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
  }) {
    super();
    this.ctx = params.ctx;
    this.safeInteractionCall = params.safeInteractionCall;
    this.dispatchCommandInteraction = params.dispatchCommandInteraction;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await handleDiscordCommandArgInteraction({
      interaction,
      data,
      ctx: this.ctx,
      safeInteractionCall: this.safeInteractionCall,
      dispatchCommandInteraction: this.dispatchCommandInteraction,
    });
  }
}

class DiscordModelPickerFallbackButton extends Button {
  label = "modelpick";
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;
  private ctx: DiscordModelPickerContext;
  private safeInteractionCall: SafeDiscordInteractionCall;
  private dispatchCommandInteraction: DispatchDiscordCommandInteraction;

  constructor(params: {
    ctx: DiscordModelPickerContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
  }) {
    super();
    this.ctx = params.ctx;
    this.safeInteractionCall = params.safeInteractionCall;
    this.dispatchCommandInteraction = params.dispatchCommandInteraction;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await handleDiscordModelPickerInteraction({
      interaction,
      data,
      ctx: this.ctx,
      safeInteractionCall: this.safeInteractionCall,
      dispatchCommandInteraction: this.dispatchCommandInteraction,
    });
  }
}

class DiscordModelPickerFallbackSelect extends StringSelectMenu {
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
  options = [];
  private ctx: DiscordModelPickerContext;
  private safeInteractionCall: SafeDiscordInteractionCall;
  private dispatchCommandInteraction: DispatchDiscordCommandInteraction;

  constructor(params: {
    ctx: DiscordModelPickerContext;
    safeInteractionCall: SafeDiscordInteractionCall;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
  }) {
    super();
    this.ctx = params.ctx;
    this.safeInteractionCall = params.safeInteractionCall;
    this.dispatchCommandInteraction = params.dispatchCommandInteraction;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData) {
    await handleDiscordModelPickerInteraction({
      interaction,
      data,
      ctx: this.ctx,
      safeInteractionCall: this.safeInteractionCall,
      dispatchCommandInteraction: this.dispatchCommandInteraction,
    });
  }
}

export function createDiscordCommandArgFallbackButton(params: {
  ctx: DiscordCommandArgContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}): Button {
  return new DiscordCommandArgFallbackButton(params);
}

export function createDiscordModelPickerFallbackButton(params: {
  ctx: DiscordModelPickerContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}): Button {
  return new DiscordModelPickerFallbackButton(params);
}

export function createDiscordModelPickerFallbackSelect(params: {
  ctx: DiscordModelPickerContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
}): StringSelectMenu {
  return new DiscordModelPickerFallbackSelect(params);
}
