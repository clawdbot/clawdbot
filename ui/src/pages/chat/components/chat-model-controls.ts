// Chat-owned model, reasoning, and speed picker.
import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ModelCatalogEntry, SessionsListResult } from "../../../api/types.ts";
import { inferControlUiPublicAssetPath } from "../../../app/public-assets.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
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

export type ChatModelControlsProps = {
  activeRunId: string | null;
  agentDefaultModel?: string;
  connected: boolean;
  gatewayAvailable: boolean;
  loading: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelOverrides?: Readonly<Record<string, string | null | undefined>>;
  modelSwitching: boolean;
  modelsLoading?: boolean;
  sending: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onModelSelect?: (value: string, sessionKey: string) => unknown;
  onRequestUpdate?: () => void;
  onThinkingSelect?: (value: string, sessionKey: string) => unknown;
};

type ChatModelProviderOption = ChatModelSelectOption & {
  provider: string;
};

const CHAT_MODEL_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  google: "Google",
  "github-copilot": "GitHub",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
};

const CHAT_MODEL_PROVIDER_GROUP_ALIASES: Readonly<Record<string, string>> = {
  "google-gemini-cli": "google",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
};

function normalizeChatModelProviderGroupId(provider: string): string {
  const normalized = normalizeChatModelProviderId(provider);
  return CHAT_MODEL_PROVIDER_GROUP_ALIASES[normalized] ?? normalized;
}

const CHAT_MODEL_PROVIDER_ICON_NAMES = new Set([
  "abacus",
  "alibaba",
  "amp",
  "antigravity",
  "augment",
  "bedrock",
  "chutes",
  "claude",
  "clawrouter",
  "codebuff",
  "codex",
  "commandcode",
  "copilot",
  "crof",
  "crossmodel",
  "cursor",
  "deepgram",
  "deepseek",
  "devin",
  "doubao",
  "elevenlabs",
  "factory",
  "gemini",
  "grok",
  "groq",
  "jetbrains",
  "kilo",
  "kimi",
  "kiro",
  "litellm",
  "llmproxy",
  "manus",
  "mimo",
  "minimax",
  "mistral",
  "ollama",
  "opencode",
  "opencodego",
  "openrouter",
  "perplexity",
  "poe",
  "qoder",
  "sakana",
  "stepfun",
  "synthetic",
  "t3chat",
  "venice",
  "vertexai",
  "warp",
  "windsurf",
  "zai",
  "zed",
]);

const CHAT_MODEL_PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "claude",
  "amazon-bedrock": "bedrock",
  "aws-bedrock": "bedrock",
  google: "gemini",
  "google-gemini-cli": "gemini",
  "github-copilot": "copilot",
  openai: "codex",
  "opencode-go": "opencodego",
  "opencode-zen": "opencode",
  xai: "grok",
  "vertex-ai": "vertexai",
  "z-ai": "zai",
};

function formatChatModelProviderLabel(provider: string): string {
  const known = CHAT_MODEL_PROVIDER_LABELS[provider];
  if (known) {
    return known;
  }
  return formatRawChatModelProviderLabel(provider);
}

function formatRawChatModelProviderLabel(provider: string): string {
  return provider
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolveChatModelProviderIcon(provider: string): string | null {
  const normalized = normalizeChatModelProviderId(provider);
  const icon = CHAT_MODEL_PROVIDER_ICON_ALIASES[normalized] ?? normalized;
  return CHAT_MODEL_PROVIDER_ICON_NAMES.has(icon) ? icon : null;
}

function renderChatModelProviderIcon(provider: string) {
  const icon = resolveChatModelProviderIcon(provider);
  if (!icon) {
    return html`
      <span
        class="chat-controls__provider-icon chat-controls__provider-icon--fallback"
        aria-hidden="true"
      >
        ${formatChatModelProviderLabel(provider).charAt(0)}
      </span>
    `;
  }
  const iconUrl = inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${icon}.svg`);
  return html`
    <span
      class="chat-controls__provider-icon"
      data-provider-icon=${icon}
      style=${`--provider-icon-url: url("${iconUrl}")`}
      aria-hidden="true"
    ></span>
  `;
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

function resolveChatModelPickerLabel(
  value: string,
  fallbackLabel: string,
  catalog: ModelCatalogEntry[],
): string {
  const trimmedValue = value.trim().toLowerCase();
  const separator = trimmedValue.indexOf("/");
  const normalizedValue =
    separator > 0
      ? `${normalizeChatModelProviderId(trimmedValue.slice(0, separator))}/${trimmedValue.slice(
          separator + 1,
        )}`
      : trimmedValue;
  if (!normalizedValue) {
    return fallbackLabel;
  }
  const matches = catalog.filter((candidate) => {
    const provider = normalizeChatModelProviderId(candidate.provider);
    return `${provider}/${candidate.id.trim().toLowerCase()}` === normalizedValue;
  });
  const entry =
    matches.find((candidate) => candidate.provider.trim().toLowerCase() === "openai") ?? matches[0];
  if (entry && normalizeChatModelProviderId(entry.provider) === "openai") {
    return entry.name.trim() || fallbackLabel;
  }
  return fallbackLabel;
}

function selectChatModelProvider(event: MouseEvent, provider: string): void {
  event.preventDefault();
  event.stopPropagation();
  const menu = (event.currentTarget as HTMLElement).closest(
    ".chat-controls__inline-select-menu--combined",
  );
  if (!(menu instanceof HTMLElement)) {
    return;
  }
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      button.dataset.chatModelProvider === provider ? "true" : "false",
    );
  });
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]").forEach((group) => {
    group.hidden = group.dataset.chatModelProviderGroup !== provider;
  });
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
  const activeSession = props.sessionsResult?.sessions.find((row) => row.key === props.sessionKey);
  const currentProviderHint = activeSession?.modelProvider ?? "";
  const defaultProviderHint = props.sessionsResult?.defaults?.modelProvider ?? "";
  const canonicalDefaultLabel = resolveChatModelPickerLabel(
    defaultModel,
    defaultLabel,
    props.modelCatalog,
  );
  const pickerDefaultLabel =
    defaultModel && canonicalDefaultLabel !== defaultLabel
      ? `Default (${canonicalDefaultLabel})`
      : defaultLabel;
  const modelOptions: ChatModelProviderOption[] = [
    ...(defaultSelectable
      ? [
          {
            value: "",
            label: pickerDefaultLabel,
            provider: resolveChatModelProvider(
              "",
              props.modelCatalog,
              defaultModel,
              defaultProviderHint,
            ),
          },
        ]
      : []),
    ...selectOptions.map((option) => ({
      value: option.value,
      label: resolveChatModelPickerLabel(option.value, option.label, props.modelCatalog),
      provider: resolveChatModelProvider(
        option.value,
        props.modelCatalog,
        "",
        option.value === currentOverride ? currentProviderHint : "",
      ),
    })),
  ];
  const committedModelLabel =
    modelOptions.find((entry) => entry.value === currentOverride)?.label ??
    resolveChatModelPickerLabel(
      currentOverride,
      currentOverride || pickerDefaultLabel,
      props.modelCatalog,
    );
  const committedThinkingLabel =
    thinking.currentOverride === ""
      ? thinking.defaultLabel
      : (thinking.options.find((entry) => entry.value === thinking.currentOverride)?.label ??
        thinking.currentOverride);
  const busy =
    props.loading || props.sending || Boolean(props.activeRunId) || props.stream !== null;
  const disabled =
    !props.connected ||
    busy ||
    props.modelSwitching ||
    (props.modelsLoading && selectOptions.length === 0) ||
    !props.gatewayAvailable;
  const thinkingDisabled =
    !props.connected ||
    busy ||
    props.modelSwitching ||
    !props.gatewayAvailable ||
    (thinking.options.length === 0 && thinking.currentOverride === "");
  return renderChatModelReasoningSelect({
    disabled,
    fastMode,
    modelOptions,
    onRequestUpdate: props.onRequestUpdate,
    selectedModelValue: currentOverride,
    selectedThinkingValue: thinking.currentOverride,
    sessionKey: props.sessionKey,
    thinkingDefaultValue: thinking.defaultValue,
    thinkingDisabled,
    thinkingOptions: [{ value: "", label: thinking.defaultLabel }, ...thinking.options],
    triggerModelLabel: committedModelLabel,
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

function formatCombinedPickerModelOptionLabel(
  option: ChatModelProviderOption,
  selected: boolean,
): string {
  const label =
    option.value === "" && selected ? formatCombinedPickerModelLabel(option.label) : option.label;
  const providerPrefixes = [
    formatRawChatModelProviderLabel(option.provider),
    formatChatModelProviderLabel(option.provider),
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

function renderChatModelReasoningSelect(params: {
  fastMode: ChatFastModeSelectState;
  disabled: boolean;
  modelOptions: ChatModelProviderOption[];
  selectedModelValue: string;
  selectedThinkingValue: string;
  sessionKey: string;
  thinkingDefaultValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatModelSelectOption[];
  triggerModelLabel: string;
  triggerThinkingLabel: string;
  onFastModeSelect: (value: ChatFastModeSelectValue, sessionKey: string) => Promise<unknown>;
  onModelSelect: (value: string, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
}) {
  const {
    disabled,
    fastMode,
    modelOptions,
    selectedModelValue,
    selectedThinkingValue,
    sessionKey,
    thinkingDefaultValue,
    thinkingDisabled,
    thinkingOptions,
    triggerModelLabel,
    triggerThinkingLabel,
    onFastModeSelect,
    onModelSelect,
    onRequestUpdate,
    onThinkingSelect,
  } = params;
  const triggerModel = formatCombinedPickerModelLabel(triggerModelLabel);
  const triggerThinking = formatCombinedPickerThinkingLabel(triggerThinkingLabel);
  const triggerTitle = `${triggerModel} · ${triggerThinking}`;
  const triggerLabel = triggerTitle;
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
    : `Default (${defaultLevelLabel})`;
  // Selections commit immediately; the picker stays open so model, reasoning,
  // and speed can be adjusted together. The extra onRequestUpdate re-renders
  // the optimistic state patched synchronously by the switch helpers.
  // Send gating uses a separate aggregate of all settings patches; keep the
  // model-only switching state here so reasoning and speed can still overlap.
  const commitModel = (value: string) => {
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
    ? "Fast responses finish sooner and can use more of your usage limits."
    : "Speed control is not supported for this model.";
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop) {
      return;
    }
    // Style/attribute-only drag preview; change commits on release and the
    // re-render refreshes the visible value label. Never write into rendered
    // text here: setting textContent on a Lit-managed span ejects the
    // ChildPart markers and permanently breaks every later menu render.
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(Number(input.value))}%`);
    input.setAttribute("aria-valuetext", formatCombinedPickerThinkingLabel(stop.label));
  };
  const onSliderCommit = (event: Event) => {
    if (thinkingDisabled) {
      return;
    }
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
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
  const showReasoningPanel = true;
  const providerGroups = new Map<string, ChatModelProviderOption[]>();
  for (const option of modelOptions) {
    if (option.value === "") {
      continue;
    }
    const existing = providerGroups.get(option.provider);
    if (existing) {
      existing.push(option);
    } else {
      providerGroups.set(option.provider, [option]);
    }
  }
  const defaultModelOption = modelOptions.find((option) => option.value === "");
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
  const selectedModelProvider =
    modelOptions.find((option) => option.value === selectedModelValue)?.provider ??
    modelOptions[0]?.provider ??
    "other";
  const selectedProvider =
    selectedModelValue === ""
      ? (orderedProviderGroups[0]?.[0] ?? selectedModelProvider)
      : selectedModelProvider;
  const renderModelOption = (entry: ChatModelProviderOption) => {
    const selected = entry.value === selectedModelValue;
    const isDefaultOption = entry.value === "";
    const modelLabel = formatCombinedPickerModelOptionLabel(entry, selected);
    return html`
      <div
        class="chat-controls__combined-model ${isDefaultOption
          ? "chat-controls__combined-model--default"
          : ""}"
      >
        <openclaw-tooltip .content=${entry.label}>
          <button
            class="chat-controls__inline-select-option chat-controls__combined-model-option ${selected
              ? "chat-controls__inline-select-option--selected"
              : ""}"
            data-chat-model-option=${entry.value}
            role="option"
            aria-selected=${selected ? "true" : "false"}
            type="button"
            ?disabled=${disabled}
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              if (disabled || selected) {
                event.preventDefault();
                return;
              }
              commitModel(entry.value);
            }}
          >
            <span class="chat-controls__model-option-copy">
              <span class="chat-controls__model-option-title">
                ${isDefaultOption ? entry.label : modelLabel}
              </span>
              <span class="chat-controls__model-option-provider">
                ${formatChatModelProviderLabel(entry.provider)}
              </span>
            </span>
            ${selected
              ? html`
                  <span class="chat-controls__inline-select-check" aria-hidden="true">
                    ${icons.check}
                  </span>
                `
              : ""}
          </button>
        </openclaw-tooltip>
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
        data-chat-thinking-select="true"
        data-chat-select-value=${selectedModelValue}
        data-chat-thinking-value=${selectedThinkingValue}
        data-chat-thinking-disabled=${thinkingDisabled ? "true" : "false"}
        aria-label=${`${t("chat.selectors.model")}, ${t("chat.selectors.thinkingLevel")}: ${triggerTitle}`}
        aria-disabled=${disabled ? "true" : "false"}
        @click=${(event: MouseEvent) => {
          if (disabled) {
            event.preventDefault();
          }
        }}
      >
        <span class="chat-controls__inline-select-label">${triggerLabel}</span>
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </summary>
      <div
        class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined"
        aria-label=${t("chat.selectors.model")}
      >
        <div class="chat-controls__model-browser">
          <div class="chat-controls__provider-list" aria-label=${t("sessionsView.provider")}>
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
                    @click=${(event: MouseEvent) => selectChatModelProvider(event, provider)}
                  >
                    ${renderChatModelProviderIcon(provider)}
                    <span>${formatChatModelProviderLabel(provider)}</span>
                  </button>
                `;
              },
            )}
          </div>
          <div class="chat-controls__provider-models">
            ${defaultModelOption ? renderModelOption(defaultModelOption) : ""}
            ${repeat(
              orderedProviderGroups,
              ([provider]) => provider,
              ([provider, options]) => html`
                <div
                  class="chat-controls__provider-model-group"
                  data-chat-model-provider-group=${provider}
                  aria-label=${`${formatChatModelProviderLabel(provider)} models`}
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
        ${showReasoningPanel
          ? html`
              <div class="chat-controls__reasoning-panel">
                ${showReasoning
                  ? html`
                      <div class="chat-controls__reasoning-head">
                        <span class="chat-controls__inline-select-section-label">Reasoning</span>
                        <span class="chat-controls__reasoning-state">
                          <span
                            class="chat-controls__reasoning-value ${hasThinkingOverride
                              ? ""
                              : "chat-controls__reasoning-value--inherit"}"
                          >
                            ${reasoningValueText}
                          </span>
                          ${hasThinkingOverride
                            ? html`
                                <openclaw-tooltip
                                  .content=${`Reset to default (${defaultLevelLabel})`}
                                >
                                  <button
                                    class="chat-controls__reasoning-reset"
                                    data-chat-thinking-option=""
                                    type="button"
                                    aria-label=${`Use default reasoning (${defaultLevelLabel})`}
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
                <div class="chat-controls__speed-row">
                  <span class="chat-controls__inline-select-section-label">Speed</span>
                  <openclaw-tooltip .content=${speedTooltip}>
                    <button
                      class="chat-controls__speed-toggle ${fastMode.active
                        ? "chat-controls__speed-toggle--active"
                        : ""}"
                      data-chat-speed-toggle=${fastMode.nextValue}
                      type="button"
                      role="switch"
                      aria-checked=${fastMode.active ? "true" : "false"}
                      aria-label=${`Fast responses: ${fastMode.label}`}
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
              </div>
            `
          : ""}
      </div>
    </details>
  `;
}
