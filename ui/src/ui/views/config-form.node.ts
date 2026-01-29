import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../types";
import {
  defaultValue,
  hintForPath,
  humanize,
  isSensitivePath,
  pathKey,
  schemaType,
  type JsonSchema,
} from "./config-form.shared";

const META_KEYS = new Set(["title", "description", "default", "nullable"]);

function isAnySchema(schema: JsonSchema): boolean {
  const keys = Object.keys(schema ?? {}).filter((key) => !META_KEYS.has(key));
  return keys.length === 0;
}

function jsonValue(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

// SVG Icons as template literals
const icons = {
  chevronDown: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
  plus: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  minus: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  trash: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  edit: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`,
};

export function renderNode(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult | typeof nothing {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const type = schemaType(schema);
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;
  const key = pathKey(path);

  if (unsupported.has(key)) {
    return html`<div class="cfg-field cfg-field--error">
      <div class="cfg-field__label">${label}</div>
      <div class="cfg-field__error">Unsupported schema node. Use Raw mode.</div>
    </div>`;
  }

  // Handle anyOf/oneOf unions
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const nonNull = variants.filter(
      (v) => !(v.type === "null" || (Array.isArray(v.type) && v.type.includes("null")))
    );

    if (nonNull.length === 1) {
      return renderNode({ ...params, schema: nonNull[0] });
    }

    // Check if it's a set of literal values (enum-like)
    const extractLiteral = (v: JsonSchema): unknown | undefined => {
      if (v.const !== undefined) return v.const;
      if (v.enum && v.enum.length === 1) return v.enum[0];
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
          ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing}
          <div class="cfg-segmented">
            ${literals.map((lit, idx) => html`
              <button
                type="button"
                class="cfg-segmented__btn ${lit === resolvedValue || String(lit) === String(resolvedValue) ? 'active' : ''}"
                ?disabled=${disabled}
                @click=${() => onPatch(path, lit)}
              >
                ${String(lit)}
              </button>
            `)}
          </div>
        </div>
      `;
    }

    if (allLiterals && literals.length > 5) {
      // Use dropdown for larger sets
      return renderSelect({ ...params, options: literals, value: value ?? schema.default });
    }

    // Handle mixed primitive types
    const primitiveTypes = new Set(
      nonNull.map((variant) => schemaType(variant)).filter(Boolean)
    );
    const normalizedTypes = new Set(
      [...primitiveTypes].map((v) => (v === "integer" ? "number" : v))
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
  }

  // Enum - use segmented for small, dropdown for large
  if (schema.enum) {
    const options = schema.enum;
    if (options.length <= 5) {
      const resolvedValue = value ?? schema.default;
      return html`
        <div class="cfg-field">
          ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
          ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing}
          <div class="cfg-segmented">
            ${options.map((opt) => html`
              <button
                type="button"
                class="cfg-segmented__btn ${opt === resolvedValue || String(opt) === String(resolvedValue) ? 'active' : ''}"
                ?disabled=${disabled}
                @click=${() => onPatch(path, opt)}
              >
                ${String(opt)}
              </button>
            `)}
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
    const displayValue = typeof value === "boolean" ? value : typeof schema.default === "boolean" ? schema.default : false;
    return html`
      <label class="cfg-toggle-row ${disabled ? 'disabled' : ''}">
        <div class="cfg-toggle-row__content">
          <span class="cfg-toggle-row__label">${label}</span>
          ${help ? html`<span class="cfg-toggle-row__help">${help}</span>` : nothing}
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
  disabled: boolean;
  showLabel?: boolean;
  inputType: "text" | "number";
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch, inputType } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;
  const isSensitive = hint?.sensitive ?? isSensitivePath(path);
  const placeholder =
    hint?.placeholder ??
    (isSensitive ? "••••" : schema.default !== undefined ? `Default: ${schema.default}` : "");
  const displayValue = value ?? "";

  return html`
    <div class="cfg-field">
      ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
      ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing}
      <div class="cfg-input-wrap">
        <input
          type=${isSensitive ? "password" : inputType}
          class="cfg-input"
          placeholder=${placeholder}
          .value=${displayValue == null ? "" : String(displayValue)}
          ?disabled=${disabled}
          @input=${(e: Event) => {
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
            if (inputType === "number") return;
            const raw = (e.target as HTMLInputElement).value;
            onPatch(path, raw.trim());
          }}
        />
        ${schema.default !== undefined ? html`
          <button
            type="button"
            class="cfg-input__reset"
            title="Reset to default"
            ?disabled=${disabled}
            @click=${() => onPatch(path, schema.default)}
          >↺</button>
        ` : nothing}
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
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;
  const displayValue = value ?? schema.default ?? "";
  const numValue = typeof displayValue === "number" ? displayValue : 0;

  return html`
    <div class="cfg-field">
      ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
      ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing}
      <div class="cfg-number">
        <button
          type="button"
          class="cfg-number__btn"
          ?disabled=${disabled}
          @click=${() => onPatch(path, numValue - 1)}
        >−</button>
        <input
          type="number"
          class="cfg-number__input"
          .value=${displayValue == null ? "" : String(displayValue)}
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
        >+</button>
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
  options: unknown[];
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, disabled, options, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;
  const resolvedValue = value ?? schema.default;
  const currentIndex = options.findIndex(
    (opt) => opt === resolvedValue || String(opt) === String(resolvedValue),
  );
  const unset = "__unset__";

  return html`
    <div class="cfg-field">
      ${showLabel ? html`<label class="cfg-field__label">${label}</label>` : nothing}
      ${help ? html`<div class="cfg-field__help">${help}</div>` : nothing}
      <select
        class="cfg-select"
        ?disabled=${disabled}
        .value=${currentIndex >= 0 ? String(currentIndex) : unset}
        @change=${(e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          onPatch(path, val === unset ? undefined : options[Number(val)]);
        }}
      >
        <option value=${unset}>Select...</option>
        ${options.map((opt, idx) => html`
          <option value=${String(idx)}>${String(opt)}</option>
        `)}
      </select>
    </div>
  `;
}

function renderObject(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;

  const fallback = value ?? schema.default;
  const obj = fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? (fallback as Record<string, unknown>)
    : {};
  const props = schema.properties ?? {};
  const entries = Object.entries(props);

  // Sort by hint order
  const sorted = entries.sort((a, b) => {
    const orderA = hintForPath([...path, a[0]], hints)?.order ?? 0;
    const orderB = hintForPath([...path, b[0]], hints)?.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  const reserved = new Set(Object.keys(props));
  const additional = schema.additionalProperties;
  const allowExtra = Boolean(additional) && typeof additional === "object";

  // For top-level, don't wrap in collapsible
  if (path.length === 1) {
    return html`
      <div class="cfg-fields">
        ${sorted.map(([propKey, node]) =>
          renderNode({
            schema: node,
            value: obj[propKey],
            path: [...path, propKey],
            hints,
            unsupported,
            disabled,
            onPatch,
          })
        )}
        ${allowExtra ? renderMapField({
          schema: additional as JsonSchema,
          value: obj,
          path,
          hints,
          unsupported,
          disabled,
          reservedKeys: reserved,
          onPatch,
        }) : nothing}
      </div>
    `;
  }

  // Nested objects get collapsible treatment
  return html`
    <details class="cfg-object" open>
      <summary class="cfg-object__header">
        <span class="cfg-object__title">${label}</span>
        <span class="cfg-object__chevron">${icons.chevronDown}</span>
      </summary>
      ${help ? html`<div class="cfg-object__help">${help}</div>` : nothing}
      <div class="cfg-object__content">
        ${sorted.map(([propKey, node]) =>
          renderNode({
            schema: node,
            value: obj[propKey],
            path: [...path, propKey],
            hints,
            unsupported,
            disabled,
            onPatch,
          })
        )}
        ${allowExtra ? renderMapField({
          schema: additional as JsonSchema,
          value: obj,
          path,
          hints,
          unsupported,
          disabled,
          reservedKeys: reserved,
          onPatch,
        }) : nothing}
      </div>
    </details>
  `;
}

function renderArray(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  showLabel?: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;

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
        ${showLabel ? html`<span class="cfg-array__label">${label}</span>` : nothing}
        <span class="cfg-array__count">${arr.length} item${arr.length !== 1 ? 's' : ''}</span>
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

      ${arr.length === 0 ? html`
        <div class="cfg-array__empty">
          No items yet. Click "Add" to create one.
        </div>
      ` : html`
        <div class="cfg-array__items">
          ${arr.map((item, idx) => html`
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
                  unsupported,
                  disabled,
                  showLabel: false,
                  onPatch,
                })}
              </div>
            </div>
          `)}
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
  unsupported: Set<string>;
  disabled: boolean;
  reservedKeys: Set<string>;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): TemplateResult {
  const { schema, value, path, hints, unsupported, disabled, reservedKeys, onPatch } = params;
  const anySchema = isAnySchema(schema);
  const entries = Object.entries(value ?? {}).filter(([key]) => !reservedKeys.has(key));

  return html`
    <div class="cfg-map">
      <div class="cfg-map__header">
        <span class="cfg-map__label">Custom entries</span>
        <button
          type="button"
          class="cfg-map__add"
          ?disabled=${disabled}
          @click=${() => {
            const next = { ...(value ?? {}) };
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

      ${entries.length === 0 ? html`
        <div class="cfg-map__empty">No custom entries.</div>
      ` : html`
        <div class="cfg-map__items">
          ${entries.map(([key, entryValue]) => {
            const valuePath = [...path, key];
            const fallback = jsonValue(entryValue);
            return html`
              <div class="cfg-map__item">
                <div class="cfg-map__item-key">
                  <input
                    type="text"
                    class="cfg-input cfg-input--sm"
                    placeholder="Key"
                    .value=${key}
                    ?disabled=${disabled}
                    @change=${(e: Event) => {
                      const nextKey = (e.target as HTMLInputElement).value.trim();
                      if (!nextKey || nextKey === key) return;
                      const next = { ...(value ?? {}) };
                      if (nextKey in next) return;
                      next[nextKey] = next[key];
                      delete next[key];
                      onPatch(path, next);
                    }}
                  />
                </div>
                <div class="cfg-map__item-value">
                  ${anySchema
                    ? html`
                        <textarea
                          class="cfg-textarea cfg-textarea--sm"
                          placeholder="JSON value"
                          rows="2"
                          .value=${fallback}
                          ?disabled=${disabled}
                          @change=${(e: Event) => {
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
                      `
                    : renderNode({
                        schema,
                        value: entryValue,
                        path: valuePath,
                        hints,
                        unsupported,
                        disabled,
                        showLabel: false,
                        onPatch,
                      })}
                </div>
                <button
                  type="button"
                  class="cfg-map__item-remove"
                  title="Remove entry"
                  ?disabled=${disabled}
                  @click=${() => {
                    const next = { ...(value ?? {}) };
                    delete next[key];
                    onPatch(path, next);
                  }}
                >
                  ${icons.trash}
                </button>
              </div>
            `;
          })}
        </div>
      `}
    </div>
  `;
}
