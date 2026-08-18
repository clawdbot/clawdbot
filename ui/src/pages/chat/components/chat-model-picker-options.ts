import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import {
  formatRawProviderLabel,
  providerDisplayLabel,
  renderProviderBrandIcon,
} from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import { formatContextTokenCapacity } from "../../../lib/format.ts";

export type ChatModelPickerOption = {
  agentRuntimeId?: string;
  commitValue: string;
  contextTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  isDefault: boolean;
  label: string;
  provider: string;
  supportsTools?: boolean;
  value: string;
};

function formatModelContextMeta(option: ChatModelPickerOption): string {
  const active = option.contextTokens;
  const maximum = option.contextWindow;
  if (active && maximum && active !== maximum) {
    return t("chat.modelControls.contextActiveAndMax", {
      active: formatContextTokenCapacity(active),
      maximum: formatContextTokenCapacity(maximum),
    });
  }
  return maximum ? formatContextTokenCapacity(maximum) : "";
}

export type ChatModelPickerTargetGroup = {
  id: string;
  label: string;
  options: readonly { label: string; value: string }[];
  status: "loading" | "ready" | "error";
};

// Known models.list runtime ids; mirrors src/status/agent-runtime-label.ts,
// which cannot be imported here (it drags terminal sanitizers into the bundle).
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

function formatModelLabel(option: ChatModelPickerOption): string {
  const prefixes = [
    formatRawProviderLabel(option.provider),
    providerDisplayLabel(option.provider),
  ].toSorted((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    if (option.label.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      return option.label.slice(prefix.length + 1);
    }
  }
  return option.label;
}

export function renderChatModelProviderIcon(provider: string) {
  return renderProviderBrandIcon(provider, { className: "chat-controls__provider-icon" });
}

export function renderChatModelPickerOption(params: {
  disabled: boolean;
  entry: ChatModelPickerOption;
  index: number;
  selectedModelValue: string;
  onHighlight: (row: HTMLButtonElement) => void;
  onSelect: (entry: ChatModelPickerOption, event: MouseEvent) => void;
}) {
  const selected =
    params.entry.value === params.selectedModelValue ||
    (params.entry.isDefault && params.selectedModelValue === "");
  const modelLabel = formatModelLabel(params.entry);
  const modelMeta = [
    formatModelContextMeta(params.entry),
    params.entry.supportsTools === false ? t("chat.modelControls.chatOnly") : "",
    params.entry.agentRuntimeId ? formatAgentRuntimeLabel(params.entry.agentRuntimeId) : "",
    params.entry.disabled ? t("modelSetup.candidates.signInNeeded") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return html`
    <button
      class="chat-controls__inline-select-option chat-controls__model-option ${selected
        ? "chat-controls__inline-select-option--selected"
        : ""}"
      data-chat-model-option=${params.entry.value}
      data-chat-model-default=${params.entry.isDefault ? "true" : nothing}
      data-chat-model-index=${params.index}
      data-chat-model-keywords=${params.entry.isDefault
        ? t("chat.modelControls.default").toLocaleLowerCase()
        : nothing}
      data-chat-model-name=${modelLabel.toLocaleLowerCase()}
      data-chat-model-provider-label=${providerDisplayLabel(
        params.entry.provider,
      ).toLocaleLowerCase()}
      role="option"
      aria-selected=${selected ? "true" : "false"}
      type="button"
      ?disabled=${params.disabled || params.entry.disabled}
      @mouseenter=${(event: MouseEvent) =>
        params.onHighlight(event.currentTarget as HTMLButtonElement)}
      @click=${(event: MouseEvent) => params.onSelect(params.entry, event)}
    >
      <span class="chat-controls__model-option-provider">
        ${renderChatModelProviderIcon(params.entry.provider)}
      </span>
      <span class="chat-controls__model-option-copy">
        <span class="chat-controls__model-option-title">
          <span class="chat-controls__model-option-name">${modelLabel}</span>
          ${params.entry.isDefault
            ? html`<span
                class="chat-controls__model-state-label chat-controls__model-state-label--default"
                >${t("chat.modelControls.default")}</span
              >`
            : nothing}
        </span>
        ${modelMeta
          ? html`<span class="chat-controls__model-option-meta">${modelMeta}</span>`
          : nothing}
      </span>
      <span class="chat-controls__model-option-action">
        ${selected
          ? html`<span class="chat-controls__inline-select-check" aria-hidden="true"
              >${icons.check}</span
            >`
          : html`<kbd data-chat-model-shortcut="true" aria-hidden="true" hidden></kbd>`}
      </span>
    </button>
  `;
}

export function renderChatModelPickerTargetOption(params: {
  disabled: boolean;
  entry: ChatModelPickerTargetGroup["options"][number];
  groupId: string;
  groupLabel: string;
  index: number;
  onHighlight: (row: HTMLButtonElement) => void;
  onSelect: (groupId: string, value: string, event: MouseEvent) => void;
}) {
  return html`
    <button
      class="chat-controls__inline-select-option chat-controls__model-option"
      data-chat-model-option=${`target:${params.groupId}:${params.entry.value}`}
      data-chat-model-target=${params.entry.value}
      data-chat-model-index=${params.index}
      data-chat-model-name=${params.entry.label.toLocaleLowerCase()}
      data-chat-model-provider-label=${params.groupLabel.toLocaleLowerCase()}
      role="option"
      aria-selected="false"
      type="button"
      ?disabled=${params.disabled}
      @mouseenter=${(event: MouseEvent) =>
        params.onHighlight(event.currentTarget as HTMLButtonElement)}
      @click=${(event: MouseEvent) => params.onSelect(params.groupId, params.entry.value, event)}
    >
      <span
        class="chat-controls__model-option-provider chat-controls__target-icon"
        aria-hidden="true"
        >${icons.terminal}</span
      >
      <span class="chat-controls__model-option-copy">
        <span class="chat-controls__model-option-title">
          <span class="chat-controls__model-option-name">${params.entry.label}</span>
        </span>
      </span>
      <span class="chat-controls__model-option-action">
        <kbd data-chat-model-shortcut="true" aria-hidden="true" hidden></kbd>
      </span>
    </button>
  `;
}
