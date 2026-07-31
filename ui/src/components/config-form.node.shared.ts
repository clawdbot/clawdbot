// Control UI helpers shared by config form node renderers.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { ConfigUiHints } from "../api/types.ts";
import { icons } from "../components/icons.ts";
import "../components/tooltip.ts";
import { t } from "../i18n/index.ts";
import { formatUnknownText } from "../lib/format.ts";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import type { ConfigSearchCriteria } from "./config-form.search.ts";
import {
  configFieldId,
  hasSensitiveConfigData,
  redactedPlaceholder,
  type JsonSchema,
} from "./config-form.shared.ts";
import { renderSettingsSegmented } from "./settings-ui.ts";

const META_KEYS = new Set([
  "title",
  "description",
  "default",
  "nullable",
  "enumIncludesNull",
  "tags",
  "x-tags",
]);
const jsonTextareaState = new WeakMap<
  HTMLTextAreaElement,
  { sourceValue: unknown; rowIdentity: unknown; fallback: string; pathKey: string }
>();

export type ConfigNodeRenderParams = {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  rawAvailable?: boolean;
  unsupported: Set<string>;
  disabled: boolean;
  isRequired?: boolean;
  sourceIdentity?: unknown;
  controlIdentity?: unknown;
  rowIdentity?: unknown;
  structuredDraftOwner?: boolean;
  showLabel?: boolean;
  /** Section shells own the title while collection rows still own help/default metadata. */
  showHeaderMeta?: boolean;
  searchCriteria?: ConfigSearchCriteria;
  revealSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => boolean | void;
  onRemove?: (path: Array<string | number>) => boolean | void;
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

export function schemaWithDefault(schema: JsonSchema, value: unknown): JsonSchema {
  return { ...schema, default: value };
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
  helpId?: string;
  defaultDescription?: unknown;
  tags: string[];
  showLabel: boolean;
  control: TemplateResult | typeof nothing;
  stacked?: boolean;
  error?: unknown;
}): TemplateResult {
  // Array/map item rows resolve their meta from the parent path (numeric and
  // wildcard segments collapse), so their help is the parent's. Showing it again
  // per item is noise; a row with no label of its own gets no help of its own.
  const help = params.showLabel ? params.help : undefined;
  const defaultDescription = params.showLabel ? params.defaultDescription : undefined;
  const hasText =
    params.showLabel ||
    Boolean(help) ||
    Boolean(defaultDescription) ||
    params.tags.length > 0 ||
    Boolean(params.error);
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
              ${help
                ? html`<span class="settings-row__desc" id=${params.helpId ?? nothing}
                    >${help}</span
                  >`
                : nothing}
              ${defaultDescription
                ? html`<span class="settings-row__desc">${defaultDescription}</span>`
                : nothing}
              ${renderTags(params.tags)}
              ${params.error
                ? html`<span class="cfg-field__error" role="alert">${params.error}</span>`
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

export function renderFlatDefaultRow(presentation: {
  description: TemplateResult | typeof nothing;
  action: TemplateResult | typeof nothing;
}): TemplateResult | typeof nothing {
  if (presentation.description === nothing && presentation.action === nothing) {
    return nothing;
  }
  return html`
    <div class="settings-row">
      ${presentation.description === nothing
        ? nothing
        : html`
            <div class="settings-row__text">
              <span class="settings-row__desc">${presentation.description}</span>
            </div>
          `}
      ${presentation.action === nothing
        ? nothing
        : html`<div class="settings-row__control">${presentation.action}</div>`}
    </div>
  `;
}

export function renderCollectionDefaultPresentation(
  params: ConfigNodeRenderParams,
  effectiveValue: unknown,
): {
  description: TemplateResult | typeof nothing;
  action: TemplateResult | typeof nothing;
} {
  const redacted = getSensitiveRenderState({
    path: params.path,
    value: effectiveValue,
    hints: params.hints,
    revealSensitive: params.revealSensitive ?? false,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
  }).isRedacted;
  return {
    description: redacted ? nothing : renderSchemaDefaultDescription(params.schema, params.value),
    action: renderRestoreDefaultButton({
      ...params,
      disabled: params.disabled || redacted,
    }),
  };
}

export function renderSchemaDefaultDescription(
  schema: JsonSchema,
  value: unknown,
): TemplateResult | typeof nothing {
  if (schema.default === undefined) {
    return nothing;
  }
  return html`${t(value === undefined ? "configForm.usingDefault" : "configForm.defaultValue", {
    value: formatUnknownText(schema.default),
  })}`;
}

export function renderRestoreDefaultButton(
  params: Pick<
    ConfigNodeRenderParams,
    "schema" | "value" | "path" | "disabled" | "isRequired" | "onPatch" | "onRemove"
  >,
): TemplateResult | typeof nothing {
  if (params.schema.default === undefined || params.value === undefined) {
    return nothing;
  }
  return html`
    <openclaw-tooltip .content=${t("configForm.resetToDefault")}>
      <button
        type="button"
        class="btn btn--icon"
        aria-label=${t("configForm.resetToDefault")}
        ?disabled=${params.disabled}
        @click=${(event: Event) => {
          event.stopPropagation();
          if (params.isRequired) {
            params.onPatch(params.path, structuredClone(params.schema.default));
            return;
          }
          if (params.onRemove) {
            params.onRemove(params.path);
            return;
          }
          params.onPatch(params.path, undefined);
        }}
      >
        ${icons.refresh}
      </button>
    </openclaw-tooltip>
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
  schema: JsonSchema;
  path: Array<string | number>;
  ariaLabel: string;
  descriptionId?: string;
  sourceValue: unknown;
  rowIdentity?: unknown;
  fallback: string;
  rows: number;
  sensitiveState: SensitiveRenderState;
  disabled: boolean;
  isRequired?: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => boolean | void;
}): TemplateResult {
  const { path, fallback, sensitiveState, disabled, onPatch } = params;
  const errorId = configFieldId(path, "json-error");
  const describedBy = [params.descriptionId, errorId].filter(Boolean).join(" ");
  const setValidity = (target: HTMLTextAreaElement, message: string) => {
    const error = target
      .closest(".cfg-json-editor")
      ?.querySelector<HTMLElement>(".cfg-field__error");
    target.setCustomValidity(message);
    target.setAttribute("aria-invalid", String(Boolean(message)));
    if (error) {
      error.hidden = !message;
      error.textContent = message;
    }
  };
  const updateValidity = (target: HTMLTextAreaElement) => {
    let message = "";
    const raw = target.value.trim();
    if (!raw && params.isRequired) {
      message = t("configForm.invalidJson");
    } else if (raw) {
      try {
        if (!isSupportedConfigValueValid(params.schema, JSON.parse(raw))) {
          message = t("configForm.invalidJson");
        }
      } catch {
        message = t("configForm.invalidJson");
      }
    }
    setValidity(target, message);
    return !message;
  };
  const renderedFallback = sensitiveState.isRedacted ? "" : fallback;
  const pathKey = JSON.stringify(path);
  const commitJsonValue = (target: HTMLTextAreaElement, candidate: unknown) => {
    if (onPatch(path, candidate) !== false) {
      return true;
    }
    target.value = renderedFallback;
    updateValidity(target);
    return false;
  };
  const textareaControl = html`
    <textarea
      ${ref((element) => {
        if (!(element instanceof HTMLTextAreaElement)) {
          return;
        }
        const previous = jsonTextareaState.get(element);
        if (
          previous &&
          (!Object.is(previous.sourceValue, params.sourceValue) ||
            !Object.is(previous.rowIdentity, params.rowIdentity) ||
            previous.fallback !== renderedFallback ||
            previous.pathKey !== pathKey)
        ) {
          element.value = renderedFallback;
          setValidity(element, "");
        }
        jsonTextareaState.set(element, {
          sourceValue: params.sourceValue,
          rowIdentity: params.rowIdentity,
          fallback: renderedFallback,
          pathKey,
        });
      })}
      class="settings-input${sensitiveState.isRedacted ? " cfg-redacted" : ""}"
      aria-label=${params.ariaLabel}
      aria-describedby=${describedBy || nothing}
      aria-invalid="false"
      placeholder=${sensitiveState.isRedacted ? redactedPlaceholder() : t("configForm.jsonValue")}
      rows=${params.rows}
      .value=${renderedFallback}
      ?disabled=${disabled}
      ?readonly=${sensitiveState.isRedacted}
      @click=${() => {
        if (sensitiveState.isRedacted && params.onToggleSensitivePath) {
          params.onToggleSensitivePath(path);
        }
      }}
      @input=${(event: Event) => {
        if (!sensitiveState.isRedacted) {
          updateValidity(event.target as HTMLTextAreaElement);
        }
      }}
      @change=${(event: Event) => {
        if (sensitiveState.isRedacted) {
          return;
        }
        const target = event.target as HTMLTextAreaElement;
        if (!updateValidity(target)) {
          return;
        }
        const raw = target.value.trim();
        if (!raw) {
          commitJsonValue(target, undefined);
          return;
        }
        try {
          commitJsonValue(target, JSON.parse(raw));
        } catch {
          // Input validity is already surfaced inline; preserve the draft until it is valid JSON.
        }
      }}
    ></textarea>
  `;
  return html`
    <span class="cfg-json-editor">
      ${wrapSensitiveControl(
        textareaControl,
        renderSensitiveToggleButton({
          path,
          state: sensitiveState,
          disabled,
          onToggleSensitivePath: params.onToggleSensitivePath,
        }),
      )}
      <span id=${errorId} class="cfg-field__error" role="alert" hidden></span>
    </span>
  `;
}
