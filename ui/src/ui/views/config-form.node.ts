import { html, nothing, type TemplateResult } from "lit";
import { formatUnknownText } from "../format.ts";
import { icons as sharedIcons } from "../icons.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../string-coerce.ts";
import type { ConfigUiHints } from "../types.ts";
import {
  defaultValue,
  hasSensitiveConfigData,
  hintForPath,
  humanize,
  pathKey,
  REDACTED_PLACEHOLDER,
  schemaType,
  type JsonSchema,
} from "./config-form.shared.ts";

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

// SVG Icons as template literals
const icons = {
  chevronDown: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `,
  plus: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  `,
  minus: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  `,
  trash: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="3 6 5 6 21 6"></polyline>
      <path
        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
      ></path>
    </svg>
  `,
  edit: html`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>
  `,
};

type FieldMeta = {
  label: string;
  help?: string;
  tags: string[];
};

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

export type ConfigSearchCriteria = {
  text: string;
  tags: string[];
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
  return html`
    <button
      type="button"
      class="btn btn--icon ${state.isRevealed ? "active" : ""}"
      style="width:28px;height:28px;padding:0;"
      title=${state.canReveal
        ? state.isRevealed
          ? "Hide value"
          : "Reveal value"
        : "Disable stream mode to reveal value"}
      aria-label=${state.canReveal
        ? state.isRevealed
          ? "Hide value"
          : "Reveal value"
        : "Disable stream mode to reveal value"}
      aria-pressed=${state.isRevealed}
      ?disabled=${params.disabled || !state.canReveal}
      @click=${() => params.onToggleSensitivePath?.(params.path)}
    >
      ${state.isRevealed ? sharedIcons.eye : sharedIcons.eyeOff}
    </button>
  `;
}

function hasSearchCriteria(criteria: ConfigSearchCriteria | undefined): boolean {
  return Boolean(criteria && (criteria.text.length > 0 || criteria.tags.length > 0));
}

export function parseConfigSearchQuery(query: string): ConfigSearchCriteria {
  const tags: string[] = [];
  const seen = new Set<string>();
  const raw = query.trim();
  const stripped = raw.replace(/(^|\s)tag:([^\s]+)/gi, (_, leading: string, token: string) => {
    const normalized = normalizeLowercaseStringOrEmpty(token);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      tags.push(normalized);
    }
    return leading;
  });
  return {
    text: normalizeLowercaseStringOrEmpty(stripped),
    tags,
  };
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") {
      continue;
    }
    const tag = value.trim();
    if (!tag) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(tag);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function resolveFieldMeta(
  path: Array<string | number>,
  schema: JsonSchema,
  hints: ConfigUiHints,
): FieldMeta {
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;
  const schemaTags = normalizeTags(schema["x-tags"] ?? schema.tags);
  const hintTags = normalizeTags(hint?.tags);
  return {
    label,
    help,
    tags: hintTags.length > 0 ? hintTags : schemaTags,
  };
}

function matchesText(text: string, candidates: Array<string | undefined>): boolean {
  if (!text) {
    return true;
  }
  for (const candidate of candidates) {
    if (normalizeOptionalLowercaseString(candidate)?.includes(text)) {
      return true;
    }
  }
  return false;
}

function matchesTags(filterTags: string[], fieldTags: string[]): boolean {
  if (filterTags.length === 0) {
    return true;
  }
  const normalized = new Set(fieldTags.map((tag) => normalizeLowercaseStringOrEmpty(tag)));
  return filterTags.every((tag) => normalized.has(tag));
}

function matchesNodeSelf(params: {
  schema: JsonSchema;
  path: Array<string | number>;
  hints: ConfigUiHints;
  criteria: ConfigSearchCriteria;
}): boolean {
  const { schema, path, hints, criteria } = params;
  if (!hasSearchCriteria(criteria)) {
    return true;
  }
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  if (!matchesTags(criteria.tags, tags)) {
    return false;
  }

  if (!criteria.text) {
    return true;
  }

  const pathLabel = path
    .filter((segment): segment is string => typeof segment === "string")
    .join(".");
  const enumText =
    schema.enum && schema.enum.length > 0
      ? schema.enum.map((value) => String(value)).join(" ")
      : "";

  return matchesText(criteria.text, [
    label,
    help,
    schema.title,
    schema.description,
    pathLabel,
    enumText,
  ]);
}

export function matchesNodeSearch(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  criteria: ConfigSearchCriteria;
}): boolean {
  const { schema, value, path, hints, criteria } = params;
  if (!hasSearchCriteria(criteria)) {
    return true;
  }
  if (matchesNodeSelf({ schema, path, hints, criteria })) {
    return true;
  }

  const type = schemaType(schema);
  if (type === "object") {
    const fallback = value ?? schema.default;
    const obj =
      fallback && typeof fallback === "object" && !Array.isArray(fallback)
        ? (fallback as Record<string, unknown>)
        : {};
    const props = schema.properties ?? {};
    for (const [propKey, node] of Object.entries(props)) {
      if (
        matchesNodeSearch({
          schema: node,
          value: obj[propKey],
          path: [...path, propKey],
          hints,
          criteria,
        })
      ) {
        return true;
      }
    }
    const additional = schema.additionalProperties;
    if (additional && typeof additional === "object") {
      const reserved = new Set(Object.keys(props));
      for (const [entryKey, entryValue] of Object.entries(obj)) {
        if (reserved.has(entryKey)) {
          continue;
        }
        if (
          matchesNodeSearch({
            schema: additional,
            value: entryValue,
            path: [...path, entryKey],
            hints,
            criteria,
          })
        ) {
          return true;
        }
      }
    }
    return false;
  }

  if (type === "array") {
    const itemsSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    if (!itemsSchema) {
      return false;
    }
    const arr = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : [];
    if (arr.length === 0) {
      return false;
    }
    for (let idx = 0; idx < arr.length; idx += 1) {
      if (
        matchesNodeSearch({
          schema: itemsSchema,
          value: arr[idx],
          path: [...path, idx],
          hints,
          criteria,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function renderTags(tags: string[]): TemplateResult | typeof nothing {
  if (tags.length === 0) {
    return nothing;
  }
  return html`
    <div class="cfg-tags">${tags.map((tag) => html`<span class="cfg-tag">${tag}</span>`)}</div>
  `;
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
    return html`<div class="cfg-field cfg-field--error">
      <div class="cfg-field__label">${label}</div>
      <div class="cfg-field__error">Unsupported schema node. Use Raw mode.</div>
    </div>`;
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
      return renderNode({ ...params, schema: nonNull[0] });
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
      return html`
        <div class="cfg-field">
          ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
          ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing} ${renderTags(tags)}
          <div class="cfg-segmented">
            ${literals.map(
              (lit) => html`
                <button
                  type="button"
                  class="cfg-segmented__btn ${matchesComparablePrimitiveValue(lit, resolvedValue)
                    ? "active"
                    : ""}"
                  ?disabled=${disabled}
                  @click=${() => onPatch(path, lit)}
                >
                  ${formatUnknownText(lit)}
                </button>
              `,
            )}
          </div>
        </div>
      `;
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
      return html`
        <div class="cfg-field">
          ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
          ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing} ${renderTags(tags)}
          <div class="cfg-segmented">
            ${options.map(
              (opt) => html`
                <button
                  type="button"
                  class="cfg-segmented__btn ${matchesComparablePrimitiveValue(opt, resolvedValue)
                    ? "active"
                    : ""}"
                  ?disabled=${disabled}
                  @click=${() => onPatch(path, opt)}
                >
                  ${formatUnknownText(opt)}
                </button>
              `,
            )}
          </div>
        </div>
      `;
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
    return html`
      <label class="cfg-toggle-row ${disabled ? "disabled" : ""}">
        <div class="cfg-toggle-row__content">
          <span class="cfg-toggle-row__label">${label}</span>
          ${help ? html`<span class="cfg-toggle-row__help">${help}</span>` : nothing}
          ${renderTags(tags)}
        </div>
        <div class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${displayValue}
            ?disabled=${disabled}
            @change=${(e: Event) => onPatch(path, (e.target as HTMLInputElement).checked)}
          />
          <span class="cfg-toggle__track"></span>
        </div>
      </label>
    `;
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
  return html`
    <div class="cfg-field cfg-field--error">
      <div class="cfg-field__label">${label}</div>
      <div class="cfg-field__error">Unsupported type: ${type}. Use Raw mode.</div>
    </div>
  `;
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
        ? "Structured value (SecretRef) - use Raw mode to edit"
        : "Structured value (SecretRef) - edit the config file directly"
      : REDACTED_PLACEHOLDER
    : (hint?.placeholder ??
      (schema.default !== undefined ? `Default: ${formatUnknownText(schema.default)}` : ""));
  const displayValue = effectiveRedacted
    ? ""
    : isStructuredValue
      ? jsonValue(value)
      : (value ?? "");
  const effectiveInputType = sensitiveState.isSensitive && !effectiveRedacted ? "text" : inputType;

  return html`
    <div class="cfg-field">
      ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
      ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing} ${renderTags(tags)}
      <div class="cfg-input-wrap">
        <input
          type=${effectiveInputType}
          class="cfg-input${effectiveRedacted ? " cfg-input--redacted" : ""}"
          placeholder=${placeholder}
          .value=${formatUnknownText(displayValue)}
          ?disabled=${disabled}
          ?readonly=${effectiveRedacted}
          @click=${() => {
            if (
              sensitiveState.isRedacted &&
              !isStructuredSecretRef &&
              params.onToggleSensitivePath
            ) {
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
              <button
                type="button"
                class="cfg-input__reset"
                title="Reset to default"
                ?disabled=${disabled || effectiveRedacted}
                @click=${() => onPatch(path, schema.default)}
              >
                ↺
              </button>
            `
          : nothing}
      </div>
    </div>
  `;
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
  const numValue = typeof displayValue === "number" ? displayValue : 0;

  return html`
    <div class="cfg-field">
      ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
      ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing} ${renderTags(tags)}
      <div class="cfg-number">
        <button
          type="button"
          class="cfg-number__btn"
          ?disabled=${disabled}
          @click=${() => onPatch(path, numValue - 1)}
        >
          −
        </button>
        <input
          type="number"
          class="cfg-number__input"
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
          class="cfg-number__btn"
          ?disabled=${disabled}
          @click=${() => onPatch(path, numValue + 1)}
        >
          +
        </button>
      </div>
    </div>
  `;
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

  return html`
    <div class="cfg-field">
      ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
      ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing} ${renderTags(tags)}
      <select
        class="cfg-select"
        ?disabled=${disabled}
        .value=${currentIndex >= 0 ? String(currentIndex) : unset}
        @change=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          onPatch(path, val === unset ? undefined : options[Number(val)]);
        }}
      >
        <option value=${unset} ?selected=${currentIndex < 0}>Select...</option>
        ${options.map(
          (opt, idx) =>
            html` <option value=${String(idx)} ?selected=${idx === currentIndex}>
              ${String(opt)}
            </option>`,
        )}
      </select>
    </div>
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
  const displayValue = sensitiveState.isRedacted ? "" : fallback;

  return html`
    <div class="cfg-field">
      ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
      ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing} ${renderTags(tags)}
      <div class="cfg-input-wrap">
        <textarea
          class="cfg-textarea${sensitiveState.isRedacted ? " cfg-textarea--redacted" : ""}"
          placeholder=${sensitiveState.isRedacted ? REDACTED_PLACEHOLDER : "JSON value"}
          rows="3"
          .value=${displayValue}
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
      </div>
    </div>
  `;
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

  // For top-level, don't wrap in collapsible
  if (path.length === 1) {
    return html` <div class="cfg-fields">${fields}</div> `;
  }

  if (!showLabel) {
    return html` <div class="cfg-fields cfg-fields--inline">${fields}</div> `;
  }

  // Nested objects get collapsible treatment
  return html`
    <details class="cfg-object" ?open=${path.length <= 2}>
      <summary class="cfg-object__header">
        <span class="cfg-object__title-wrap">
          <span class="cfg-object__title">${label}</span>
          ${renderTags(tags)}
        </span>
        <span class="cfg-object__chevron">${icons.chevronDown}</span>
      </summary>
      ${help ? html`<div class="cfg-object__help">${help}</div>` : nothing}
      <div class="cfg-object__content">${fields}</div>
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
    return html`
      <div class="cfg-field cfg-field--error">
        <div class="cfg-field__label">${label}</div>
        <div class="cfg-field__error">Unsupported array schema. Use Raw mode.</div>
      </div>
    `;
  }

  const arr = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : [];

  return html`
    <div class="cfg-array">
      <div class="cfg-array__header">
        <div class="cfg-array__title">
          ${showLabel ? html`<span class="cfg-array__label">${label}</span>` : nothing}
          ${renderTags(tags)}
        </div>
        <span class="cfg-array__count">${arr.length} item${arr.length !== 1 ? "s" : ""}</span>
        <button
          type="button"
          class="cfg-array__add"
          ?disabled=${disabled}
          @click=${() => {
            const next = [...arr, defaultValue(itemsSchema)];
            onPatch(path, next);
          }}
        >
          <span class="cfg-array__add-icon">${icons.plus}</span>
          Add
        </button>
      </div>
      ${help ? html`<div class="cfg-array__help">${help}</div>` : nothing}
      ${arr.length === 0
        ? html` <div class="cfg-array__empty">No items yet. Click "Add" to create one.</div> `
        : html`
            <div class="cfg-array__items">
              ${arr.map(
                (item, idx) => html`
                  <div class="cfg-array__item">
                    <div class="cfg-array__item-header">
                      <span class="cfg-array__item-index">#${idx + 1}</span>
                      <button
                        type="button"
                        class="cfg-array__item-remove"
                        title="Remove item"
                        ?disabled=${disabled}
                        @click=${() => {
                          const next = [...arr];
                          next.splice(idx, 1);
                          onPatch(path, next);
                        }}
                      >
                        ${icons.trash}
                      </button>
                    </div>
                    <div class="cfg-array__item-content">
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
                    </div>
                  </div>
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
    <div class="cfg-map">
      <div class="cfg-map__header">
        <span class="cfg-map__label">Custom entries</span>
        <button
          type="button"
          class="cfg-map__add"
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
          <span class="cfg-map__add-icon">${icons.plus}</span>
          Add Entry
        </button>
      </div>

      ${visibleEntries.length === 0
        ? html` <div class="cfg-map__empty">No custom entries.</div> `
        : html`
            <div class="cfg-map__items">
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
                  <div class="cfg-map__item">
                    <div class="cfg-map__item-header">
                      <div class="cfg-map__item-key">
                        <input
                          type="text"
                          class="cfg-input cfg-input--sm"
                          placeholder="Key"
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
                      <button
                        type="button"
                        class="cfg-map__item-remove"
                        title="Remove entry"
                        ?disabled=${disabled}
                        @click=${() => {
                          const next = { ...value };
                          delete next[key];
                          onPatch(path, next);
                        }}
                      >
                        ${icons.trash}
                      </button>
                    </div>
                    <div class="cfg-map__item-value">
                      ${anySchema
                        ? html`
                            <div class="cfg-input-wrap">
                              <textarea
                                class="cfg-textarea cfg-textarea--sm${sensitiveState.isRedacted
                                  ? " cfg-textarea--redacted"
                                  : ""}"
                                placeholder=${sensitiveState.isRedacted
                                  ? REDACTED_PLACEHOLDER
                                  : "JSON value"}
                                rows="2"
                                .value=${sensitiveState.isRedacted ? "" : fallback}
                                ?disabled=${disabled}
                                ?readonly=${sensitiveState.isRedacted}
                                @click=${() => {
                                  if (sensitiveState.isRedacted && onToggleSensitivePath) {
                                    onToggleSensitivePath(valuePath);
                                  }
                                }}
                                @change=${(e: Event) => {
                                  if (sensitiveState.isRedacted) {
                                    return;
                                  }
                                  const target = e.target as HTMLTextAreaElement;
                                  const raw = target.value.trim();
                                  if (!raw) {
                                    onPatch(valuePath, undefined);
                                    return;
                                  }
                                  try {
                                    onPatch(valuePath, JSON.parse(raw));
                                  } catch {
                                    target.value = fallback;
                                  }
                                }}
                              ></textarea>
                              ${renderSensitiveToggleButton({
                                path: valuePath,
                                state: sensitiveState,
                                disabled,
                                onToggleSensitivePath,
                              })}
                            </div>
                          `
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
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
    </div>
  `;
}
