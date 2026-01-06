import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHint, ConfigUiHints } from "../types";

export type ConfigFormProps = {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  disabled?: boolean;
  unsupportedPaths?: string[];
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
};

export function renderConfigForm(props: ConfigFormProps) {
  if (!props.schema) {
    return html`<div class="muted">Schema unavailable.</div>`;
  }
  const schema = props.schema;
  const value = props.value ?? {};
  if (schemaType(schema) !== "object" || !schema.properties) {
    return html`<div class="callout danger">Unsupported schema. Use Raw.</div>`;
  }
  const unsupported = new Set(props.unsupportedPaths ?? []);
  const entries = Object.entries(schema.properties);
  const sorted = entries.sort((a, b) => {
    const orderA = hintForPath([a[0]], props.uiHints)?.order ?? 0;
    const orderB = hintForPath([b[0]], props.uiHints)?.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  return html`
    <div class="config-form">
      ${sorted.map(([key, node]) =>
        renderNode({
          schema: node,
          value: (value as Record<string, unknown>)[key],
          path: [key],
          hints: props.uiHints,
          unsupported,
          disabled: props.disabled ?? false,
          onPatch: props.onPatch,
        }),
      )}
    </div>
  `;
}

function renderNode(params: {
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
    return html`<div class="callout danger">
      ${label}: unsupported schema node. Use Raw.
    </div>`;
  }

  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const nonNull = variants.filter(
      (v) => !(v.type === "null" || (Array.isArray(v.type) && v.type.includes("null"))),
    );

    if (nonNull.length === 1) {
      return renderNode({ ...params, schema: nonNull[0] });
    }

    const extractLiteral = (v: JsonSchema): unknown | undefined => {
      if (v.const !== undefined) return v.const;
      if (v.enum && v.enum.length === 1) return v.enum[0];
      return undefined;
    };
    const literals = nonNull.map(extractLiteral);
    const allLiterals = literals.every((v) => v !== undefined);

    if (allLiterals && literals.length > 0) {
      const currentIndex = literals.findIndex(
        (lit) => lit === value || String(lit) === String(value),
      );
      return html`
        <label class="field">
          ${showLabel ? html`<span>${label}</span>` : nothing}
          ${help ? html`<div class="muted">${help}</div>` : nothing}
          <select
            .value=${currentIndex >= 0 ? String(currentIndex) : ""}
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const idx = (e.target as HTMLSelectElement).value;
              onPatch(path, idx === "" ? undefined : literals[Number(idx)]);
            }}
          >
            <option value="">—</option>
            ${literals.map(
              (opt, i) => html`<option value=${String(i)}>${String(opt)}</option>`,
            )}
          </select>
        </label>
      `;
    }

    const primitiveTypes = ["string", "number", "integer", "boolean"];
    const allPrimitive = nonNull.every((v) => v.type && primitiveTypes.includes(String(v.type)));
    if (allPrimitive) {
      const typeHint = nonNull.map((v) => v.type).join(" | ");
      const hasBoolean = nonNull.some((v) => v.type === "boolean");
      const hasNumber = nonNull.some((v) => v.type === "number" || v.type === "integer");
      const isInteger = nonNull.every((v) => v.type !== "number");
      return html`
        <label class="field">
          ${showLabel ? html`<span>${label}</span>` : nothing}
          ${help ? html`<div class="muted">${help}</div>` : nothing}
          <input
            type="text"
            placeholder=${typeHint}
            .value=${value == null ? "" : String(value)}
            ?disabled=${disabled}
            @input=${(e: Event) => {
              const raw = (e.target as HTMLInputElement).value;
              if (raw === "") {
                onPatch(path, undefined);
                return;
              }
              if (hasBoolean && (raw === "true" || raw === "false")) {
                onPatch(path, raw === "true");
                return;
              }
              if (hasNumber && /^-?\d+(\.\d+)?$/.test(raw)) {
                const num = Number(raw);
                if (Number.isFinite(num) && (!isInteger || Number.isInteger(num))) {
                  onPatch(path, num);
                  return;
                }
              }
              onPatch(path, raw);
            }}
          />
        </label>
      `;
    }

    return html`<div class="callout danger">
      ${label}: unsupported schema node. Use Raw.
    </div>`;
  }

  if (schema.allOf) {
    return html`<div class="callout danger">
      ${label}: unsupported schema node. Use Raw.
    </div>`;
  }

  if (type === "object") {
    const props = schema.properties ?? {};
    const entries = Object.entries(props);
    const hasMap =
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object";
    if (entries.length === 0 && !hasMap) return nothing;
    const reservedKeys = new Set(entries.map(([key]) => key));
    return html`
      <fieldset class="field-group">
        <legend>${label}</legend>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        ${entries.map(([key, node]) =>
          renderNode({
            schema: node,
            value: value && typeof value === "object" ? (value as any)[key] : undefined,
            path: [...path, key],
            hints,
            unsupported,
            onPatch,
            disabled,
          }),
        )}
        ${hasMap
          ? renderMapField({
              schema: schema.additionalProperties as JsonSchema,
              value: value && typeof value === "object" ? (value as any) : {},
              path,
              hints,
              unsupported,
              disabled,
              reservedKeys,
              onPatch,
            })
          : nothing}
      </fieldset>
    `;
  }

  if (type === "array") {
    const itemSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;
    const arr = Array.isArray(value) ? value : [];
    return html`
      <div class="field">
        <div class="row" style="justify-content: space-between;">
          ${showLabel ? html`<span>${label}</span>` : nothing}
        <button
          class="btn"
          ?disabled=${disabled}
          @click=${() => {
            const next = [...arr, defaultValue(itemSchema)];
            onPatch(path, next);
          }}
        >
            Add
          </button>
        </div>
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        ${arr.map((entry, index) =>
          html`<div class="array-item">
            ${itemSchema
              ? renderNode({
                  schema: itemSchema,
                  value: entry,
                  path: [...path, index],
                  hints,
                  unsupported,
                  disabled,
                  onPatch,
                })
              : nothing}
            <button
              class="btn danger"
              ?disabled=${disabled}
              @click=${() => {
                const next = arr.slice();
                next.splice(index, 1);
                onPatch(path, next);
              }}
            >
              Remove
            </button>
          </div>`,
        )}
      </div>
    `;
  }

  if (schema.enum) {
    const enumValues = schema.enum;
    const currentIndex = enumValues.findIndex(
      (v) => v === value || String(v) === String(value),
    );
    const unsetValue = "__unset__";
    return html`
      <label class="field">
        ${showLabel ? html`<span>${label}</span>` : nothing}
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <select
          .value=${currentIndex >= 0 ? String(currentIndex) : unsetValue}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const idx = (e.target as HTMLSelectElement).value;
            onPatch(path, idx === unsetValue ? undefined : enumValues[Number(idx)]);
          }}
        >
          <option value=${unsetValue}>—</option>
          ${enumValues.map(
            (opt, i) => html`<option value=${String(i)}>${String(opt)}</option>`,
          )}
        </select>
      </label>
    `;
  }

  if (type === "boolean") {
    return html`
      <label class="field">
        ${showLabel ? html`<span>${label}</span>` : nothing}
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <input
          type="checkbox"
          .checked=${Boolean(value)}
          ?disabled=${disabled}
          @change=${(e: Event) =>
            onPatch(path, (e.target as HTMLInputElement).checked)}
        />
      </label>
    `;
  }

  if (type === "number" || type === "integer") {
    return html`
      <label class="field">
        ${showLabel ? html`<span>${label}</span>` : nothing}
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <input
          type="number"
          .value=${value == null ? "" : String(value)}
          ?disabled=${disabled}
          @input=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            const parsed = raw === "" ? undefined : Number(raw);
            onPatch(path, parsed);
          }}
        />
      </label>
    `;
  }

  if (type === "string") {
    const isSensitive = hint?.sensitive ?? isSensitivePath(path);
    const placeholder = hint?.placeholder ?? (isSensitive ? "••••" : "");
    return html`
      <label class="field">
        ${showLabel ? html`<span>${label}</span>` : nothing}
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <input
          type=${isSensitive ? "password" : "text"}
          placeholder=${placeholder}
          .value=${value == null ? "" : String(value)}
          ?disabled=${disabled}
          @input=${(e: Event) =>
            onPatch(path, (e.target as HTMLInputElement).value)}
        />
      </label>
    `;
  }

  return html`<div class="field">
    ${showLabel ? html`<span>${label}</span>` : nothing}
    <div class="muted">Unsupported type. Use Raw.</div>
  </div>`;
}

function schemaType(schema: JsonSchema): string | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.type)) {
    const filtered = schema.type.filter((t) => t !== "null");
    return filtered[0] ?? schema.type[0];
  }
  return schema.type;
}

function defaultValue(schema?: JsonSchema): unknown {
  if (!schema) return "";
  if (schema.default !== undefined) return schema.default;
  const type = schemaType(schema);
  switch (type) {
    case "object":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "string":
      return "";
    default:
      return "";
  }
}

function hintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  const key = pathKey(path);
  return hints[key];
}

function pathKey(path: Array<string | number>): string {
  return path.filter((segment) => typeof segment === "string").join(".");
}

function humanize(raw: string) {
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (m) => m.toUpperCase());
}

function isSensitivePath(path: Array<string | number>): boolean {
  const key = pathKey(path).toLowerCase();
  return (
    key.includes("token") ||
    key.includes("password") ||
    key.includes("secret") ||
    key.includes("apikey") ||
    key.endsWith("key")
  );
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
  const {
    schema,
    value,
    path,
    hints,
    unsupported,
    disabled,
    reservedKeys,
    onPatch,
  } = params;
  const entries = Object.entries(value ?? {}).filter(
    ([key]) => !reservedKeys.has(key),
  );
  return html`
    <div class="field" style="margin-top: 12px;">
      <div class="row" style="justify-content: space-between;">
        <span class="muted">Extra entries</span>
        <button
          class="btn"
          ?disabled=${disabled}
          @click=${() => {
            const next = { ...(value ?? {}) };
            let index = 1;
            let key = `new-${index}`;
            while (key in next) {
              index += 1;
              key = `new-${index}`;
            }
            next[key] = defaultValue(schema);
            onPatch(path, next);
          }}
        >
          Add
        </button>
      </div>
      ${entries.length === 0
        ? html`<div class="muted">No entries yet.</div>`
        : entries.map(([key, entryValue]) => {
            const valuePath = [...path, key];
            return html`<div class="array-item" style="gap: 8px;">
              <input
                class="mono"
                style="min-width: 140px;"
                ?disabled=${disabled}
                .value=${key}
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
              <div style="flex: 1;">
                ${renderNode({
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
                class="btn danger"
                ?disabled=${disabled}
                @click=${() => {
                  const next = { ...(value ?? {}) };
                  delete next[key];
                  onPatch(path, next);
                }}
              >
                Remove
              </button>
            </div>`;
          })}
    </div>
  `;
}

export type ConfigSchemaAnalysis = {
  schema: JsonSchema | null;
  unsupportedPaths: string[];
};

export function analyzeConfigSchema(raw: unknown): ConfigSchemaAnalysis {
  if (!raw || typeof raw !== "object") {
    return { schema: null, unsupportedPaths: ["<root>"] };
  }
  const result = normalizeSchemaNode(raw as JsonSchema, []);
  return result;
}

function normalizeSchemaNode(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis {
  const unsupportedPaths: string[] = [];
  const normalized = { ...schema };
  const pathLabel = pathKey(path) || "<root>";

  if (schema.anyOf || schema.oneOf || schema.allOf) {
    const union = normalizeUnion(schema, path);
    if (union) return union;
    unsupportedPaths.push(pathLabel);
    return { schema, unsupportedPaths };
  }

  const nullable =
    Array.isArray(schema.type) && schema.type.includes("null");
  const type =
    schemaType(schema) ??
    (schema.properties || schema.additionalProperties ? "object" : undefined);
  normalized.type = type ?? schema.type;
  normalized.nullable = nullable || schema.nullable;

  if (normalized.enum) {
    const { enumValues, nullable: enumNullable } = normalizeEnumValues(
      normalized.enum,
    );
    normalized.enum = enumValues;
    if (enumNullable) normalized.nullable = true;
    if (enumValues.length === 0) {
      unsupportedPaths.push(pathLabel);
    }
  }

  if (type === "object") {
    const props = schema.properties ?? {};
    const normalizedProps: Record<string, JsonSchema> = {};
    for (const [key, child] of Object.entries(props)) {
      const result = normalizeSchemaNode(child, [...path, key]);
      if (result.schema) normalizedProps[key] = result.schema;
      unsupportedPaths.push(...result.unsupportedPaths);
    }
    normalized.properties = normalizedProps;

    if (schema.additionalProperties === true) {
      unsupportedPaths.push(pathLabel);
    } else if (schema.additionalProperties === false) {
      normalized.additionalProperties = false;
    } else if (schema.additionalProperties) {
      const result = normalizeSchemaNode(
        schema.additionalProperties,
        [...path, "*"],
      );
      normalized.additionalProperties = result.schema ?? schema.additionalProperties;
      if (result.unsupportedPaths.length > 0) {
        unsupportedPaths.push(pathLabel);
      }
    }
  } else if (type === "array") {
    const itemSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;
    if (!itemSchema) {
      unsupportedPaths.push(pathLabel);
    } else {
      const result = normalizeSchemaNode(itemSchema, [...path, "*"]);
      normalized.items = result.schema ?? itemSchema;
      if (result.unsupportedPaths.length > 0) {
        unsupportedPaths.push(pathLabel);
      }
    }
  } else if (
    type === "string" ||
    type === "number" ||
    type === "integer" ||
    type === "boolean"
  ) {
    // ok
  } else if (!normalized.enum) {
    unsupportedPaths.push(pathLabel);
  }

  return {
    schema: normalized,
    unsupportedPaths: Array.from(new Set(unsupportedPaths)),
  };
}

function normalizeUnion(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
  if (schema.allOf) return null;
  const variants = schema.anyOf ?? schema.oneOf;
  if (!variants) return null;
  const values: unknown[] = [];
  const nonLiteral: JsonSchema[] = [];
  let nullable = false;
  for (const variant of variants) {
    if (!variant || typeof variant !== "object") return null;
    if (Array.isArray(variant.enum)) {
      const { enumValues, nullable: enumNullable } = normalizeEnumValues(
        variant.enum,
      );
      values.push(...enumValues);
      if (enumNullable) nullable = true;
      continue;
    }
    if ("const" in variant) {
      if (variant.const === null || variant.const === undefined) {
        nullable = true;
        continue;
      }
      values.push(variant.const);
      continue;
    }
    if (schemaType(variant) === "null") {
      nullable = true;
      continue;
    }
    nonLiteral.push(variant);
  }

  if (values.length > 0 && nonLiteral.length === 0) {
    const unique: unknown[] = [];
    for (const value of values) {
      if (!unique.some((entry) => Object.is(entry, value))) unique.push(value);
    }
    return {
      schema: {
        ...schema,
        enum: unique,
        nullable,
        anyOf: undefined,
        oneOf: undefined,
        allOf: undefined,
      },
      unsupportedPaths: [],
    };
  }

  if (nonLiteral.length === 1) {
    const result = normalizeSchemaNode(nonLiteral[0], path);
    if (result.schema) {
      result.schema.nullable = nullable || result.schema.nullable;
    }
    return result;
  }

  const primitiveTypes = ["string", "number", "integer", "boolean"];
  const allPrimitive = nonLiteral.every(
    (v) => v.type && primitiveTypes.includes(String(v.type)),
  );
  if (allPrimitive && nonLiteral.length > 0 && values.length === 0) {
    return {
      schema: { ...schema, nullable },
      unsupportedPaths: [],
    };
  }

  return null;
}

function normalizeEnumValues(values: unknown[]) {
  const filtered = values.filter((value) => value !== null && value !== undefined);
  const nullable = filtered.length !== values.length;
  const unique: unknown[] = [];
  for (const value of filtered) {
    if (!unique.some((entry) => Object.is(entry, value))) unique.push(value);
  }
  return { enumValues: unique, nullable };
}
