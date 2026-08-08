// Chat-owned model, reasoning, and speed picker.
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import {
  formatRawProviderLabel,
  providerDisplayLabel,
  renderProviderBrandIcon,
} from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  type ChatFastModeSelectState,
  type ChatFastModeSelectValue,
  type ChatModelSelectOption,
} from "../../../lib/chat/model-select-state.ts";
import {
  formatThinkingOverrideLabel,
  resolveChatThinkingSelectState,
} from "../../../lib/chat/thinking.ts";
import { formatContextTokenCapacity } from "../../../lib/format.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { moveChatModelProviderFocus, selectChatModelProvider } from "./chat-model-provider-menu.ts";

export type ChatModelControlsProps = {
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
  mutationDisabledReason?: string;
  showFastMode?: boolean;
  sending: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  thinkingDefaults?: SessionsListResult["defaults"];
  thinkingSession?: GatewaySessionRow;
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onModelSelect?: (value: string, sessionKey: string) => unknown;
  onRequestUpdate?: () => void;
  onThinkingSelect?: (value: string, sessionKey: string) => unknown;
};

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  onRetry?: () => void;
  status: "idle" | "loading" | "refreshing" | "ready" | "error";
};

type ChatModelProviderOption = ChatModelSelectOption & {
  commitValue: string;
  contextWindow?: number;
  isDefault: boolean;
  provider: string;
  supportsTools?: boolean;
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

function renderChatModelProviderIcon(provider: string) {
  return renderProviderBrandIcon(normalizeChatModelProviderId(provider), {
    className: "chat-controls__provider-icon",
  });
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
    restrictOptionsToCatalog: props.modelCatalogState !== undefined,
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
  const fastModeSelect = resolveChatFastModeSelectState({
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
  // Reasoning/speed state derives from the session row, which still describes
  // the previous model while a switch is pending; keep both locked until the
  // refreshed session list lands so stale levels cannot be committed.
  const fastMode = props.modelSwitching ? { ...fastModeSelect, disabled: true } : fastModeSelect;
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
  const modelOptions: ChatModelProviderOption[] = selectOptions.map((option) => {
    const isDefault =
      defaultSelectable && option.value.trim().toLowerCase() === normalizedDefaultModel;
    const catalogEntry = resolveChatModelCatalogEntry(option.value, props.modelCatalog);
    return {
      commitValue: isDefault ? "" : option.value,
      ...(catalogEntry?.contextWindow ? { contextWindow: catalogEntry.contextWindow } : {}),
      ...(typeof catalogEntry?.supportsTools === "boolean"
        ? { supportsTools: catalogEntry.supportsTools }
        : {}),
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
  const committedThinkingLabel =
    thinking.currentOverride === ""
      ? thinking.defaultLabel
      : (thinking.options.find((entry) => entry.value === thinking.currentOverride)?.label ??
        thinking.currentOverride);
  const managedCatalog = props.modelCatalogState;
  const catalogLoadingWithoutSnapshot =
    managedCatalog !== undefined &&
    !managedCatalog.hasSnapshot &&
    (managedCatalog.status === "idle" ||
      managedCatalog.status === "loading" ||
      managedCatalog.status === "refreshing");
  const catalogErrorWithoutSnapshot =
    managedCatalog?.status === "error" && !managedCatalog.hasSnapshot;
  const catalogSnapshotEmpty = managedCatalog?.hasSnapshot === true && modelOptions.length === 0;
  const catalogTriggerStatus = catalogLoadingWithoutSnapshot
    ? t("chat.modelControls.loadingModels")
    : catalogErrorWithoutSnapshot
      ? t("chat.modelControls.modelsUnavailable")
      : catalogSnapshotEmpty
        ? t("chat.modelControls.noModelsAvailable")
        : undefined;
  const busy =
    props.loading || props.sending || Boolean(props.activeRunId) || props.stream !== null;
  const disabled =
    !props.connected ||
    busy ||
    props.modelSwitching ||
    catalogLoadingWithoutSnapshot ||
    (managedCatalog === undefined && props.modelsLoading && selectOptions.length === 0) ||
    !props.gatewayAvailable ||
    Boolean(props.mutationDisabledReason);
  const thinkingDisabled =
    !props.connected ||
    busy ||
    props.modelSwitching ||
    !props.gatewayAvailable ||
    (managedCatalog !== undefined && !managedCatalog.hasSnapshot) ||
    (thinking.options.length === 0 && thinking.currentOverride === "") ||
    Boolean(props.mutationDisabledReason);
  return renderChatModelReasoningSelect({
    defaultModelLabel: formatCombinedPickerModelLabel(pickerDefaultLabel),
    disabled,
    disabledReason: props.mutationDisabledReason,
    fastMode: { ...fastMode, disabled: fastMode.disabled || disabled },
    modelCatalogState: managedCatalog,
    modelSelectionLocked: props.modelSelectionLocked === true,
    modelOptions,
    onRequestUpdate: props.onRequestUpdate,
    selectedModelValue: currentOverride,
    selectedThinkingValue: thinking.currentOverride,
    sessionKey: props.sessionKey,
    showFastMode: props.showFastMode !== false,
    thinkingDefaultValue: thinking.defaultValue,
    thinkingDisabled,
    thinkingOptions: [{ value: "", label: thinking.defaultLabel }, ...thinking.options],
    triggerModelLabel: committedModelLabel,
    triggerStatusLabel: catalogTriggerStatus,
    triggerThinkingLabel: committedThinkingLabel,
    onFastModeSelect: async (next, targetSessionKey) =>
      props.onFastModeSelect?.(next, targetSessionKey),
    onModelSelect: async (next, targetSessionKey) => props.onModelSelect?.(next, targetSessionKey),
    onThinkingSelect: async (next, targetSessionKey) =>
      props.onThinkingSelect?.(next, targetSessionKey),
  });
}

function formatCombinedPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function formatCombinedPickerModelOptionLabel(option: ChatModelProviderOption): string {
  const label = option.label;
  const providerPrefixes = [
    formatRawProviderLabel(option.provider),
    providerDisplayLabel(option.provider),
  ].toSorted((left, right) => right.length - left.length);
  for (const prefix of providerPrefixes) {
    if (label.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      return label.slice(prefix.length + 1);
    }
  }
  return label;
}

function formatCombinedPickerThinkingLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

/**
 * Provenance for the model choice, mirroring the reasoning row: an inherited
 * default renders muted with no affordance, a session override names itself
 * and offers an icon reset back to the Settings default.
 */
function renderModelProvenanceRow(params: {
  defaultModelLabel: string;
  disabled: boolean;
  hasModelOverride: boolean;
  onReset: () => void;
}) {
  return html`
    <div class="chat-controls__model-provenance">
      <span class="chat-controls__inline-select-section-label">
        ${t("chat.selectors.modelSection")}
      </span>
      <span class="chat-controls__model-provenance-state">
        ${params.hasModelOverride
          ? html`
              <openclaw-tooltip
                .content=${t("chat.modelControls.resetToDefault", {
                  model: params.defaultModelLabel,
                })}
              >
                <button
                  class="chat-controls__model-reset"
                  data-chat-model-reset="true"
                  type="button"
                  aria-label=${t("chat.modelControls.resetToDefault", {
                    model: params.defaultModelLabel,
                  })}
                  ?disabled=${params.disabled}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    if (params.disabled) {
                      event.preventDefault();
                      return;
                    }
                    params.onReset();
                  }}
                >
                  ${t("chat.modelControls.useDefault")}
                </button>
              </openclaw-tooltip>
            `
          : html`
              <span
                class="chat-controls__model-provenance-value chat-controls__model-provenance-value--inherit"
              >
                ${t("chat.modelControls.usingDefault")}
              </span>
            `}
      </span>
    </div>
  `;
}

function renderChatModelReasoningSelect(params: {
  defaultModelLabel: string;
  fastMode: ChatFastModeSelectState;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ChatModelCatalogState;
  modelSelectionLocked: boolean;
  modelOptions: ChatModelProviderOption[];
  selectedModelValue: string;
  selectedThinkingValue: string;
  sessionKey: string;
  showFastMode: boolean;
  thinkingDefaultValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatModelSelectOption[];
  triggerModelLabel: string;
  triggerStatusLabel?: string;
  triggerThinkingLabel: string;
  onFastModeSelect: (value: ChatFastModeSelectValue, sessionKey: string) => Promise<unknown>;
  onModelSelect: (value: string, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
}) {
  const {
    defaultModelLabel,
    disabled,
    disabledReason,
    fastMode,
    modelCatalogState,
    modelSelectionLocked,
    modelOptions,
    selectedModelValue,
    selectedThinkingValue,
    sessionKey,
    showFastMode,
    thinkingDefaultValue,
    thinkingDisabled,
    thinkingOptions,
    triggerModelLabel,
    triggerStatusLabel,
    triggerThinkingLabel,
    onFastModeSelect,
    onModelSelect,
    onRequestUpdate,
    onThinkingSelect,
  } = params;
  const triggerModel = formatCombinedPickerModelLabel(triggerModelLabel);
  const triggerThinking = formatCombinedPickerThinkingLabel(triggerThinkingLabel);
  const defaultModelOption = modelOptions.find((option) => option.isDefault);
  const activeModelOption =
    selectedModelValue === ""
      ? defaultModelOption
      : modelOptions.find((option) => option.value === selectedModelValue);
  const selectedModelOption = activeModelOption ?? modelOptions[0];
  const modelToolsUnavailable = activeModelOption?.supportsTools === false;
  const triggerTitle = [
    triggerStatusLabel ?? triggerModel,
    triggerStatusLabel ? "" : triggerThinking,
    modelToolsUnavailable ? t("chat.modelControls.chatOnly") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const triggerLabel = triggerStatusLabel ?? `${triggerModel} · ${triggerThinking}`;
  const sliderStops = thinkingOptions.filter((option) => option.value !== "");
  const defaultStopIndex = sliderStops.findIndex((option) => option.value === thinkingDefaultValue);
  const hasThinkingOverride = selectedThinkingValue !== "";
  const overrideStopIndex = sliderStops.findIndex(
    (option) => option.value === selectedThinkingValue,
  );
  const sliderIndex = Math.max(hasThinkingOverride ? overrideStopIndex : defaultStopIndex, 0);
  const sliderUnanchored = !hasThinkingOverride && defaultStopIndex < 0;
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const defaultLevelLabel = formatThinkingOverrideLabel(thinkingDefaultValue);
  const selectedThinkingOption = thinkingOptions.find(
    (option) => option.value === selectedThinkingValue,
  );
  // Visible state is just the level word; inherited defaults render muted with
  // no reset affordance, overrides render strong with an icon reset. Screen
  // readers keep the verbose default phrasing via aria-valuetext.
  const reasoningValueText = hasThinkingOverride
    ? formatCombinedPickerThinkingLabel(
        selectedThinkingOption?.label ?? formatThinkingOverrideLabel(selectedThinkingValue),
      )
    : defaultLevelLabel;
  const reasoningValueLabel = hasThinkingOverride
    ? reasoningValueText
    : t("chat.modelControls.defaultWithLevel", { level: defaultLevelLabel });
  // Selections commit immediately; the picker stays open so model, reasoning,
  // and speed can be adjusted together. The extra onRequestUpdate re-renders
  // the optimistic state patched synchronously by the switch helpers.
  // Send gating uses a separate aggregate of all settings patches; keep the
  // model-only switching state here so reasoning and speed can still overlap.
  const commitModel = (value: string) => {
    if (modelSelectionLocked) {
      return;
    }
    void onModelSelect(value, sessionKey).finally(() => onRequestUpdate?.());
    onRequestUpdate?.();
  };
  const commitThinking = (value: string) => {
    void onThinkingSelect(value, sessionKey).finally(() => onRequestUpdate?.());
    onRequestUpdate?.();
  };
  const commitFastMode = (value: ChatFastModeSelectValue) => {
    void onFastModeSelect(value, sessionKey).finally(() => onRequestUpdate?.());
    onRequestUpdate?.();
  };
  const speedTooltip = fastMode.supported
    ? t("chat.modelControls.fastHelp")
    : t("chat.modelControls.speedUnsupported");
  const resetSliderPreview = (input: HTMLInputElement, restoreValue = false) => {
    if (restoreValue) {
      input.value = String(sliderIndex);
    }
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(sliderIndex)}%`);
    input.setAttribute("aria-valuetext", reasoningValueLabel);
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = true;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = false;
    }
  };
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop) {
      return;
    }
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(Number(input.value))}%`);
    input.setAttribute("aria-valuetext", formatCombinedPickerThinkingLabel(stop.label));
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = label.dataset.chatThinkingPreviewIndex !== input.value;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = true;
    }
  };
  const onSliderCommit = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    // Preview visibility is DOM-owned during a drag, so restore Lit's
    // committed baseline before either the optimistic update or a failed patch.
    resetSliderPreview(input);
    if (thinkingDisabled) {
      return;
    }
    if (!stop || stop.value === selectedThinkingValue) {
      return;
    }
    commitThinking(stop.value);
  };
  const onUnanchoredSliderClick = (event: MouseEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    if (!sliderUnanchored || Number(input.value) !== sliderIndex) {
      return;
    }
    onSliderCommit(event);
  };
  const onUnanchoredSliderKeyDown = (event: KeyboardEvent) => {
    if (!sliderUnanchored || !["Home", "ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) {
      return;
    }
    onSliderCommit(event);
  };
  const showReasoning = sliderStops.length > 0;
  const onlyStop = sliderStops.length === 1 ? sliderStops[0] : undefined;
  const effectiveThinkingValue = selectedThinkingValue || thinkingDefaultValue;
  const onlyStopSelected = onlyStop?.value === effectiveThinkingValue;
  const catalogHasNoUsableSnapshot =
    modelCatalogState !== undefined &&
    (!modelCatalogState.hasSnapshot || modelOptions.length === 0);
  const showReasoningPanel = (showReasoning || showFastMode) && !catalogHasNoUsableSnapshot;
  const providerGroups = new Map<string, ChatModelProviderOption[]>();
  for (const option of modelOptions) {
    const existing = providerGroups.get(option.provider);
    if (existing) {
      existing.push(option);
    } else {
      providerGroups.set(option.provider, [option]);
    }
  }
  const orderedProviderGroups = [...providerGroups];
  const defaultProviderIndex = orderedProviderGroups.findIndex(
    ([provider]) => provider === defaultModelOption?.provider,
  );
  if (defaultProviderIndex > 0) {
    const [defaultProviderGroup] = orderedProviderGroups.splice(defaultProviderIndex, 1);
    if (defaultProviderGroup) {
      orderedProviderGroups.unshift(defaultProviderGroup);
    }
  }
  const selectedProvider =
    selectedModelOption?.provider ?? orderedProviderGroups[0]?.[0] ?? "other";
  const renderCatalogState = () => {
    if (!modelCatalogState) {
      return nothing;
    }
    const hasOptions = modelOptions.length > 0;
    const status = modelCatalogState.status;
    if (status === "ready" && hasOptions) {
      return nothing;
    }
    const label =
      status === "refreshing"
        ? t("chat.modelControls.refreshingModels")
        : status === "error"
          ? modelCatalogState.hasSnapshot
            ? t("chat.modelControls.modelsRefreshFailed")
            : t("chat.modelControls.modelsUnavailable")
          : status === "ready"
            ? t("chat.modelControls.noModelsAvailable")
            : t("chat.modelControls.loadingModels");
    return html`
      <div
        class="chat-controls__model-catalog-state ${hasOptions
          ? ""
          : "chat-controls__model-catalog-state--empty"}"
        data-chat-model-catalog-state=${status}
        aria-live="polite"
      >
        <span class="chat-controls__model-catalog-state-label">
          ${status === "error" ? icons.alertTriangle : nothing}
          <span>${label}</span>
        </span>
        ${status === "error" && modelCatalogState.onRetry
          ? html`
              <button
                class="chat-controls__model-catalog-retry"
                data-chat-model-catalog-retry="true"
                type="button"
                @click=${(event: MouseEvent) => {
                  event.stopPropagation();
                  modelCatalogState.onRetry?.();
                }}
              >
                ${icons.refresh}
                <span>${t("common.retry")}</span>
              </button>
            `
          : nothing}
      </div>
    `;
  };
  const renderModelOption = (entry: ChatModelProviderOption) => {
    const selected =
      entry.value === selectedModelValue || (entry.isDefault && selectedModelValue === "");
    const modelLabel = formatCombinedPickerModelOptionLabel(entry);
    const modelMeta = [
      entry.contextWindow
        ? t("chat.modelControls.contextWindow", {
            count: formatContextTokenCapacity(entry.contextWindow),
          })
        : "",
      entry.supportsTools === false ? t("chat.modelControls.chatOnly") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return html`
      <div class="chat-controls__combined-model">
        <button
          class="chat-controls__inline-select-option chat-controls__combined-model-option ${selected
            ? "chat-controls__inline-select-option--selected"
            : ""}"
          data-chat-model-option=${entry.value}
          data-chat-model-default=${entry.isDefault ? "true" : nothing}
          role="option"
          aria-selected=${selected ? "true" : "false"}
          type="button"
          ?disabled=${disabled || modelSelectionLocked}
          @click=${(event: MouseEvent) => {
            event.stopPropagation();
            if (disabled || modelSelectionLocked || entry.commitValue === selectedModelValue) {
              event.preventDefault();
              return;
            }
            commitModel(entry.commitValue);
          }}
        >
          <span class="chat-controls__model-option-copy">
            <span class="chat-controls__model-option-title">
              <span class="chat-controls__model-option-name">${modelLabel}</span>
              ${selected
                ? html`<span
                    class="chat-controls__model-state-label chat-controls__model-state-label--current"
                    >${t("chat.modelControls.current")}</span
                  >`
                : entry.isDefault
                  ? html`<span
                      class="chat-controls__model-state-label chat-controls__model-state-label--default"
                      >${t("chat.modelControls.default")}</span
                    >`
                  : ""}
            </span>
            ${modelMeta
              ? html`<span class="chat-controls__model-option-meta">${modelMeta}</span>`
              : ""}
          </span>
          ${selected
            ? html`
                <span class="chat-controls__inline-select-check" aria-hidden="true">
                  ${icons.check}
                </span>
              `
            : ""}
        </button>
      </div>
    `;
  };
  return html`
    <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
      <summary
        class="chat-controls__inline-select-trigger ${disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""}"
        data-chat-model-select="true"
        data-chat-model-locked=${modelSelectionLocked ? "true" : "false"}
        data-chat-thinking-select="true"
        data-chat-select-value=${selectedModelValue}
        data-chat-thinking-value=${selectedThinkingValue}
        data-chat-thinking-disabled=${thinkingDisabled ? "true" : "false"}
        data-chat-model-tools=${modelToolsUnavailable ? "unavailable" : "available"}
        aria-label="${t("chat.selectors.model")}, ${t(
          "chat.selectors.thinkingLevel",
        )}: ${triggerTitle}"
        aria-disabled=${disabled ? "true" : "false"}
        title=${disabledReason ?? triggerTitle}
        @click=${(event: MouseEvent) => {
          if (disabled) {
            event.preventDefault();
          }
        }}
      >
        ${modelToolsUnavailable
          ? html`
              <openclaw-tooltip .content=${t("chat.modelControls.chatOnlyHelp")}>
                <span class="chat-controls__model-capability-badge" aria-hidden="true">
                  ${icons.alertTriangle}
                  <span>${t("chat.modelControls.chatOnly")}</span>
                </span>
              </openclaw-tooltip>
            `
          : nothing}
        <span class="chat-controls__inline-select-label">${triggerLabel}</span>
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </summary>
      <div
        class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined"
        aria-label=${t("chat.selectors.model")}
      >
        ${modelSelectionLocked
          ? html`
              <div
                class="chat-controls__locked-model"
                aria-label=${t("chat.selectors.modelLockedLabel")}
              >
                <span class="chat-controls__inline-select-section-label">
                  ${t("chat.selectors.modelSection")}
                </span>
                <span class="chat-controls__locked-model-value">${triggerModel}</span>
                <span class="chat-controls__locked-model-badge">
                  ${t("chat.selectors.modelLocked")}
                </span>
              </div>
            `
          : html`
              ${modelOptions.length > 0
                ? renderModelProvenanceRow({
                    defaultModelLabel,
                    disabled,
                    hasModelOverride: selectedModelValue !== "",
                    onReset: () => commitModel(""),
                  })
                : nothing}
              ${renderCatalogState()}
              ${modelOptions.length > 0
                ? html`
                    <div
                      class="chat-controls__model-browser"
                      @mouseleave=${(event: MouseEvent) => {
                        const browser = event.currentTarget as HTMLElement;
                        if (browser.contains(document.activeElement)) {
                          return;
                        }
                        selectChatModelProvider(event, selectedProvider);
                      }}
                      @focusout=${(event: FocusEvent) => {
                        const browser = event.currentTarget as HTMLElement;
                        if (
                          event.relatedTarget instanceof Node &&
                          browser.contains(event.relatedTarget)
                        ) {
                          return;
                        }
                        selectChatModelProvider(event, selectedProvider);
                      }}
                    >
                      <div
                        class="chat-controls__provider-list"
                        aria-label=${t("sessionsView.provider")}
                      >
                        <div class="chat-controls__inline-select-section-label">
                          ${t("sessionsView.provider")}
                        </div>
                        ${repeat(
                          orderedProviderGroups,
                          ([provider]) => provider,
                          ([provider]) => {
                            const active = provider === selectedProvider;
                            return html`
                              <button
                                class="chat-controls__provider-option"
                                data-chat-model-provider=${provider}
                                type="button"
                                aria-pressed=${active ? "true" : "false"}
                                tabindex=${active ? "0" : "-1"}
                                @click=${(event: MouseEvent) =>
                                  selectChatModelProvider(event, provider)}
                                @mouseenter=${(event: MouseEvent) => {
                                  const browser = (event.currentTarget as HTMLElement).closest(
                                    ".chat-controls__model-browser",
                                  );
                                  // Keyboard focus owns the active tab until it leaves; hover must
                                  // not hide the panel containing the focused model option.
                                  if (browser?.contains(document.activeElement)) {
                                    return;
                                  }
                                  selectChatModelProvider(event, provider);
                                }}
                                @focus=${(event: FocusEvent) =>
                                  selectChatModelProvider(event, provider)}
                                @keydown=${moveChatModelProviderFocus}
                              >
                                ${renderChatModelProviderIcon(provider)}
                                <span>${providerDisplayLabel(provider)}</span>
                              </button>
                            `;
                          },
                        )}
                      </div>
                      <div
                        class="chat-controls__provider-models"
                        role="listbox"
                        aria-label=${t("chat.selectors.model")}
                      >
                        ${repeat(
                          orderedProviderGroups,
                          ([provider]) => provider,
                          ([provider, options]) => html`
                            <div
                              class="chat-controls__provider-model-group"
                              data-chat-model-provider-group=${provider}
                              aria-label=${t("chat.modelControls.providerModels", {
                                provider: providerDisplayLabel(provider),
                              })}
                              ?hidden=${provider !== selectedProvider}
                            >
                              ${repeat(
                                options,
                                (entry) => entry.value,
                                (entry) => renderModelOption(entry),
                              )}
                            </div>
                          `,
                        )}
                      </div>
                    </div>
                  `
                : nothing}
            `}
        ${showReasoningPanel
          ? html`
              <div class="chat-controls__reasoning-panel">
                ${showReasoning
                  ? html`
                      <div class="chat-controls__reasoning-head">
                        <span class="chat-controls__inline-select-section-label"
                          >${t("chat.modelControls.reasoning")}</span
                        >
                        <span class="chat-controls__reasoning-state">
                          <span
                            class="chat-controls__reasoning-value ${hasThinkingOverride
                              ? ""
                              : "chat-controls__reasoning-value--inherit"}"
                          >
                            ${sliderStops.length > 1
                              ? html`
                                  <span data-chat-thinking-preview-committed>
                                    ${reasoningValueText}
                                  </span>
                                  ${sliderStops.map(
                                    (stop, index) => html`
                                      <span data-chat-thinking-preview-index=${index} hidden>
                                        ${formatCombinedPickerThinkingLabel(stop.label)}
                                      </span>
                                    `,
                                  )}
                                `
                              : reasoningValueText}
                          </span>
                          ${hasThinkingOverride
                            ? html`
                                <openclaw-tooltip
                                  .content=${t("chat.modelControls.resetReasoning", {
                                    level: defaultLevelLabel,
                                  })}
                                >
                                  <button
                                    class="chat-controls__reasoning-reset"
                                    data-chat-thinking-option=""
                                    type="button"
                                    aria-label=${t("chat.modelControls.useDefaultReasoning", {
                                      level: defaultLevelLabel,
                                    })}
                                    ?disabled=${thinkingDisabled}
                                    @click=${(event: MouseEvent) => {
                                      event.stopPropagation();
                                      if (thinkingDisabled) {
                                        event.preventDefault();
                                        return;
                                      }
                                      commitThinking("");
                                    }}
                                  >
                                    ${icons.x}
                                  </button>
                                </openclaw-tooltip>
                              `
                            : ""}
                        </span>
                      </div>
                      ${sliderStops.length > 1
                        ? html`
                            <div class="chat-controls__reasoning-slider">
                              <div class="chat-controls__reasoning-dots" aria-hidden="true">
                                ${sliderStops.map(
                                  (stop, index) =>
                                    html`<span
                                      class="chat-controls__reasoning-dot ${index ===
                                      defaultStopIndex
                                        ? "chat-controls__reasoning-dot--default"
                                        : ""}"
                                      data-stop=${stop.value}
                                    ></span>`,
                                )}
                              </div>
                              <input
                                class="chat-controls__reasoning-range ${hasThinkingOverride
                                  ? ""
                                  : "chat-controls__reasoning-range--inherit"} ${sliderUnanchored
                                  ? "chat-controls__reasoning-range--unanchored"
                                  : ""}"
                                type="range"
                                min="0"
                                max=${sliderStops.length - 1}
                                step="1"
                                .value=${String(sliderIndex)}
                                style=${`--reasoning-fill: ${sliderFillPercent(sliderIndex)}%`}
                                data-chat-thinking-slider="true"
                                data-chat-thinking-values=${sliderStops
                                  .map((stop) => stop.value)
                                  .join(",")}
                                aria-label=${t("chat.selectors.thinkingLevel")}
                                aria-valuetext=${reasoningValueLabel}
                                ?disabled=${thinkingDisabled}
                                @input=${onSliderDrag}
                                @change=${onSliderCommit}
                                @click=${onUnanchoredSliderClick}
                                @keydown=${onUnanchoredSliderKeyDown}
                                @pointercancel=${(event: PointerEvent) =>
                                  resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                                @blur=${(event: FocusEvent) =>
                                  resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                              />
                            </div>
                          `
                        : onlyStop
                          ? html`
                              <button
                                class="chat-controls__reasoning-option ${onlyStopSelected
                                  ? "chat-controls__reasoning-option--selected"
                                  : ""}"
                                data-chat-thinking-option=${onlyStop.value}
                                type="button"
                                aria-pressed=${onlyStopSelected ? "true" : "false"}
                                ?disabled=${thinkingDisabled}
                                @click=${(event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (thinkingDisabled || onlyStopSelected) {
                                    event.preventDefault();
                                    return;
                                  }
                                  commitThinking(onlyStop.value);
                                }}
                              >
                                <span>${onlyStop.label}</span>
                                ${onlyStopSelected
                                  ? html`
                                      <span
                                        class="chat-controls__inline-select-check"
                                        aria-hidden="true"
                                      >
                                        ${icons.check}
                                      </span>
                                    `
                                  : ""}
                              </button>
                            `
                          : ""}
                    `
                  : ""}
                ${showFastMode
                  ? html`
                      <div class="chat-controls__speed-row">
                        <span class="chat-controls__inline-select-section-label"
                          >${t("chat.modelControls.speed")}</span
                        >
                        <openclaw-tooltip .content=${speedTooltip}>
                          <button
                            class="chat-controls__speed-toggle ${fastMode.active
                              ? "chat-controls__speed-toggle--active"
                              : ""}"
                            data-chat-speed-toggle=${fastMode.nextValue}
                            type="button"
                            role="switch"
                            aria-checked=${fastMode.active ? "true" : "false"}
                            aria-label=${t("chat.modelControls.fastResponsesAria", {
                              state: fastMode.label,
                            })}
                            ?disabled=${fastMode.disabled}
                            @click=${(event: MouseEvent) => {
                              event.stopPropagation();
                              if (fastMode.disabled) {
                                event.preventDefault();
                                return;
                              }
                              commitFastMode(fastMode.nextValue);
                            }}
                          >
                            <span class="chat-controls__speed-toggle-icon" aria-hidden="true">
                              ${icons.zap}
                            </span>
                            <span>${fastMode.label}</span>
                          </button>
                        </openclaw-tooltip>
                      </div>
                    `
                  : nothing}
              </div>
            `
          : ""}
      </div>
    </details>
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
