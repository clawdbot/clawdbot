// Control UI helpers shared by config form node renderers.
import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../api/types.ts";
import { icons } from "../components/icons.ts";
import "../components/tooltip.ts";
import { t } from "../i18n/index.ts";
import { formatUnknownText } from "../lib/format.ts";
import type { ConfigSearchCriteria } from "./config-form.search.ts";
import {
  hasSensitiveConfigData,
  REDACTED_PLACEHOLDER,
  type JsonSchema,
} from "./config-form.shared.ts";
import { renderSettingsSegmented } from "./settings-ui.ts";

const META_KEYS = new Set(["title", "description", "default", "nullable", "tags", "x-tags"]);

export type ConfigNodeRenderParams = {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  rawAvailable?: boolean;
  unsupported: Set<string>;
  disabled: boolean;
  showLabel?: boolean;
  searchCriteria?: ConfigSearchCriteria;
  revealSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

export type ConfigNodeRenderer = (
  params: ConfigNodeRenderParams,
) => TemplateResult | typeof nothing;

type SensitiveRenderState = {
  isSensitive: boolean;
  isRedacted: boolean;
  isRevealed: boolean;
  canReveal: boolean;
};

export function isAnySchema(schema: JsonSchema): boolean {
  const keys = Object.keys(schema ?? {}).filter((key) => !META_KEYS.has(key));
  return keys.length === 0;
}

export function jsonValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

function formatComparablePrimitive(value: unknown): string | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return null;
}

function matchesComparablePrimitiveValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  const leftComparable = formatComparablePrimitive(left);
  const rightComparable = formatComparablePrimitive(right);
  return leftComparable !== null && leftComparable === rightComparable;
}

export function isSecretRefObject(value: unknown): value is {
  source: string;
  id: string;
  provider?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.source !== "string" || typeof candidate.id !== "string") {
    return false;
  }
  return candidate.provider === undefined || typeof candidate.provider === "string";
}

export function getSensitiveRenderState(params: {
  path: Array<string | number>;
  value: unknown;
  hints: ConfigUiHints;
  revealSensitive: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
}): SensitiveRenderState {
  const isSensitive = hasSensitiveConfigData(params.value, params.path, params.hints);
  const isRevealed =
    isSensitive &&
    (params.revealSensitive || (params.isSensitivePathRevealed?.(params.path) ?? false));
  return {
    isSensitive,
    isRedacted: isSensitive && !isRevealed,
    isRevealed,
    canReveal: isSensitive,
  };
}

export function renderSensitiveToggleButton(params: {
  path: Array<string | number>;
  state: SensitiveRenderState;
  disabled: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
}): TemplateResult | typeof nothing {
  const { state } = params;
  if (!state.isSensitive || !params.onToggleSensitivePath) {
    return nothing;
  }
  const label = state.canReveal
    ? state.isRevealed
      ? t("configForm.hideValue")
      : t("configForm.revealValue")
    : t("configForm.disableStreamToReveal");
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        type="button"
        class="settings-secret__toggle"
        aria-label=${label}
        aria-pressed=${state.isRevealed}
        ?disabled=${params.disabled || !state.canReveal}
        @click=${() => params.onToggleSensitivePath?.(params.path)}
      >
        ${state.isRevealed ? icons.eye : icons.eyeOff}
      </button>
    </openclaw-tooltip>
  `;
}

/* Sensitive fields inset the reveal eye inside the field (settings-secret
 * pattern); non-sensitive fields render the bare control unchanged. */
export function wrapSensitiveControl(
  control: TemplateResult,
  toggle: TemplateResult | typeof nothing,
): TemplateResult {
  if (toggle === nothing) {
    return control;
  }
  return html`<span class="settings-secret">${control}${toggle}</span>`;
}

export function renderTags(tags: string[]): TemplateResult | typeof nothing {
  const visibleTags = tags.filter((tag) => tag !== "advanced");
  if (visibleTags.length === 0) {
    return nothing;
  }
  return html`
    <div class="cfg-tags">
      ${visibleTags.map((tag) => html`<span class="cfg-tag">${tag}</span>`)}
    </div>
  `;
}

export function renderFieldRow(params: {
  label: unknown;
  help?: unknown;
  tags: string[];
  showLabel: boolean;
  control: TemplateResult | typeof nothing;
  stacked?: boolean;
  error?: unknown;
}): TemplateResult {
  const hasText =
    params.showLabel || Boolean(params.help) || params.tags.length > 0 || Boolean(params.error);
  // Control-only rows (array/map item values) stack so the control gets full width.
  const stacked = params.stacked || !hasText;
  const className = stacked ? "settings-row settings-row--stacked" : "settings-row";
  return html`
    <div class=${className}>
      ${hasText
        ? html`
            <div class="settings-row__text">
              ${params.showLabel
                ? html`<span class="settings-row__title">${params.label}</span>`
                : nothing}
              ${params.help
                ? html`<span class="settings-row__desc">${params.help}</span>`
                : nothing}
              ${renderTags(params.tags)}
              ${params.error
                ? html`<span class="cfg-field__error">${params.error}</span>`
                : nothing}
            </div>
          `
        : nothing}
      ${params.control !== nothing
        ? html`<div class="settings-row__control">${params.control}</div>`
        : nothing}
    </div>
  `;
}

export function renderSegmentedControl(params: {
  options: unknown[];
  resolvedValue: unknown;
  disabled: boolean;
  ariaLabel: string;
  onSelect: (value: unknown) => void;
}): TemplateResult {
  const selectedIndex = params.options.findIndex((option) =>
    matchesComparablePrimitiveValue(option, params.resolvedValue),
  );
  return renderSettingsSegmented({
    value: selectedIndex < 0 ? "" : String(selectedIndex),
    options: params.options.map((option, index) => ({
      value: String(index),
      label: formatUnknownText(option),
    })),
    disabled: params.disabled,
    ariaLabel: params.ariaLabel,
    onChange: (index) => {
      const option = params.options[Number(index)];
      if (option !== undefined) {
        params.onSelect(option);
      }
    },
  });
}

export function renderJsonTextareaControl(params: {
  path: Array<string | number>;
  fallback: string;
  rows: number;
  sensitiveState: SensitiveRenderState;
  disabled: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { path, fallback, sensitiveState, disabled, onPatch } = params;
  const textareaControl = html`
    <textarea
      class="settings-input${sensitiveState.isRedacted ? " cfg-redacted" : ""}"
      placeholder=${sensitiveState.isRedacted ? REDACTED_PLACEHOLDER : t("configForm.jsonValue")}
      rows=${params.rows}
      .value=${sensitiveState.isRedacted ? "" : fallback}
      ?disabled=${disabled}
      ?readonly=${sensitiveState.isRedacted}
      @click=${() => {
        if (sensitiveState.isRedacted && params.onToggleSensitivePath) {
          params.onToggleSensitivePath(path);
        }
      }}
      @change=${(event: Event) => {
        if (sensitiveState.isRedacted) {
          return;
        }
        const target = event.target as HTMLTextAreaElement;
        const raw = target.value.trim();
        if (!raw) {
          onPatch(path, undefined);
          return;
        }
        try {
          onPatch(path, JSON.parse(raw));
        } catch {
          target.value = fallback;
        }
      }}
    ></textarea>
  `;
  return wrapSensitiveControl(
    textareaControl,
    renderSensitiveToggleButton({
      path,
      state: sensitiveState,
      disabled,
      onToggleSensitivePath: params.onToggleSensitivePath,
    }),
  );
}
