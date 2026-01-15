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
    return html`<div class="callout danger">
      ${label}: unsupported schema node. Use Raw.
    </div>`;
  }

  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const nonNull = variants.filter(
      (v) =>
        !(
          v.type === "null" ||
          (Array.isArray(v.type) && v.type.includes("null"))
        ),
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
            <option value="">Select…</option>
            ${literals.map(
              (lit, idx) =>
                html`<option value=${String(idx)}>${String(lit)}</option>`,
            )}
          </select>
        </label>
      `;
    }
  }

  if (schema.enum) {
    const options = schema.enum;
    const currentIndex = options.findIndex(
      (opt) => opt === value || String(opt) === String(value),
    );
    const unset = "__unset__";
    return html`
      <label class="field">
        ${showLabel ? html`<span>${label}</span>` : nothing}
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <select
          .value=${currentIndex >= 0 ? String(currentIndex) : unset}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const idx = (e.target as HTMLSelectElement).value;
            onPatch(path, idx === unset ? undefined : options[Number(idx)]);
          }}
        >
          <option value=${unset}>Select…</option>
          ${options.map(
            (opt, idx) =>
              html`<option value=${String(idx)}>${String(opt)}</option>`,
          )}
        </select>
      </label>
    `;
  }

  if (type === "object") {
    const obj = (value ?? {}) as Record<string, unknown>;
    const props = schema.properties ?? {};
    const entries = Object.entries(props);
    const sorted = entries.sort((a, b) => {
      const orderA = hintForPath([...path, a[0]], hints)?.order ?? 0;
      const orderB = hintForPath([...path, b[0]], hints)?.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a[0].localeCompare(b[0]);
    });
    const reserved = new Set(Object.keys(props));
    const additional = schema.additionalProperties;
    const allowExtra = Boolean(additional) && typeof additional === "object";

    return html`
      <div class="fieldset">
        ${showLabel ? html`<div class="legend">${label}</div>` : nothing}
        ${help ? html`<div class="muted">${help}</div>` : nothing}

        ${sorted.map(([propKey, node]) =>
          renderNode({
            schema: node,
            value: obj[propKey],
            path: [...path, propKey],
            hints,
            unsupported,
            disabled,
            onPatch,
          }),
        )}

        ${allowExtra
          ? renderMapField({
              schema: additional as JsonSchema,
              value: obj,
              path,
              hints,
              unsupported,
              disabled,
              reservedKeys: reserved,
              onPatch,
            })
          : nothing}
      </div>
    `;
  }

  if (type === "array") {
    const itemsSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;
    if (!itemsSchema) {
      return html`<div class="field">
        ${showLabel ? html`<span>${label}</span>` : nothing}
        <div class="muted">Unsupported array schema. Use Raw.</div>
      </div>`;
    }
    const arr = Array.isArray(value) ? value : [];
    return html`
      <div class="field" style="margin-top: 12px;">
        ${showLabel ? html`<span>${label}</span>` : nothing}
        ${help ? html`<div class="muted">${help}</div>` : nothing}
        <div class="array">
          ${arr.map((item, idx) => {
            const itemPath = [...path, idx];
            return html`<div class="array-item">
              <div style="flex: 1;">
                ${renderNode({
                  schema: itemsSchema,
                  value: item,
                  path: itemPath,
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
                  const next = [...arr];
                  next.splice(idx, 1);
                  onPatch(path, next);
                }}
              >
                Remove
              </button>
            </div>`;
          })}
          <button
            class="btn"
            ?disabled=${disabled}
            @click=${() => {
              const next = [...arr];
              next.push(defaultValue(itemsSchema));
              onPatch(path, next);
            }}
          >
            Add
          </button>
        </div>
      </div>
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
  const { schema, value, path, hints, unsupported, disabled, reservedKeys, onPatch } =
    params;
  const anySchema = isAnySchema(schema);
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
            next[key] = anySchema ? {} : defaultValue(schema);
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
            const fallback = jsonValue(entryValue);
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
                ${anySchema
                  ? html`<label class="field" style="margin: 0;">
                      <div class="muted">JSON value</div>
                      <textarea
                        class="mono"
                        rows="5"
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
                    </label>`
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
