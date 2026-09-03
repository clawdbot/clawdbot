import { html, nothing } from "lit";
import type { ModelCatalogEntry, SessionsListResult } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import {
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../../lib/chat/model-ref.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  type ChatFastModeSelectValue,
  type ChatFastModeTarget,
} from "../../../lib/chat/model-select-state.ts";
import {
  resolveChatThinkingSelectState,
  type ChatThinkingTarget,
} from "../../../lib/chat/thinking.ts";
import { renderChatEffortPicker } from "./chat-effort-picker.ts";
import type {
  ChatModelPickerOption,
  ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import { renderChatModelPicker, type ChatModelCatalogState } from "./chat-model-picker.ts";

export type { ChatModelCatalogState } from "./chat-model-picker.ts";

type ChatContextWindowTarget = Pick<
  SessionsListResult["defaults"],
  "contextWindow" | "contextWindows" | "contextWindowDefault"
>;

type ChatModelControlsProps = {
  activeRunId: string | null;
  agentDefaultModel?: string;
  connected: boolean;
  gatewayAvailable: boolean;
  loading: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelCatalogState?: ChatModelCatalogState;
  modelOverrides?: Readonly<Record<string, string | null | undefined>>;
  modelSelectionLocked?: boolean;
  modelSelectionRuntimeId?: string;
  modelSelectionTarget?: SessionsListResult["defaults"]["modelSelectionTarget"];
  modelPickerTargetGroups?: readonly ChatModelPickerTargetGroup[];
  modelPickerOpen?: boolean;
  modelSwitching: boolean;
  modelsLoading?: boolean;
  modelMutationDisabledReason?: string;
  effortMutationDisabledReason?: string;
  fastModeTarget?: ChatFastModeTarget;
  sending: boolean;
  sessionKey: string;
  selectedSession: SessionsListResult["sessions"][number] | undefined;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  contextWindowTarget?: ChatContextWindowTarget;
  thinkingDefaults?: SessionsListResult["defaults"];
  thinkingSession?: ChatThinkingTarget;
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onContextWindowSelect?: (value: string, sessionKey: string) => unknown;
  onModelSetup?: () => void;
  onModelPickerOpen?: () => unknown;
  onModelPickerOpenChange?: (open: boolean) => void;
  onModelSelect?: (value: string, sessionKey: string) => unknown;
  onModelPickerTargetRetry?: (groupId: string) => unknown;
  onModelPickerTargetSelect?: (groupId: string, value: string) => unknown;
  onRequestUpdate?: () => void;
  onThinkingSelect?: (value: string, sessionKey: string) => unknown;
};

const CHAT_MODEL_PROVIDER_GROUP_ALIASES: Readonly<Record<string, string>> = {
  "google-gemini-cli": "google",
  "moonshot-ai": "moonshot",
  moonshotai: "moonshot",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
};

function normalizeChatModelProviderGroupId(provider: string): string {
  const normalized = normalizeChatModelProviderId(provider);
  return CHAT_MODEL_PROVIDER_GROUP_ALIASES[normalized] ?? normalized;
}

function resolveChatModelProvider(
  value: string,
  catalog: ModelCatalogEntry[],
  fallbackValue = "",
  providerHint = "",
): string {
  const modelRef = (value || fallbackValue).trim();
  const normalizedModelRef = modelRef.toLowerCase();
  const qualifiedCatalogEntry = catalog.find((entry) => {
    const normalizedId = entry.id.trim().toLowerCase();
    const normalizedProvider = normalizeChatModelProviderId(entry.provider);
    return `${normalizedProvider}/${normalizedId}` === normalizedModelRef;
  });
  if (qualifiedCatalogEntry) {
    return normalizeChatModelProviderGroupId(qualifiedCatalogEntry.provider);
  }
  const idMatches = catalog.filter((entry) => entry.id.trim().toLowerCase() === normalizedModelRef);
  const normalizedHint = normalizeChatModelProviderId(providerHint);
  const hintOwnsRawId = idMatches.some(
    (entry) => normalizeChatModelProviderId(entry.provider) === normalizedHint,
  );
  if (normalizedHint && (idMatches.length === 0 || hintOwnsRawId)) {
    return normalizeChatModelProviderGroupId(normalizedHint);
  }
  if (idMatches.length === 1) {
    return normalizeChatModelProviderGroupId(idMatches[0]?.provider ?? "");
  }
  const separator = modelRef.indexOf("/");
  if (separator > 0) {
    return normalizeChatModelProviderGroupId(modelRef.slice(0, separator));
  }
  return "other";
}

function resolveChatModelCatalogEntry(
  value: string,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry | undefined {
  const trimmedValue = value.trim().toLowerCase();
  const separator = trimmedValue.indexOf("/");
  const normalizedValue =
    separator > 0
      ? `${normalizeChatModelProviderId(trimmedValue.slice(0, separator))}/${trimmedValue.slice(
          separator + 1,
        )}`
      : trimmedValue;
  if (!normalizedValue) {
    return undefined;
  }
  const matches = catalog.filter((candidate) => {
    const provider = normalizeChatModelProviderId(candidate.provider);
    return `${provider}/${candidate.id.trim().toLowerCase()}` === normalizedValue;
  });
  if (matches.length > 0) {
    return (
      matches.find((candidate) => candidate.provider.trim().toLowerCase() === "openai") ??
      matches[0]
    );
  }
  const idMatches = catalog.filter(
    (candidate) => candidate.id.trim().toLowerCase() === normalizedValue,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function resolveChatModelPickerLabel(
  value: string,
  fallbackLabel: string,
  catalog: ModelCatalogEntry[],
): string {
  const entry = resolveChatModelCatalogEntry(value, catalog);
  if (entry && normalizeChatModelProviderId(entry.provider) === "openai") {
    return entry.name.trim() || fallbackLabel;
  }
  return fallbackLabel;
}

function formatPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function resolveModelSelectionScopeDescription(
  target: SessionsListResult["defaults"]["modelSelectionTarget"],
): string | undefined {
  switch (target) {
    case "session":
      return t("chat.modelControls.selectionScopeSession");
    case "agent":
      return t("chat.modelControls.selectionScopeAgent");
    case "global":
      return t("chat.modelControls.selectionScopeGlobal");
    default:
      return undefined;
  }
}

function resolveCatalogTriggerStatus(
  state: ChatModelCatalogState,
  optionCount: number,
  selectionKnown: boolean,
): string | undefined {
  if (state.status === "offline") {
    return undefined;
  }
  if (state.status === "error") {
    return optionCount === 0 ? t("chat.modelControls.modelsUnavailable") : undefined;
  }
  if (!state.hasSnapshot && ["idle", "loading"].includes(state.status)) {
    return selectionKnown ? undefined : t("chat.modelControls.loadingModels");
  }
  if (state.hasSnapshot && optionCount === 0) {
    return t("chat.modelControls.noModelsAvailable");
  }
  return undefined;
}

export function renderChatModelControls(props: ChatModelControlsProps) {
  const {
    currentOverride,
    defaultModel,
    defaultLabel,
    modelOverrideSource,
    options: selectOptions,
  } = resolveChatModelSelectState({
    activeSession: props.selectedSession,
    agentDefaultModel: props.agentDefaultModel,
    chatModelCatalog: props.modelCatalog,
    modelOverrides: props.modelOverrides ?? {},
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const thinking = resolveChatThinkingSelectState({
    catalog: props.modelCatalog,
    defaults: props.thinkingDefaults,
    session: props.thinkingSession,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const resolvedFastMode = resolveChatFastModeSelectState({
    activeRunId: props.activeRunId,
    catalog: props.modelCatalog,
    connected: props.connected,
    currentModelOverride: currentOverride,
    fastModeTarget: props.fastModeTarget ?? props.selectedSession,
    gatewayAvailable: props.gatewayAvailable,
    loading: props.loading,
    sending: props.sending,
    sessionsResult: props.sessionsResult,
    stream: props.stream,
  });
  // Reasoning/fast state still describes the previous model until the refreshed
  // session row lands. Lock both so stale levels cannot be committed mid-switch.
  const fastMode = props.modelSwitching
    ? { ...resolvedFastMode, disabled: true }
    : resolvedFastMode;
  const activeSession = props.selectedSession;
  const currentProviderHint = activeSession?.modelProvider ?? "";
  const defaultProviderHint = props.sessionsResult?.defaults?.modelProvider ?? "";
  const defaultCatalogEntry = resolveChatModelCatalogEntry(defaultModel, props.modelCatalog);
  const canonicalDefaultLabel = resolveChatModelPickerLabel(
    defaultModel,
    defaultLabel,
    props.modelCatalog,
  );
  const pickerDefaultLabel =
    defaultModel && canonicalDefaultLabel !== defaultLabel
      ? t("chat.modelControls.defaultWithModel", { model: canonicalDefaultLabel })
      : defaultLabel;
  const normalizedDefaultModel = defaultModel.trim().toLowerCase();
  const modelOptions: ChatModelPickerOption[] = selectOptions.map((option) => {
    const catalogEntry = resolveChatModelCatalogEntry(option.value, props.modelCatalog);
    const isDefault =
      option.value.trim().toLowerCase() === normalizedDefaultModel ||
      (catalogEntry !== undefined && catalogEntry === defaultCatalogEntry);
    // Runtime meta labels only operator-pinned runtimes (models/provider config);
    // implicit/default resolution stays unlabeled so ordinary rows stay clean.
    const agentRuntime = catalogEntry?.agentRuntime;
    const agentRuntimeId =
      agentRuntime && (agentRuntime.source === "model" || agentRuntime.source === "provider")
        ? agentRuntime.id.trim()
        : undefined;
    const pickerOption: ChatModelPickerOption = {
      commitValue: isDefault ? "" : option.value,
      isDefault,
      value: option.value,
      label: resolveChatModelPickerLabel(option.value, option.label, props.modelCatalog),
      provider: resolveChatModelProvider(
        option.value,
        props.modelCatalog,
        "",
        isDefault
          ? defaultProviderHint
          : option.value === currentOverride
            ? currentProviderHint
            : "",
      ),
    };
    if (agentRuntimeId) {
      pickerOption.agentRuntimeId = agentRuntimeId;
    }
    if (catalogEntry?.contextWindow) {
      pickerOption.contextWindow = catalogEntry.contextWindow;
    }
    if (typeof catalogEntry?.supportsTools === "boolean") {
      pickerOption.supportsTools = catalogEntry.supportsTools;
    }
    if (option.disabled) {
      pickerOption.disabled = true;
      pickerOption.unavailableReason = option.unavailableReason;
    }
    return pickerOption;
  });
  const currentCatalogEntry = resolveChatModelCatalogEntry(currentOverride, props.modelCatalog);
  if (
    currentOverride &&
    modelOptions.length > 0 &&
    !modelOptions.some((option) => option.value === currentOverride)
  ) {
    modelOptions.push({
      commitValue: currentOverride,
      ...(currentCatalogEntry?.contextWindow
        ? { contextWindow: currentCatalogEntry.contextWindow }
        : {}),
      ...(typeof currentCatalogEntry?.supportsTools === "boolean"
        ? { supportsTools: currentCatalogEntry.supportsTools }
        : {}),
      ...(currentCatalogEntry?.available === false
        ? { disabled: true, unavailableReason: currentCatalogEntry.unavailableReason }
        : {}),
      isDefault: false,
      value: currentOverride,
      label: currentCatalogEntry?.name.trim() || currentOverride,
      provider: resolveChatModelProvider(
        currentOverride,
        props.modelCatalog,
        "",
        currentProviderHint,
      ),
    });
  }
  // A persisted pin can match a changed default; equality cannot establish inheritance.
  const pickerValue = modelOverrideSource === null ? "" : currentOverride;
  const activeModelOption =
    pickerValue === ""
      ? modelOptions.find((option) => option.isDefault)
      : modelOptions.find((option) => option.value === pickerValue);
  const activeSessionModel = activeSession?.model
    ? resolveChatModelCatalogEntry(
        resolvePreferredServerChatModelValue(
          activeSession.model,
          activeSession.modelProvider,
          props.modelCatalog,
        ),
        props.modelCatalog,
      )
    : undefined;
  const activeOptionModel = activeModelOption
    ? resolveChatModelCatalogEntry(activeModelOption.value, props.modelCatalog)
    : undefined;
  const activeSessionRuntime = activeSession?.agentRuntime?.id.trim().toLowerCase();
  const activeOptionRuntime = (
    activeOptionModel?.agentRuntime?.id ??
    (activeModelOption?.isDefault ? props.sessionsResult?.defaults?.agentRuntime?.id : undefined)
  )
    ?.trim()
    .toLowerCase();
  const activeRuntimeMatches =
    Boolean(activeSessionRuntime) && activeSessionRuntime === activeOptionRuntime;
  // Missing or mismatched current-selection provenance cannot bind the cached
  // session window. Even matching provenance is useful only after the switch settles.
  if (
    !props.modelSwitching &&
    activeModelOption &&
    activeSession?.contextTokens &&
    activeRuntimeMatches &&
    activeSessionModel !== undefined &&
    activeSessionModel === activeOptionModel
  ) {
    activeModelOption.contextTokens = activeSession.contextTokens;
  }
  const lockedModelLabel =
    props.modelSelectionRuntimeId?.trim().toLowerCase() === "codex"
      ? t("chat.selectors.nativeCodexModel")
      : t("chat.selectors.lockedSessionModel");
  const committedModelLabel =
    props.modelSelectionLocked === true
      ? lockedModelLabel
      : (modelOptions.find((entry) => entry.value === currentOverride)?.label ??
        resolveChatModelPickerLabel(
          currentOverride,
          currentOverride || pickerDefaultLabel,
          props.modelCatalog,
        ));
  const managedCatalog = props.modelCatalogState ?? {
    hasSnapshot: !props.modelsLoading,
    status: props.modelsLoading ? ("loading" as const) : ("ready" as const),
  };
  const catalogLoadingWithoutSnapshot =
    !managedCatalog.hasSnapshot && ["idle", "loading"].includes(managedCatalog.status);
  // The session owns the selected model; its account-scoped catalog only owns
  // picker availability. Refreshing that catalog must not hide a known selection.
  const selectionKnown = Boolean(currentOverride || (modelOverrideSource === null && defaultModel));
  const catalogTriggerStatus = resolveCatalogTriggerStatus(
    managedCatalog,
    modelOptions.length,
    selectionKnown,
  );
  // A verified-empty catalog means there is nothing to reason about: the effort
  // picker would only steer a model that cannot be selected, so it hides with it.
  const hasResolvableModel =
    managedCatalog.status === "ready" &&
    (modelOptions.some((option) => !option.disabled) ||
      (props.modelSelectionLocked === true && activeModelOption !== undefined));
  const busy =
    props.loading || props.sending || Boolean(props.activeRunId) || props.stream !== null;
  const commonDisabled =
    !props.connected || busy || props.modelSwitching || !props.gatewayAvailable;
  const effortMutationDisabled = Boolean(props.effortMutationDisabledReason);
  // Loading owns the menu contents, not the trigger. Keeping the trigger
  // interactive lets the first gesture open the picker and observe that state.
  const modelDisabled = commonDisabled || Boolean(props.modelMutationDisabledReason);
  const thinkingDisabled =
    commonDisabled ||
    effortMutationDisabled ||
    !managedCatalog.hasSnapshot ||
    (thinking.options.length === 0 && thinking.selection.source === "default");
  // One owner supplies the whole tuple: mixing an override session's fields with
  // the defaults row can render the default model's options for a session whose
  // model declares none, then patch an invalid option id.
  const contextWindowOwner =
    props.contextWindowTarget ?? activeSession ?? props.sessionsResult?.defaults;
  const contextWindows = contextWindowOwner?.contextWindows ?? [];
  const selectedContextWindow =
    contextWindowOwner?.contextWindow ?? contextWindowOwner?.contextWindowDefault ?? "";
  const defaultContextWindow = contextWindowOwner?.contextWindowDefault;
  const effortDisabled =
    commonDisabled ||
    effortMutationDisabled ||
    (thinking.options.length === 0 && fastMode.disabled);
  // Floating UI deliberately tracks a live anchor. Keep the eventual effort
  // control in layout while catalog state is transient (and until an open model
  // menu closes), so a sibling appearing cannot move that anchor mid-interaction.
  const reserveEffortPicker =
    !hasResolvableModel && (catalogLoadingWithoutSnapshot || props.modelPickerOpen === true);
  const showEffortPicker = hasResolvableModel || reserveEffortPicker;
  return html`
    <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
      ${renderChatModelPicker({
        contextWindow:
          contextWindows.length > 1
            ? {
                options: contextWindows,
                selected: selectedContextWindow,
                ...(defaultContextWindow ? { defaultId: defaultContextWindow } : {}),
                disabled: commonDisabled || effortMutationDisabled,
                onSelect: async (next, targetSessionKey) => {
                  await props.onContextWindowSelect?.(next, targetSessionKey);
                },
              }
            : undefined,
        defaultModelLabel: formatPickerModelLabel(pickerDefaultLabel),
        disabled: modelDisabled,
        disabledReason: props.modelMutationDisabledReason,
        modelCatalogState: managedCatalog,
        open: props.modelPickerOpen,
        modelSelectionLocked: props.modelSelectionLocked === true,
        selectionScopeDescription: resolveModelSelectionScopeDescription(
          props.modelSelectionTarget,
        ),
        modelOptions,
        targetGroups: props.modelPickerTargetGroups,
        selectedModelValue: pickerValue,
        sessionModelPinned: modelOverrideSource === "user",
        sessionKey: props.sessionKey,
        triggerModelLabel: formatPickerModelLabel(committedModelLabel),
        triggerStatusLabel: catalogTriggerStatus,
        triggerLoading: catalogLoadingWithoutSnapshot && !selectionKnown,
        onModelSetup: props.onModelSetup,
        onOpen: props.onModelPickerOpen,
        onOpenChange: props.onModelPickerOpenChange,
        onModelSelect: async (next, targetSessionKey) =>
          props.onModelSelect?.(next, targetSessionKey),
        onTargetRetry: props.onModelPickerTargetRetry,
        onTargetSelect: props.onModelPickerTargetSelect,
        onRequestUpdate: props.onRequestUpdate,
      })}
      ${!showEffortPicker
        ? nothing
        : renderChatEffortPicker({
            disabled: effortDisabled,
            disabledReason: props.effortMutationDisabledReason,
            fastMode: {
              ...fastMode,
              disabled: fastMode.disabled || commonDisabled || effortMutationDisabled,
            },
            sessionKey: props.sessionKey,
            thinkingDisabled,
            thinking,
            onFastModeSelect: async (next, targetSessionKey) =>
              props.onFastModeSelect?.(next, targetSessionKey),
            onRequestUpdate: props.onRequestUpdate,
            onThinkingSelect: async (next, targetSessionKey) =>
              props.onThinkingSelect?.(next, targetSessionKey),
            reserved: reserveEffortPicker,
          })}
    </div>
  `;
}
