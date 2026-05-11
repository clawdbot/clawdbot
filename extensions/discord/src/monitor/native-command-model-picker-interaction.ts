import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  type ChatCommandDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  Button,
  StringSelectMenu,
  type ButtonInteraction,
  type ComponentData,
  type MessagePayload,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import { readDiscordModelPickerRecentModels } from "./model-picker-preferences.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
} from "./model-picker.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import { applyDiscordModelPickerSelection } from "./native-command-model-picker-apply.js";
import {
  buildDiscordModelPickerAllowedModelRefs,
  buildDiscordModelPickerNoticePayload,
  resolveDiscordModelPickerCurrentModel,
  resolveDiscordModelPickerCurrentRuntime,
  resolveDiscordModelPickerPreferenceScope,
  resolveDiscordModelPickerRoute,
  splitDiscordModelRef,
} from "./native-command-model-picker-ui.js";
import type {
  DiscordModelPickerContext,
  SafeDiscordInteractionCall,
} from "./native-command-ui.types.js";

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
  runtime?: string;
}): { command: ChatCommandDefinition; args: CommandArgs; prompt: string } | null {
  const commandDefinition =
    findCommandByNativeName("model", "discord") ??
    listChatCommands().find((entry) => entry.key === "model");
  if (!commandDefinition) {
    return null;
  }
  const runtime = normalizeOptionalString(params.runtime);
  const raw = runtime ? `${params.modelRef} --runtime ${runtime}` : params.modelRef;
  const commandArgs: CommandArgs = {
    values: {
      model: params.modelRef,
    },
    raw,
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

  let deferredUpdate = interaction.acknowledged;
  if (!deferredUpdate) {
    const deferred = await params.safeInteractionCall("model picker defer", () =>
      interaction.acknowledge(),
    );
    if (deferred === null) {
      return;
    }
    deferredUpdate = true;
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
  const currentRuntime = resolveDiscordModelPickerCurrentRuntime({
    cfg: ctx.cfg,
    route,
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
  const updatePicker = async (payload: MessagePayload) =>
    await params.safeInteractionCall("model picker update", () =>
      deferredUpdate ? interaction.editReply(payload) : interaction.update(payload),
    );
  const showNotice = async (message: string) =>
    await updatePicker(buildDiscordModelPickerNoticePayload(message));

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
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
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
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
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
      currentRuntime,
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "provider") {
    const selectedProvider = resolveModelPickerSelectionValue(interaction) ?? parsed.provider;
    if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
      await showNotice("Sorry, that provider isn't available anymore.");
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
      currentRuntime,
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "model") {
    const selectedModel = resolveModelPickerSelectionValue(interaction);
    const provider = parsed.provider;
    if (!provider || !selectedModel) {
      await showNotice("Sorry, I couldn't read that model selection.");
      return;
    }
    const modelIndex = resolveDiscordModelPickerModelIndex({
      data: pickerData,
      provider,
      model: selectedModel,
    });
    if (!modelIndex) {
      await showNotice("Sorry, that model isn't available anymore.");
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
      currentRuntime,
      pendingModel: modelRef,
      pendingModelIndex: modelIndex,
      pendingRuntime: parsed.runtime,
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "runtime") {
    const selectedRuntime =
      resolveModelPickerSelectionValue(interaction) ?? parsed.runtime ?? "auto";
    const provider = parsed.provider;
    if (!provider || !pickerData.byProvider.has(provider)) {
      await showNotice("Sorry, that provider isn't available anymore.");
      return;
    }
    const selectedModel = resolveDiscordModelPickerModelByIndex({
      data: pickerData,
      provider,
      modelIndex: parsed.modelIndex,
    });
    const pendingModel = selectedModel ? `${provider}/${selectedModel}` : undefined;
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      currentModel: currentModelRef,
      currentRuntime,
      ...(pendingModel ? { pendingModel } : {}),
      pendingModelIndex: parsed.modelIndex,
      pendingRuntime: selectedRuntime,
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
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
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
    const parsedRuntime = normalizeOptionalString(parsed.runtime);
    const runtimeOverride =
      parsedRuntime ??
      (currentRuntime !== "auto" && currentRuntime !== "default" ? currentRuntime : undefined);
    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      modelRef: resolvedModelRef,
      runtime: runtimeOverride,
    });
    if (!selectionCommand) {
      await showNotice("Sorry, /model is unavailable right now.");
      return;
    }

    const updateResult = await showNotice(`Applying model change to ${resolvedModelRef}...`);
    if (updateResult === null) {
      return;
    }

    const applyResult = await applyDiscordModelPickerSelection({
      interaction,
      selectionCommand,
      dispatchCommandInteraction: params.dispatchCommandInteraction,
      cfg: ctx.cfg,
      discordConfig: ctx.discordConfig,
      accountId: ctx.accountId,
      sessionPrefix: ctx.sessionPrefix,
      threadBindings: ctx.threadBindings,
      route,
      resolvedModelRef,
      selectedProvider: parsedModelRef.provider,
      selectedModel: parsedModelRef.model,
      defaultProvider: pickerData.resolvedDefault.provider,
      defaultModel: pickerData.resolvedDefault.model,
      preferenceScope,
      settleMs: ctx.postApplySettleMs ?? 250,
      resolveCurrentModel: (currentRoute) =>
        resolveDiscordModelPickerCurrentModel({
          cfg: ctx.cfg,
          route: currentRoute,
          data: pickerData,
        }),
    });

    await params.safeInteractionCall("model picker follow-up", () =>
      interaction.followUp({
        ...buildDiscordModelPickerNoticePayload(applyResult.noticeMessage),
        ephemeral: true,
      }),
    );
    return;
  }

  if (parsed.action === "cancel") {
    const displayModel = currentModelRef ?? "default";
    await showNotice(`ℹ️ Model kept as ${displayModel}.`);
  }
}

type DiscordModelPickerFallbackParams = {
  ctx: DiscordModelPickerContext;
  safeInteractionCall: SafeDiscordInteractionCall;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
};

async function runDiscordModelPickerFallback(
  params: DiscordModelPickerFallbackParams & {
    interaction: ButtonInteraction | StringSelectMenuInteraction;
    data: ComponentData;
  },
) {
  await handleDiscordModelPickerInteraction(params);
}

class DiscordModelPickerFallbackButton extends Button {
  label = "modelpick";
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;

  constructor(private readonly params: DiscordModelPickerFallbackParams) {
    super();
  }

  override async run(interaction: ButtonInteraction, data: ComponentData) {
    await runDiscordModelPickerFallback({ ...this.params, interaction, data });
  }
}

class DiscordModelPickerFallbackSelect extends StringSelectMenu {
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
  options = [];

  constructor(private readonly params: DiscordModelPickerFallbackParams) {
    super();
  }

  override async run(interaction: StringSelectMenuInteraction, data: ComponentData) {
    await runDiscordModelPickerFallback({ ...this.params, interaction, data });
  }
}

export function createDiscordModelPickerFallbackButton(
  params: DiscordModelPickerFallbackParams,
): Button {
  return new DiscordModelPickerFallbackButton(params);
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerFallbackParams,
): StringSelectMenu {
  return new DiscordModelPickerFallbackSelect(params);
}
