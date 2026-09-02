// Discord plugin module implements native command model picker interaction behavior.
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
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
  resolveDiscordModelPickerModelSelectionValue,
  resolveDiscordModelPickerProviderSelection,
  resolveDiscordModelPickerRuntimeSelectionValue,
  type DiscordModelPickerState,
} from "./model-picker.state.js";
import {
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
} from "./model-picker.view.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import { applyDiscordModelPickerSelection } from "./native-command-model-picker-apply.js";
import {
  buildDiscordModelPickerSelectionCommand,
  resolveDiscordModelPickerModelIndex,
  resolveDiscordModelPickerModelSelection,
  resolveDiscordModelPickerParsedRuntime,
  resolveDiscordModelPickerSubmissionRuntime,
  resolveSubmittedModelRef,
} from "./native-command-model-picker-resolution.js";
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

function resolveParsedRuntimeForSubmission(params: {
  parsed: DiscordModelPickerState;
  parsedRuntime?: string;
  parsedProvider?: string;
  selectedProvider: string;
}): string | undefined {
  if (params.parsed.runtime) {
    return params.parsed.runtime;
  }
  // Token and index state are scoped to the provider encoded in the custom_id.
  // Recents can submit another provider, so do not decode provider-local state
  // against the wrong runtime choice list.
  if (params.parsedProvider !== params.selectedProvider) {
    return undefined;
  }
  return params.parsedRuntime;
}

async function handleDiscordModelPickerInteraction(params: {
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

  const cfg = getRuntimeConfigSnapshot() ?? ctx.cfg;
  // Positional state from already-shipped picker messages has no catalog
  // fingerprint. A restart or catalog refresh can retarget the same index even
  // when the config object is unchanged, so only stable tokens may submit.
  const requireModelToken = true;
  const route = await resolveDiscordModelPickerRoute({
    interaction,
    cfg,
    accountId: ctx.accountId,
    threadBindings: ctx.threadBindings,
  });
  const pickerData = await loadDiscordModelPickerData(cfg, route.agentId);
  const parsedProvider = parsed.providerToken
    ? resolveDiscordModelPickerProviderSelection(pickerData, `p:${parsed.providerToken}`)
    : parsed.provider;
  const parsedRuntime = resolveDiscordModelPickerParsedRuntime({
    data: pickerData,
    provider: parsedProvider,
    parsed,
  });
  const currentModelRef = resolveDiscordModelPickerCurrentModel({
    cfg,
    route,
    data: pickerData,
  });
  const currentRuntime = resolveDiscordModelPickerCurrentRuntime({
    cfg,
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
  if (parsed.providerToken && !parsedProvider) {
    await showNotice("Sorry, that provider isn't available anymore.");
    return;
  }
  if (parsedRuntime === null) {
    await showNotice("Sorry, that runtime isn't available anymore.");
    return;
  }
  const updateModelsView = async (
    provider: string,
    state: Omit<
      Parameters<typeof renderDiscordModelPickerModelsView>[0],
      "command" | "userId" | "data" | "provider" | "currentModel" | "currentRuntime" | "quickModels"
    > = {},
  ) => {
    // Provider bucket is recoverable from durable catalog state, so compact
    // custom IDs do not need to carry it through every interaction.
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      providerBucket: parsed.providerBucket ?? findProviderBucketId(pickerData, provider),
      currentModel: currentModelRef,
      currentRuntime,
      quickModels,
      ...state,
    });
    return await updatePicker(toDiscordModelPickerMessagePayload(rendered));
  };

  if (parsed.action === "recents") {
    const rendered = renderDiscordModelPickerRecentsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      quickModels,
      currentModel: currentModelRef,
      runtime: parsedRuntime,
      provider: parsedProvider,
      page: parsed.page,
      providerPage: parsed.providerPage,
      modelBucket: parsed.modelBucket,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (
    parsed.view === "providers" &&
    (parsed.action === "back" || parsed.action === "nav" || parsed.action === "bucket")
  ) {
    const selectingBucket = parsed.action === "bucket";
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      page: selectingBucket ? 1 : parsed.page,
      providerBucket: selectingBucket ? resolveSelectedBucket(interaction) : parsed.providerBucket,
      currentModel: currentModelRef,
    });
    await updatePicker(toDiscordModelPickerMessagePayload(rendered));
    return;
  }

  if (parsed.action === "bucket" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider,
      currentModelRef,
      data: pickerData,
    });
    await updateModelsView(provider, {
      page: 1,
      modelBucket: resolveSelectedBucket(interaction),
      pendingRuntime: parsedRuntime,
    });
    return;
  }

  if (parsed.action === "nav" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider,
      currentModelRef,
      data: pickerData,
    });
    const pendingModel = resolveDiscordModelPickerModelSelection({
      data: pickerData,
      provider,
      modelIndex: parsed.modelIndex,
      modelToken: parsed.modelToken,
      requireModelToken,
    });
    if ((parsed.modelIndex || parsed.modelToken) && !pendingModel) {
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }
    const pendingModelIndex = pendingModel
      ? resolveDiscordModelPickerModelIndex({ data: pickerData, provider, model: pendingModel })
      : undefined;
    await updateModelsView(provider, {
      modelBucket: parsed.modelBucket,
      ...(pendingModel ? { pendingModel: `${provider}/${pendingModel}` } : {}),
      pendingModelIndex: pendingModelIndex ?? undefined,
      pendingRuntime: parsedRuntime,
    });
    return;
  }

  if (parsed.action === "back" && parsed.view === "models") {
    const provider = resolveModelPickerProvider({
      parsedProvider,
      currentModelRef,
      data: pickerData,
    });
    await updateModelsView(provider, {
      modelBucket: parsed.modelBucket,
      pendingRuntime: parsedRuntime,
    });
    return;
  }

  if (parsed.action === "provider") {
    const rawSelectedProvider = resolveModelPickerSelectionValue(interaction);
    const selectedProvider = rawSelectedProvider
      ? resolveDiscordModelPickerProviderSelection(pickerData, rawSelectedProvider)
      : parsedProvider;
    if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
      await showNotice("Sorry, that provider isn't available anymore.");
      return;
    }
    await updateModelsView(selectedProvider, {
      page: 1,
      providerPage: parsed.providerPage ?? parsed.page,
    });
    return;
  }

  if (parsed.action === "model") {
    const provider = parsedProvider;
    const selectedModel = provider
      ? resolveDiscordModelPickerModelSelectionValue({
          data: pickerData,
          provider,
          raw: resolveModelPickerSelectionValue(interaction) ?? "",
        })
      : undefined;
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
    const derivedModelBucket =
      parsed.modelBucket ?? findModelBucketId(pickerData, provider, selectedModel);
    await updateModelsView(provider, {
      modelBucket: derivedModelBucket,
      pendingModel: modelRef,
      pendingModelIndex: modelIndex,
      pendingRuntime: parsedRuntime,
    });
    return;
  }

  if (parsed.action === "runtime") {
    const provider = parsedProvider;
    const rawSelectedRuntime = resolveModelPickerSelectionValue(interaction);
    const selectedRuntime =
      provider && rawSelectedRuntime
        ? resolveDiscordModelPickerRuntimeSelectionValue({
            data: pickerData,
            provider,
            raw: rawSelectedRuntime,
          })
        : (parsedRuntime ?? "auto");
    if (!provider || !pickerData.byProvider.has(provider)) {
      await showNotice("Sorry, that provider isn't available anymore.");
      return;
    }
    if (!selectedRuntime) {
      await showNotice("Sorry, that runtime isn't available anymore.");
      return;
    }
    const selectedModel = resolveDiscordModelPickerModelSelection({
      data: pickerData,
      provider,
      modelIndex: parsed.modelIndex,
      modelToken: parsed.modelToken,
      requireModelToken,
    });
    if ((parsed.modelIndex || parsed.modelToken) && !selectedModel) {
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }
    const pendingModel = selectedModel ? `${provider}/${selectedModel}` : undefined;
    const pendingModelIndex = selectedModel
      ? resolveDiscordModelPickerModelIndex({ data: pickerData, provider, model: selectedModel })
      : undefined;
    // Runtime select customId carries modelBucket only when no pending
    // model is set; otherwise derive from the pending model. As a final
    // fallback, derive from the user's current durable model so the
    // browse-bucket position survives a runtime change without anything
    // pending.
    const currentModelOnly = splitDiscordModelRef(currentModelRef ?? "");
    const derivedModelBucket =
      parsed.modelBucket ??
      (selectedModel
        ? findModelBucketId(pickerData, provider, selectedModel)
        : currentModelOnly && currentModelOnly.provider === provider
          ? findModelBucketId(pickerData, provider, currentModelOnly.model)
          : undefined);
    await updateModelsView(provider, {
      modelBucket: derivedModelBucket,
      ...(pendingModel ? { pendingModel } : {}),
      pendingModelIndex: pendingModelIndex ?? undefined,
      pendingRuntime: selectedRuntime,
    });
    return;
  }

  if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
    const modelRef = resolveSubmittedModelRef({
      data: pickerData,
      parsed,
      parsedProvider,
      quickModels,
      requireModelToken,
    });
    const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
    if (
      !parsedModelRef ||
      !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)
    ) {
      await showNotice("That selection expired. Please choose a model again.");
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;
    const submittedRuntime = resolveParsedRuntimeForSubmission({
      parsed,
      parsedRuntime,
      parsedProvider,
      selectedProvider: parsedModelRef.provider,
    });
    const selectedRuntime = resolveDiscordModelPickerSubmissionRuntime({
      data: pickerData,
      provider: parsedModelRef.provider,
      parsedRuntime: submittedRuntime,
    });
    if (submittedRuntime && !selectedRuntime) {
      await showNotice("Sorry, that runtime isn't available anymore.");
      return;
    }
    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      modelRef: resolvedModelRef,
      runtime: selectedRuntime,
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
      cfg,
      discordConfig: ctx.discordConfig,
      accountId: ctx.accountId,
      sessionPrefix: ctx.sessionPrefix,
      threadBindings: ctx.threadBindings,
      dispatchReplyFromConfig: ctx.dispatchReplyFromConfig,
      route,
      resolvedModelRef,
      selectedRuntime,
      preferenceScope,
      settleMs: ctx.postApplySettleMs ?? 250,
      resolveCurrentModel: (currentRoute) =>
        resolveDiscordModelPickerCurrentModel({
          cfg,
          route: currentRoute,
          data: pickerData,
        }),
      resolveCurrentRuntime: (currentRoute) =>
        resolveDiscordModelPickerCurrentRuntime({
          cfg,
          route: currentRoute,
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
