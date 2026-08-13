// Chat-owned model, reasoning, and fast-mode picker orchestration.
import { html, nothing } from "lit";
import type { ModelCatalogEntry, SessionsListResult } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { type ModelPickerOption, renderModelPicker } from "../../../components/model-picker.ts";
import { formatRawProviderLabel, providerDisplayLabel } from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  type ChatFastModeSelectValue,
} from "../../../lib/chat/model-select-state.ts";
import {
  resolveChatThinkingSelectState,
  type ChatThinkingTarget,
} from "../../../lib/chat/thinking.ts";
import { formatContextTokenCapacity } from "../../../lib/format.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { renderChatEffortPicker } from "./chat-effort-picker.ts";

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  onRetry?: () => void;
  status: "idle" | "loading" | "refreshing" | "ready" | "error";
};

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
  onModelSelect?: (value: string, sessionKey: string) => unknown;
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
  return (
    matches.find((candidate) => candidate.provider.trim().toLowerCase() === "openai") ?? matches[0]
  );
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

function formatModelLabel(label: string, provider: string): string {
  const prefixes = [formatRawProviderLabel(provider), providerDisplayLabel(provider)].toSorted(
    (left, right) => right.length - left.length,
  );
  return prefixes.reduce(
    (result, prefix) =>
      result.toLowerCase().startsWith(`${prefix.toLowerCase()} `)
        ? result.slice(prefix.length + 1)
        : result,
    label,
  );
}

const AGENT_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  "claude-cli": "Claude CLI",
  codex: "Codex",
  "codex-cli": "Codex",
  "google-gemini-cli": "Gemini CLI",
  openclaw: "OpenClaw",
};

function formatAgentRuntimeLabel(id: string): string {
  const normalized = id.trim().toLowerCase();
  return (
    AGENT_RUNTIME_LABELS[normalized] ??
    `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
  );
}

function renderModelCatalogState(state: ChatModelCatalogState, hasOptions: boolean) {
  if (state.status === "ready" && hasOptions) {
    return nothing;
  }
  const label =
    state.status === "refreshing"
      ? t("chat.modelControls.refreshingModels")
      : state.status === "error"
        ? state.hasSnapshot
          ? t("chat.modelControls.modelsRefreshFailed")
          : t("chat.modelControls.modelsUnavailable")
        : state.status === "ready"
          ? t("chat.modelControls.noModelsAvailable")
          : t("chat.modelControls.loadingModels");
  return html`
    <div
      class="chat-controls__model-catalog-state"
      data-chat-model-catalog-state=${state.status}
      aria-live="polite"
    >
      <span class="chat-controls__model-catalog-state-label">
        ${state.status === "error" ? icons.alertTriangle : nothing}<span>${label}</span>
      </span>
      ${state.status === "error" && state.onRetry
        ? html`<button
            class="chat-controls__model-catalog-retry"
            data-chat-model-catalog-retry="true"
            type="button"
            @click=${state.onRetry}
          >
            ${icons.refresh}<span>${t("common.retry")}</span>
          </button>`
        : nothing}
    </div>
  `;
}

export function renderChatModelControls(props: ChatModelControlsProps) {
  const {
    currentOverride,
    defaultSelectable,
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
  const defaultCatalogEntry = resolveChatModelCatalogEntry(defaultModel, props.modelCatalog);
  const modelOptions: ModelPickerOption[] = selectOptions.map((option) => {
    const catalogEntry = resolveChatModelCatalogEntry(option.value, props.modelCatalog);
    const isDefault =
      defaultSelectable &&
      (option.value.trim().toLowerCase() === normalizedDefaultModel ||
        (catalogEntry !== undefined && catalogEntry === defaultCatalogEntry));
    // Runtime meta labels only operator-pinned runtimes (models/provider config);
    // implicit/default resolution stays unlabeled so ordinary rows stay clean.
    const agentRuntime = catalogEntry?.agentRuntime;
    const agentRuntimeId =
      agentRuntime && (agentRuntime.source === "model" || agentRuntime.source === "provider")
        ? agentRuntime.id.trim()
        : undefined;
    const provider = resolveChatModelProvider(
      option.value,
      props.modelCatalog,
      "",
      isDefault ? defaultProviderHint : option.value === currentOverride ? currentProviderHint : "",
    );
    const detail = [
      agentRuntimeId ? formatAgentRuntimeLabel(agentRuntimeId) : "",
      catalogEntry?.contextWindow ? formatContextTokenCapacity(catalogEntry.contextWindow) : "",
      catalogEntry?.supportsTools === false ? t("chat.modelControls.chatOnly") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const label = isDefault
      ? pickerDefaultLabel
      : resolveChatModelPickerLabel(option.value, option.label, props.modelCatalog);
    return {
      value: isDefault ? "" : option.value,
      label: formatModelLabel(label, provider),
      provider,
      ...(detail ? { detail } : {}),
    };
  });
  if (currentOverride && !modelOptions.some((option) => option.value === currentOverride)) {
    const catalogEntry = resolveChatModelCatalogEntry(currentOverride, props.modelCatalog);
    const detail = [
      catalogEntry?.contextWindow ? formatContextTokenCapacity(catalogEntry.contextWindow) : "",
      catalogEntry?.supportsTools === false ? t("chat.modelControls.chatOnly") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    modelOptions.push({
      value: currentOverride,
      label: catalogEntry?.name.trim() || currentOverride,
      provider: resolveChatModelProvider(
        currentOverride,
        props.modelCatalog,
        "",
        currentProviderHint,
      ),
      ...(detail ? { detail } : {}),
    });
  }
  const lockedModelLabel =
    props.modelSelectionRuntimeId?.trim().toLowerCase() === "codex"
      ? t("chat.selectors.nativeCodexModel")
      : t("chat.selectors.lockedSessionModel");
  const managedCatalog = props.modelCatalogState ?? {
    hasSnapshot: !props.modelsLoading,
    status: props.modelsLoading ? ("loading" as const) : ("ready" as const),
  };
  const catalogLoadingWithoutSnapshot =
    !managedCatalog.hasSnapshot &&
    ["idle", "loading", "refreshing"].includes(managedCatalog.status);
  const catalogErrorWithoutSnapshot =
    managedCatalog.status === "error" && !managedCatalog.hasSnapshot;
  const catalogSnapshotEmpty = managedCatalog.hasSnapshot && selectOptions.length === 0;
  const catalogTriggerStatus = catalogLoadingWithoutSnapshot
    ? t("chat.modelControls.loadingModels")
    : catalogErrorWithoutSnapshot
      ? t("chat.modelControls.modelsUnavailable")
      : catalogSnapshotEmpty
        ? t("chat.modelControls.noModelsAvailable")
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
  const pickerOptions =
    props.modelSelectionLocked === true
      ? [
          {
            value: currentOverride,
            label: lockedModelLabel,
            ...(currentProviderHint ? { provider: currentProviderHint } : {}),
          },
        ]
      : catalogLoadingWithoutSnapshot || catalogErrorWithoutSnapshot || catalogSnapshotEmpty
        ? [
            {
              value: currentOverride,
              label: catalogTriggerStatus ?? pickerDefaultLabel,
              disabled: true,
            },
          ]
        : modelOptions.length > 0
          ? modelOptions.some((option) => option.value === "")
            ? modelOptions
            : [
                {
                  value: "",
                  label: pickerDefaultLabel,
                  ...(defaultProviderHint ? { provider: defaultProviderHint } : {}),
                },
                ...modelOptions,
              ]
          : [
              {
                value: currentOverride,
                label: catalogTriggerStatus ?? pickerDefaultLabel,
                disabled: true,
              },
            ];
  const activeCatalogEntry = resolveChatModelCatalogEntry(
    currentOverride || defaultModel,
    props.modelCatalog,
  );
  const modelToolsUnavailable = activeCatalogEntry?.supportsTools === false;
  return html`
    <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
      <div class="chat-controls__model-control">
        <div class="chat-controls__model-control-row">
          ${modelToolsUnavailable
            ? html`<span
                class="chat-controls__model-capability-badge"
                title=${t("chat.modelControls.chatOnlyHelp")}
                >${icons.alertTriangle}<span>${t("chat.modelControls.chatOnly")}</span></span
              >`
            : nothing}
          ${renderModelPicker({
            label: t("chat.selectors.model"),
            value: currentOverride,
            options: pickerOptions,
            disabled: modelDisabled || props.modelSelectionLocked === true,
            title:
              props.modelMutationDisabledReason ??
              (props.modelSelectionLocked ? t("chat.selectors.modelLockedLabel") : undefined),
            className: "chat-controls__model-picker",
            placement: "top",
            onChange: (next) => {
              if (
                next !== currentOverride &&
                !modelDisabled &&
                props.modelSelectionLocked !== true
              ) {
                void props.onModelSelect?.(next, props.sessionKey);
              }
            },
          })}
        </div>
        ${renderModelCatalogState(managedCatalog, selectOptions.length > 0)}
      </div>
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
