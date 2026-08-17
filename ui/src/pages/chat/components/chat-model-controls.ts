// Chat-owned model, reasoning, and fast-mode picker orchestration.
import { html } from "lit";
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
} from "../../../lib/chat/model-select-state.ts";
import {
  resolveChatThinkingSelectState,
  type ChatThinkingTarget,
} from "../../../lib/chat/thinking.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { renderChatEffortPicker } from "./chat-effort-picker.ts";
import type {
  ChatModelPickerOption,
  ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import { renderChatModelPicker, type ChatModelCatalogState } from "./chat-model-picker.ts";

export type { ChatModelCatalogState } from "./chat-model-picker.ts";

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
  modelPickerTargetGroups?: readonly ChatModelPickerTargetGroup[];
  modelSwitching: boolean;
  modelsLoading?: boolean;
  modelMutationDisabledReason?: string;
  effortMutationDisabledReason?: string;
  showFastMode?: boolean;
  sending: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  thinkingDefaults?: SessionsListResult["defaults"];
  thinkingSession?: ChatThinkingTarget;
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onModelSetup?: () => void;
  onModelPickerOpen?: () => unknown;
  onModelSelect?: (value: string, sessionKey: string) => unknown;
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

function modelAuthenticationNeededText(): string {
  return `${t("modelSetup.failure.auth")}. ${t("modelSetup.failureGuidance.auth")}`;
}

export function renderChatModelControls(props: ChatModelControlsProps) {
  const {
    currentOverride,
    defaultModel,
    defaultLabel,
    options: selectOptions,
  } = resolveChatModelSelectState({
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
    gatewayAvailable: props.gatewayAvailable,
    loading: props.loading,
    sending: props.sending,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
    stream: props.stream,
  });
  // Reasoning/fast state still describes the previous model until the refreshed
  // session row lands. Lock both so stale levels cannot be committed mid-switch.
  const fastMode = props.modelSwitching
    ? { ...resolvedFastMode, disabled: true }
    : resolvedFastMode;
  const activeSession = props.sessionsResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, props.sessionKey),
  );
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
    return {
      commitValue: isDefault ? "" : option.value,
      ...(agentRuntimeId ? { agentRuntimeId } : {}),
      ...(catalogEntry?.contextWindow ? { contextWindow: catalogEntry.contextWindow } : {}),
      ...(typeof catalogEntry?.supportsTools === "boolean"
        ? { supportsTools: catalogEntry.supportsTools }
        : {}),
      ...(option.disabled ? { disabled: true } : {}),
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
  });
  const explicitOverride = props.modelOverrides?.[props.sessionKey];
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
      ...(currentCatalogEntry?.available === false ? { disabled: true } : {}),
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
  const pickerValue =
    !explicitOverride && currentOverride.trim().toLowerCase() === defaultModel.trim().toLowerCase()
      ? ""
      : currentOverride;
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
    !managedCatalog.hasSnapshot &&
    ["idle", "loading", "refreshing"].includes(managedCatalog.status);
  const catalogErrorWithoutSnapshot =
    managedCatalog.status === "error" && !managedCatalog.hasSnapshot;
  const catalogSnapshotEmpty = managedCatalog.hasSnapshot && modelOptions.length === 0;
  const catalogTriggerStatus = catalogLoadingWithoutSnapshot
    ? t("chat.modelControls.loadingModels")
    : catalogErrorWithoutSnapshot
      ? t("chat.modelControls.modelsUnavailable")
      : catalogSnapshotEmpty
        ? modelAuthenticationNeededText()
        : undefined;
  const busy =
    props.loading || props.sending || Boolean(props.activeRunId) || props.stream !== null;
  const commonDisabled =
    !props.connected || busy || props.modelSwitching || !props.gatewayAvailable;
  const effortMutationDisabled = Boolean(props.effortMutationDisabledReason);
  const modelDisabled =
    commonDisabled ||
    Boolean(props.modelMutationDisabledReason) ||
    catalogLoadingWithoutSnapshot ||
    (Boolean(props.modelsLoading) && selectOptions.length === 0);
  const thinkingDisabled =
    commonDisabled ||
    effortMutationDisabled ||
    !managedCatalog.hasSnapshot ||
    (thinking.options.length === 0 && thinking.selection.source === "default");
  const showFastMode = props.showFastMode !== false;
  const effortDisabled =
    commonDisabled ||
    effortMutationDisabled ||
    (thinking.options.length === 0 && (!showFastMode || fastMode.disabled));
  return html`
    <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
      ${renderChatModelPicker({
        defaultModelLabel: formatPickerModelLabel(pickerDefaultLabel),
        disabled: modelDisabled,
        disabledReason: props.modelMutationDisabledReason,
        modelCatalogState: managedCatalog,
        modelSelectionLocked: props.modelSelectionLocked === true,
        modelOptions,
        targetGroups: props.modelPickerTargetGroups,
        selectedModelValue: pickerValue,
        sessionKey: props.sessionKey,
        triggerModelLabel: formatPickerModelLabel(committedModelLabel),
        triggerStatusLabel: catalogTriggerStatus,
        onModelSetup: props.onModelSetup,
        onOpen: props.onModelPickerOpen,
        onModelSelect: async (next, targetSessionKey) =>
          props.onModelSelect?.(next, targetSessionKey),
        onTargetSelect: props.onModelPickerTargetSelect,
        onRequestUpdate: props.onRequestUpdate,
      })}
      ${renderChatEffortPicker({
        disabled: effortDisabled,
        disabledReason: props.effortMutationDisabledReason,
        fastMode: {
          ...fastMode,
          disabled: fastMode.disabled || commonDisabled || effortMutationDisabled,
        },
        sessionKey: props.sessionKey,
        showFastMode,
        thinkingDisabled,
        thinking,
        onFastModeSelect: async (next, targetSessionKey) =>
          props.onFastModeSelect?.(next, targetSessionKey),
        onRequestUpdate: props.onRequestUpdate,
        onThinkingSelect: async (next, targetSessionKey) =>
          props.onThinkingSelect?.(next, targetSessionKey),
      })}
    </div>
  `;
}
