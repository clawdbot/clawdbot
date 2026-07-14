// Control UI view renders config form screen content.
import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../api/types.ts";
import { icons } from "../components/icons.ts";
import "../components/tooltip.ts";
import { t } from "../i18n/index.ts";
import { formatUnknownText } from "../lib/format.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSearch,
  matchesNodeSelf,
  resolveConfigFieldMeta as resolveFieldMeta,
  type ConfigSearchCriteria,
} from "./config-form.search.ts";
import {
  defaultValue,
  hasSensitiveConfigData,
  hintForPath,
  pathKey,
  REDACTED_PLACEHOLDER,
  schemaType,
  type JsonSchema,
} from "./config-form.shared.ts";
import {
  renderSettingsEmpty,
  renderSettingsSegmented,
  renderSettingsToggle,
  renderSettingsToggleRow,
} from "./settings-ui.ts";

const META_KEYS = new Set(["title", "description", "default", "nullable", "tags", "x-tags"]);

function isAnySchema(schema: JsonSchema): boolean {
  const keys = Object.keys(schema ?? {}).filter((key) => !META_KEYS.has(key));
  return keys.length === 0;
}

function jsonValue(value: unknown): string {
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

function isSecretRefObject(value: unknown): value is {
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

type SensitiveRenderParams = {
  path: Array<string | number>;
  value: unknown;
  hints: ConfigUiHints;
  revealSensitive: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
};

type SensitiveRenderState = {
  isSensitive: boolean;
  isRedacted: boolean;
  isRevealed: boolean;
  canReveal: boolean;
};

function getSensitiveRenderState(params: SensitiveRenderParams): SensitiveRenderState {
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

function renderSensitiveToggleButton(params: {
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
        class="btn btn--icon ${state.isRevealed ? "active" : ""}"
        style="width:28px;height:28px;padding:0;"
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

function renderTags(tags: string[]): TemplateResult | typeof nothing {
  if (tags.length === 0) {
    return nothing;
  }
  return html`
    <div class="cfg-tags">${tags.map((tag) => html`<span class="cfg-tag">${tag}</span>`)}</div>
  `;
}

type FieldRowParams = {
  label: unknown;
  help?: unknown;
  tags: string[];
  showLabel: boolean;
  control: TemplateResult | typeof nothing;
  stacked?: boolean;
  error?: unknown;
};

/** One settings-row: title/help/tags left, exactly one control cluster right. */
function renderFieldRow(params: FieldRowParams): TemplateResult {
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

function renderSegmentedControl(params: {
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

export function renderNode(params: {
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
}): TemplateResult | typeof nothing {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const type = schemaType(schema);
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const key = pathKey(path);
  const criteria = params.searchCriteria;

  if (unsupported.has(key)) {
    return renderFieldRow({
      label,
      tags: [],
      showLabel: true,
      control: nothing,
      error: t("configForm.unsupportedNode"),
    });
  }
  if (
    criteria &&
    hasSearchCriteria(criteria) &&
    !matchesNodeSearch({ schema, value, path, hints, criteria })
  ) {
    return nothing;
  }

  // Handle anyOf/oneOf unions
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const nonNull = variants.filter(
      (v) => !(v.type === "null" || (Array.isArray(v.type) && v.type.includes("null"))),
    );

    if (nonNull.length === 1) {
      const selectedSchema = nonNull[0];
      return selectedSchema ? renderNode({ ...params, schema: selectedSchema }) : nothing;
    }

    // Check if it's a set of literal values (enum-like)
    const extractLiteral = (v: JsonSchema): unknown => {
      if (v.const !== undefined) {
        return v.const;
      }
      if (v.enum && v.enum.length === 1) {
        return v.enum[0];
      }
      return undefined;
    };
    const literals = nonNull.map(extractLiteral);
    const allLiterals = literals.every((v) => v !== undefined);

    if (allLiterals && literals.length > 0 && literals.length <= 5) {
      // Use segmented control for small sets
      const resolvedValue = value ?? schema.default;
      return renderFieldRow({
        label,
        help,
        tags,
        showLabel,
        control: renderSegmentedControl({
          options: literals,
          resolvedValue,
          disabled,
          ariaLabel: label,
          onSelect: (literal) => onPatch(path, literal),
        }),
      });
    }

    if (allLiterals && literals.length > 5) {
      // Use dropdown for larger sets
      return renderSelect({ ...params, options: literals, value: value ?? schema.default });
    }

    // Handle mixed primitive types
    const primitiveTypes = new Set(nonNull.map((variant) => schemaType(variant)).filter(Boolean));
    const normalizedTypes = new Set(
      [...primitiveTypes].map((v) => (v === "integer" ? "number" : v)),
    );

    if ([...normalizedTypes].every((v) => ["string", "number", "boolean"].includes(v as string))) {
      const hasString = normalizedTypes.has("string");
      const hasNumber = normalizedTypes.has("number");
      const hasBoolean = normalizedTypes.has("boolean");

      if (hasBoolean && normalizedTypes.size === 1) {
        return renderNode({
          ...params,
          schema: { ...schema, type: "boolean", anyOf: undefined, oneOf: undefined },
        });
      }

      if (hasString || hasNumber) {
        return renderTextInput({
          ...params,
          inputType: hasNumber && !hasString ? "number" : "text",
        });
      }
    }

    // Complex union (e.g. array | object) — render as JSON textarea
    return renderJsonTextarea({
      schema,
      value,
      path,
      hints,
      disabled,
      showLabel,
      revealSensitive: params.revealSensitive ?? false,
      isSensitivePathRevealed: params.isSensitivePathRevealed,
      onToggleSensitivePath: params.onToggleSensitivePath,
      onPatch,
    });
  }

  // Enum - use segmented for small, dropdown for large
  if (schema.enum) {
    const options = schema.enum;
    if (options.length <= 5) {
      const resolvedValue = value ?? schema.default;
      return renderFieldRow({
        label,
        help,
        tags,
        showLabel,
        control: renderSegmentedControl({
          options,
          resolvedValue,
          disabled,
          ariaLabel: label,
          onSelect: (option) => onPatch(path, option),
        }),
      });
    }
    return renderSelect({ ...params, options, value: value ?? schema.default });
  }

  // Object type - collapsible section
  if (type === "object") {
    return renderObject(params);
  }

  // Array type
  if (type === "array") {
    return renderArray(params);
  }

  // Boolean - toggle row
  if (type === "boolean") {
    const displayValue =
      typeof value === "boolean"
        ? value
        : typeof schema.default === "boolean"
          ? schema.default
          : false;
    const onChange = (checked: boolean) => onPatch(path, checked);
    if (!showLabel) {
      // Control-only contexts (array items, map values) have no visible title,
      // so the switch keeps its accessible name from the field label.
      return renderFieldRow({
        label,
        help,
        tags,
        showLabel,
        control: renderSettingsToggle({
          checked: displayValue,
          disabled,
          ariaLabel: label,
          onChange,
        }),
      });
    }
    const description =
      help || tags.length > 0 ? html`${help ?? nothing}${renderTags(tags)}` : undefined;
    return renderSettingsToggleRow({
      title: label,
      description,
      checked: displayValue,
      disabled,
      onChange,
    });
  }

  // Number/Integer
  if (type === "number" || type === "integer") {
    return renderNumberInput(params);
  }

  // String
  if (type === "string") {
    return renderTextInput({ ...params, inputType: "text" });
  }

  // Fallback
  return renderFieldRow({
    label,
    tags: [],
    showLabel: true,
    control: nothing,
    error: t("configForm.unsupportedType", { type: String(type) }),
  });
}

function renderTextInput(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  rawAvailable?: boolean;
  disabled: boolean;
  showLabel?: boolean;
  searchCriteria?: ConfigSearchCriteria;
  revealSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  inputType: "text" | "number";
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch, inputType } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const sensitiveState = getSensitiveRenderState({
    path,
    value,
    hints,
    revealSensitive: params.revealSensitive ?? false,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
  });
  const isStructuredValue =
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
  const isStructuredSecretRef = isSecretRefObject(value);
  const rawAvailable = params.rawAvailable ?? true;
  const effectiveRedacted = sensitiveState.isRedacted || isStructuredSecretRef;
  const placeholder = effectiveRedacted
    ? isStructuredSecretRef
      ? rawAvailable
        ? t("configForm.structuredSecretRaw")
        : t("configForm.structuredSecretFile")
      : REDACTED_PLACEHOLDER
    : (hint?.placeholder ??
      (schema.default !== undefined
        ? t("configForm.defaultValue", { value: formatUnknownText(schema.default) })
        : ""));
  const displayValue = effectiveRedacted
    ? ""
    : isStructuredValue
      ? jsonValue(value)
      : (value ?? "");
  const effectiveInputType = sensitiveState.isSensitive && !effectiveRedacted ? "text" : inputType;

  const control = html`
    <input
      type=${effectiveInputType}
      class="settings-input${effectiveRedacted ? " cfg-redacted" : ""}"
      placeholder=${placeholder}
      .value=${formatUnknownText(displayValue)}
      ?disabled=${disabled}
      ?readonly=${effectiveRedacted}
      @click=${() => {
        if (sensitiveState.isRedacted && !isStructuredSecretRef && params.onToggleSensitivePath) {
          params.onToggleSensitivePath(path);
        }
      }}
      @input=${(e: Event) => {
        if (effectiveRedacted) {
          return;
        }
        const raw = (e.target as HTMLInputElement).value;
        if (inputType === "number") {
          if (raw.trim() === "") {
            onPatch(path, undefined);
            return;
          }
          const parsed = Number(raw);
          onPatch(path, Number.isNaN(parsed) ? raw : parsed);
          return;
        }
        onPatch(path, raw);
      }}
      @change=${(e: Event) => {
        if (inputType === "number" || effectiveRedacted) {
          return;
        }
        const raw = (e.target as HTMLInputElement).value;
        onPatch(path, raw.trim());
      }}
    />
    ${isStructuredSecretRef
      ? nothing
      : renderSensitiveToggleButton({
          path,
          state: sensitiveState,
          disabled,
          onToggleSensitivePath: params.onToggleSensitivePath,
        })}
    ${schema.default !== undefined
      ? html`
          <openclaw-tooltip .content=${t("configForm.resetToDefault")}>
            <button
              type="button"
              class="btn btn--icon"
              style="width:28px;height:28px;padding:0;"
              aria-label=${t("configForm.resetToDefault")}
              ?disabled=${disabled || effectiveRedacted}
              @click=${() => onPatch(path, schema.default)}
            >
              ↺
            </button>
          </openclaw-tooltip>
        `
      : nothing}
  `;

  return renderFieldRow({ label, help, tags, showLabel, control });
}

function renderNumberInput(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  disabled: boolean;
  showLabel?: boolean;
  searchCriteria?: ConfigSearchCriteria;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const displayValue = value ?? schema.default ?? "";

  // Touch devices and some browsers hide native number spinners; keep explicit
  // one-step adjust buttons so single-step edits stay possible without typing.
  const step = (delta: number) => {
    if (disabled) {
      return;
    }
    const current = Number(displayValue);
    const base = Number.isFinite(current) ? current : 0;
    onPatch(path, base + delta);
  };
  const control = html`
    <button
      type="button"
      class="btn btn--sm btn--icon"
      aria-label=${`${label}: -1`}
      ?disabled=${disabled}
      @click=${() => step(-1)}
    >
      −
    </button>
    <input
      type="number"
      class="settings-input"
      aria-label=${label}
      .value=${formatUnknownText(displayValue)}
      ?disabled=${disabled}
      @input=${(e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        const parsed = raw === "" ? undefined : Number(raw);
        onPatch(path, parsed);
      }}
    />
    <button
      type="button"
      class="btn btn--sm btn--icon"
      aria-label=${`${label}: +1`}
      ?disabled=${disabled}
      @click=${() => step(1)}
    >
      +
    </button>
  `;

  return renderFieldRow({ label, help, tags, showLabel, control });
}

function renderSelect(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  disabled: boolean;
  showLabel?: boolean;
  searchCriteria?: ConfigSearchCriteria;
  options: unknown[];
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, options, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const resolvedValue = value ?? schema.default;
  const currentIndex = options.findIndex(
    (opt) => opt === resolvedValue || String(opt) === String(resolvedValue),
  );
  const unset = "__unset__";

  const control = html`
    <select
      class="settings-select"
      ?disabled=${disabled}
      .value=${currentIndex >= 0 ? String(currentIndex) : unset}
      @change=${(e: Event) => {
        const val = (e.target as HTMLSelectElement).value;
        onPatch(path, val === unset ? undefined : options[Number(val)]);
      }}
    >
      <option value=${unset} ?selected=${currentIndex < 0}>${t("configForm.select")}</option>
      ${options.map(
        (opt, idx) =>
          html` <option value=${String(idx)} ?selected=${idx === currentIndex}>
            ${String(opt)}
          </option>`,
      )}
    </select>
  `;

  return renderFieldRow({ label, help, tags, showLabel, control });
}

function renderJsonTextareaControl(params: {
  path: Array<string | number>;
  fallback: string;
  rows: number;
  sensitiveState: SensitiveRenderState;
  disabled: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { path, fallback, sensitiveState, disabled, onPatch } = params;
  return html`
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
      @change=${(e: Event) => {
        if (sensitiveState.isRedacted) {
          return;
        }
        const target = e.target as HTMLTextAreaElement;
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
    ${renderSensitiveToggleButton({
      path,
      state: sensitiveState,
      disabled,
      onToggleSensitivePath: params.onToggleSensitivePath,
    })}
  `;
}

function renderJsonTextarea(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  disabled: boolean;
  showLabel?: boolean;
  revealSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const fallback = jsonValue(value);
  const sensitiveState = getSensitiveRenderState({
    path,
    value,
    hints,
    revealSensitive: params.revealSensitive ?? false,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
  });

  return renderFieldRow({
    label,
    help,
    tags,
    showLabel,
    stacked: true,
    control: renderJsonTextareaControl({
      path,
      fallback,
      rows: 3,
      sensitiveState,
      disabled,
      onToggleSensitivePath: params.onToggleSensitivePath,
      onPatch,
    }),
  });
}

function renderObject(params: {
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
}): TemplateResult {
  const {
    schema,
    value,
    path,
    hints,
    unsupported,
    disabled,
    onPatch,
    searchCriteria,
    rawAvailable,
    revealSensitive,
    isSensitivePathRevealed,
    onToggleSensitivePath,
  } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;

  const fallback = value ?? schema.default;
  const obj =
    fallback && typeof fallback === "object" && !Array.isArray(fallback)
      ? (fallback as Record<string, unknown>)
      : {};
  const props = schema.properties ?? {};
  const entries = Object.entries(props);

  // Sort by hint order
  const sorted = entries.toSorted((a, b) => {
    const orderA = hintForPath([...path, a[0]], hints)?.order ?? 0;
    const orderB = hintForPath([...path, b[0]], hints)?.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a[0].localeCompare(b[0]);
  });

  const reserved = new Set(Object.keys(props));
  const additional = schema.additionalProperties;
  const allowExtra = Boolean(additional) && typeof additional === "object";

  const fields = html`
    ${sorted.map(([propKey, node]) =>
      renderNode({
        schema: node,
        value: obj[propKey],
        path: [...path, propKey],
        hints,
        rawAvailable,
        unsupported,
        disabled,
        searchCriteria: childSearchCriteria,
        revealSensitive,
        isSensitivePathRevealed,
        onToggleSensitivePath,
        onPatch,
      }),
    )}
    ${allowExtra
      ? renderMapField({
          schema: additional,
          value: obj,
          path,
          hints,
          rawAvailable,
          unsupported,
          disabled,
          reservedKeys: reserved,
          searchCriteria: childSearchCriteria,
          revealSensitive,
          isSensitivePathRevealed,
          onToggleSensitivePath,
          onPatch,
        })
      : nothing}
  `;

  // Top-level objects and label-less contexts emit rows directly into the
  // surrounding settings-group so row dividers stay sibling-driven.
  if (path.length === 1 || !showLabel) {
    return html`${fields}`;
  }

  // Nested objects get collapsible treatment as an indented sub-block.
  return html`
    <details class="cfg-object cfg-block" ?open=${path.length <= 2}>
      <summary class="settings-row cfg-object__summary">
        <div class="settings-row__text">
          <span class="settings-row__title">${label}</span>
          ${help ? html`<span class="settings-row__desc">${help}</span>` : nothing}
          ${renderTags(tags)}
        </div>
        <span class="settings-row__chevron cfg-object__chevron">${icons.chevronDown}</span>
      </summary>
      <div class="settings-subrows">${fields}</div>
    </details>
  `;
}

function renderArray(params: {
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
}): TemplateResult {
  const {
    schema,
    value,
    path,
    hints,
    unsupported,
    disabled,
    onPatch,
    searchCriteria,
    rawAvailable,
    revealSensitive,
    isSensitivePathRevealed,
    onToggleSensitivePath,
  } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;

  const itemsSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (!itemsSchema) {
    return renderFieldRow({
      label,
      tags: [],
      showLabel: true,
      control: nothing,
      error: t("configForm.unsupportedArray"),
    });
  }

  const arr = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : [];

  return html`
    <div class="cfg-block cfg-array">
      <div class="settings-row">
        <div class="settings-row__text">
          ${showLabel ? html`<span class="settings-row__title">${label}</span>` : nothing}
          ${help ? html`<span class="settings-row__desc">${help}</span>` : nothing}
          ${renderTags(tags)}
        </div>
        <div class="settings-row__control">
          <span class="settings-row__value"
            >${t(arr.length === 1 ? "configForm.itemCountOne" : "configForm.itemCount", {
              count: String(arr.length),
            })}</span
          >
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${disabled}
            @click=${() => {
              const next = [...arr, defaultValue(itemsSchema)];
              onPatch(path, next);
            }}
          >
            ${t("configForm.add")}
          </button>
        </div>
      </div>
      ${arr.length === 0
        ? renderSettingsEmpty(t("configForm.noItems"))
        : html`
            <div class="settings-subrows">
              ${arr.map(
                (item, idx) => html`
                  <div class="settings-row">
                    <div class="settings-row__text">
                      <span class="settings-row__title">#${idx + 1}</span>
                    </div>
                    <div class="settings-row__control">
                      <openclaw-tooltip .content=${t("configForm.removeItem")}>
                        <button
                          type="button"
                          class="btn btn--icon"
                          style="width:28px;height:28px;padding:0;"
                          aria-label=${t("configForm.removeItem")}
                          ?disabled=${disabled}
                          @click=${() => {
                            const next = [...arr];
                            next.splice(idx, 1);
                            onPatch(path, next);
                          }}
                        >
                          ${icons.trash}
                        </button>
                      </openclaw-tooltip>
                    </div>
                  </div>
                  ${renderNode({
                    schema: itemsSchema,
                    value: item,
                    path: [...path, idx],
                    hints,
                    rawAvailable,
                    unsupported,
                    disabled,
                    searchCriteria: childSearchCriteria,
                    showLabel: false,
                    revealSensitive,
                    isSensitivePathRevealed,
                    onToggleSensitivePath,
                    onPatch,
                  })}
                `,
              )}
            </div>
          `}
    </div>
  `;
}

function renderMapField(params: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: Array<string | number>;
  hints: ConfigUiHints;
  rawAvailable?: boolean;
  unsupported: Set<string>;
  disabled: boolean;
  reservedKeys: Set<string>;
  searchCriteria?: ConfigSearchCriteria;
  revealSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const {
    schema,
    value,
    path,
    hints,
    rawAvailable,
    unsupported,
    disabled,
    reservedKeys,
    onPatch,
    searchCriteria,
    revealSensitive,
    isSensitivePathRevealed,
    onToggleSensitivePath,
  } = params;
  const anySchema = isAnySchema(schema);
  const entries = Object.entries(value ?? {}).filter(([key]) => !reservedKeys.has(key));
  const visibleEntries =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? entries.filter(([key, entryValue]) =>
          matchesNodeSearch({
            schema,
            value: entryValue,
            path: [...path, key],
            hints,
            criteria: searchCriteria,
          }),
        )
      : entries;

  return html`
    <div class="cfg-block cfg-map">
      <div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">${t("configForm.customEntries")}</span>
        </div>
        <div class="settings-row__control">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${disabled}
            @click=${() => {
              const next = { ...value };
              let index = 1;
              let key = `custom-${index}`;
              while (key in next) {
                index += 1;
                key = `custom-${index}`;
              }
              next[key] = anySchema ? {} : defaultValue(schema);
              onPatch(path, next);
            }}
          >
            ${t("configForm.addEntry")}
          </button>
        </div>
      </div>

      ${visibleEntries.length === 0
        ? renderSettingsEmpty(t("configForm.noCustomEntries"))
        : html`
            <div class="settings-subrows">
              ${visibleEntries.map(([key, entryValue]) => {
                const valuePath = [...path, key];
                const fallback = jsonValue(entryValue);
                const sensitiveState = getSensitiveRenderState({
                  path: valuePath,
                  value: entryValue,
                  hints,
                  revealSensitive: revealSensitive ?? false,
                  isSensitivePathRevealed,
                });
                return html`
                  <div class="settings-row">
                    <div class="settings-row__text">
                      <input
                        type="text"
                        class="settings-input"
                        placeholder=${t("configForm.key")}
                        aria-label=${t("configForm.key")}
                        .value=${key}
                        ?disabled=${disabled}
                        @change=${(e: Event) => {
                          const nextKey = (e.target as HTMLInputElement).value.trim();
                          if (!nextKey || nextKey === key) {
                            return;
                          }
                          const next = { ...value };
                          if (nextKey in next) {
                            return;
                          }
                          next[nextKey] = next[key];
                          delete next[key];
                          onPatch(path, next);
                        }}
                      />
                    </div>
                    <div class="settings-row__control">
                      <openclaw-tooltip .content=${t("configForm.removeEntry")}>
                        <button
                          type="button"
                          class="btn btn--icon"
                          style="width:28px;height:28px;padding:0;"
                          aria-label=${t("configForm.removeEntry")}
                          ?disabled=${disabled}
                          @click=${() => {
                            const next = { ...value };
                            delete next[key];
                            onPatch(path, next);
                          }}
                        >
                          ${icons.trash}
                        </button>
                      </openclaw-tooltip>
                    </div>
                  </div>
                  ${anySchema
                    ? renderFieldRow({
                        label: key,
                        tags: [],
                        showLabel: false,
                        stacked: true,
                        control: renderJsonTextareaControl({
                          path: valuePath,
                          fallback,
                          rows: 2,
                          sensitiveState,
                          disabled,
                          onToggleSensitivePath,
                          onPatch,
                        }),
                      })
                    : renderNode({
                        schema,
                        value: entryValue,
                        path: valuePath,
                        hints,
                        rawAvailable,
                        unsupported,
                        disabled,
                        searchCriteria,
                        showLabel: false,
                        revealSensitive,
                        isSensitivePathRevealed,
                        onToggleSensitivePath,
                        onPatch,
                      })}
                `;
              })}
            </div>
          `}
    </div>
  `;
}
