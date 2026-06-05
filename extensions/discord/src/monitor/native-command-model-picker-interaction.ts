// Discord plugin module implements native command model picker interaction behavior.
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  type ChatCommandDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
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
  findModelBucketId,
  findProviderBucketId,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
  type DiscordModelPickerState,
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

function resolveModelPickerRuntimeByIndex(params: {
  data: ModelsProviderData;
  provider?: string;
  runtimeIndex?: number;
}): string | undefined {
  if (!params.provider || typeof params.runtimeIndex !== "number") {
    return undefined;
  }
  const choices = params.data.runtimeChoicesByProvider?.get(params.provider);
  return choices?.[params.runtimeIndex - 1]?.id;
}

function resolveModelPickerProvider(params: {
  parsedProvider?: string;
  currentModelRef?: string | null;
  data: ModelsProviderData;
}): string {
  return (
    params.parsedProvider ??
    splitDiscordModelRef(params.currentModelRef ?? "")?.provider ??
    params.data.resolvedDefault.provider
  );
}

function resolveSelectedBucket(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | undefined {
  const raw = resolveModelPickerSelectionValue(interaction)?.toLowerCase();
  return raw && raw !== "all" ? raw : undefined;
}

function resolvePendingRuntime(params: {
  data: ModelsProviderData;
  provider: string;
  parsed: DiscordModelPickerState;
}): string | undefined {
  return (
    params.parsed.runtime ??
    resolveModelPickerRuntimeByIndex({
      data: params.data,
      provider: params.provider,
      runtimeIndex: params.parsed.runtimeIndex,
    })
  );
}

function resolveParsedRuntimeForSubmission(params: {
  data: ModelsProviderData;
  parsed: DiscordModelPickerState;
  selectedProvider: string;
}): string | undefined {
  if (params.parsed.runtime) {
    return params.parsed.runtime;
  }
  // runtimeIndex is compact state scoped to the provider encoded in the
  // custom_id. Recents can submit a model from another provider, so do not
  // decode that provider-local index against the wrong runtime choice list.
  if (params.parsed.provider !== params.selectedProvider) {
    return undefined;
  }
  return resolveModelPickerRuntimeByIndex({
    data: params.data,
    provider: params.selectedProvider,
    runtimeIndex: params.parsed.runtimeIndex,
  });
}

function resolveSubmittedModelRef(params: {
  data: ModelsProviderData;
  parsed: DiscordModelPickerState;
  quickModels: string[];
}): string | null {
  if (params.parsed.action === "reset") {
    return `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  }
  if (params.parsed.action === "quick") {
    const slot = params.parsed.recentSlot ?? 0;
    return slot >= 1 ? (params.quickModels[slot - 1] ?? null) : null;
  }
  if (params.parsed.view === "recents") {
    const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
    const dedupedRecents = params.quickModels.filter((ref) => ref !== defaultModelRef);
    const slot = params.parsed.recentSlot ?? 0;
    if (slot === 1) {
      return defaultModelRef;
    }
    return slot >= 2 ? (dedupedRecents[slot - 2] ?? null) : null;
  }

  const provider = params.parsed.provider;
  const selectedModel = resolveDiscordModelPickerModelByIndex({
    data: params.data,
    provider: provider ?? "",
    modelIndex: params.parsed.modelIndex,
  });
  return provider && selectedModel ? `${provider}/${selectedModel}` : null;
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

function resolveDiscordModelPickerRuntimeForProvider(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  runtime?: string;
  allowResetRuntime?: boolean;
}): string | undefined {
  const runtime = normalizeOptionalString(params.runtime);
  if (!runtime) {
    return undefined;
  }
  if (runtime === "auto" || runtime === "default") {
    return params.allowResetRuntime ? runtime : undefined;
  }
  const choices = params.data.runtimeChoicesByProvider?.get(params.provider);
  if (!choices?.length) {
    return runtime === "openclaw" ? runtime : undefined;
  }
  return choices.some((choice) => choice.id === runtime) ? runtime : undefined;
}

function resolveDiscordModelPickerSubmissionRuntime(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  parsedRuntime?: string;
  currentRuntime?: string;
}): string | undefined {
  return (
    resolveDiscordModelPickerRuntimeForProvider({
      data: params.data,
      provider: params.provider,
      runtime: params.parsedRuntime,
      allowResetRuntime: true,
    }) ??
    resolveDiscordModelPickerRuntimeForProvider({
      data: params.data,
      provider: params.provider,
      runtime: params.currentRuntime,
    })
  );
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
      runtime: parsed.runtime,
      runtimeIndex: parsed.runtimeIndex,
      provider: parsed.provider,
      page: parsed.page,
      providerPage: parsed.providerPage,
      modelBucket: parsed.modelBucket,
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
      providerBucket: parsed.providerBucket,
      currentModel: currentModelRef,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "nav" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      page: parsed.page,
      providerBucket: parsed.providerBucket,
      currentModel: currentModelRef,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "bucket" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      page: 1,
      providerBucket: resolveSelectedBucket(interaction),
      currentModel: currentModelRef,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "bucket" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider: parsed.provider,
      currentModelRef,
      data: pickerData,
    });
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: 1,
      providerPage: parsed.providerPage ?? 1,
      // bucket-action customId omits providerBucket to stay under 100
      // chars; derive from the picked provider on re-render.
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, provider),
      modelBucket: resolveSelectedBucket(interaction),
      currentModel: currentModelRef,
      currentRuntime,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "nav" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider: parsed.provider,
      currentModelRef,
      data: pickerData,
    });
    const pendingModel = resolveDiscordModelPickerModelByIndex({
      data: pickerData,
      provider,
      modelIndex: parsed.modelIndex,
    });
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, provider),
      modelBucket: parsed.modelBucket,
      currentModel: currentModelRef,
      currentRuntime,
      ...(pendingModel ? { pendingModel: `${provider}/${pendingModel}` } : {}),
      pendingModelIndex: parsed.modelIndex,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
      quickModels,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "back" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider: parsed.provider,
      currentModelRef,
      data: pickerData,
    });
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page ?? 1,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, provider),
      modelBucket: parsed.modelBucket,
      currentModel: currentModelRef,
      currentRuntime,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
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
      // Provider button customId no longer carries providerBucket;
      // derive from the picked provider so the bucket select stays in
      // sync on the next render.
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, selectedProvider),
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
    // The model select customId omits providerBucket/modelBucket to stay
    // under Discord's 100-char limit; derive both from the durable state.
    const derivedProviderBucket =
      parsed.providerBucket ?? findProviderBucketId(pickerData, provider);
    const derivedModelBucket =
      parsed.modelBucket ?? findModelBucketId(pickerData, provider, selectedModel);
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: derivedProviderBucket,
      modelBucket: derivedModelBucket,
      currentModel: currentModelRef,
      currentRuntime,
      pendingModel: modelRef,
      pendingModelIndex: modelIndex,
      pendingRuntime: resolvePendingRuntime({ data: pickerData, provider, parsed }),
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
    // Runtime select customId carries modelBucket only when no pending
    // model is set; otherwise derive from the pending model. As a final
    // fallback, derive from the user's current durable model so the
    // browse-bucket position survives a runtime change without anything
    // pending.
    const derivedProviderBucket =
      parsed.providerBucket ?? findProviderBucketId(pickerData, provider);
    const currentModelOnly = splitDiscordModelRef(currentModelRef ?? "");
    const derivedModelBucket =
      parsed.modelBucket ??
      (selectedModel
        ? findModelBucketId(pickerData, provider, selectedModel)
        : currentModelOnly && currentModelOnly.provider === provider
          ? findModelBucketId(pickerData, provider, currentModelOnly.model)
          : undefined);
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: derivedProviderBucket,
      modelBucket: derivedModelBucket,
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
    const modelRef = resolveSubmittedModelRef({ data: pickerData, parsed, quickModels });
    const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
    if (
      !parsedModelRef ||
      !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)
    ) {
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
    const selectedRuntime = resolveDiscordModelPickerSubmissionRuntime({
      data: pickerData,
      provider: parsedModelRef.provider,
      parsedRuntime: resolveParsedRuntimeForSubmission({
        data: pickerData,
        parsed,
        selectedProvider: parsedModelRef.provider,
      }),
      currentRuntime,
    });
    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      modelRef: resolvedModelRef,
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
      selectedRuntime,
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
