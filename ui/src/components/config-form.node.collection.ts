// Control UI renderers for structured config form nodes.
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import {
  getSensitiveRenderState,
  isAnySchema,
  jsonValue,
  renderFieldRow,
  renderJsonTextareaControl,
  renderTags,
  type ConfigNodeRenderer,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSearch,
  matchesNodeSelf,
  resolveConfigFieldMeta as resolveFieldMeta,
} from "./config-form.search.ts";
import { defaultValue, hintForPath } from "./config-form.shared.ts";
import { renderSettingsEmpty } from "./settings-ui.ts";

export function renderJsonTextarea(params: ConfigNodeRenderParams): TemplateResult {
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

export function renderObject(
  params: ConfigNodeRenderParams,
  renderNode: ConfigNodeRenderer,
): TemplateResult {
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
  const objectValue =
    fallback && typeof fallback === "object" && !Array.isArray(fallback)
      ? (fallback as Record<string, unknown>)
      : {};
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);

  // Sort by hint order
  const sorted = entries.toSorted((left, right) => {
    const leftOrder = hintForPath([...path, left[0]], hints)?.order ?? 0;
    const rightOrder = hintForPath([...path, right[0]], hints)?.order ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left[0].localeCompare(right[0]);
  });

  const reservedKeys = new Set(Object.keys(properties));
  const additionalProperties = schema.additionalProperties;
  const allowExtra = Boolean(additionalProperties) && typeof additionalProperties === "object";

  const fields = html`
    ${sorted.map(([propertyKey, node]) =>
      renderNode({
        schema: node,
        value: objectValue[propertyKey],
        path: [...path, propertyKey],
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
      ? renderMapField(
          {
            ...params,
            schema: additionalProperties,
            value: objectValue,
            reservedKeys,
            searchCriteria: childSearchCriteria,
          },
          renderNode,
        )
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

export function renderArray(
  params: ConfigNodeRenderParams,
  renderNode: ConfigNodeRenderer,
): TemplateResult {
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

  const arrayValue = Array.isArray(value)
    ? value
    : Array.isArray(schema.default)
      ? schema.default
      : [];

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
            >${t(arrayValue.length === 1 ? "configForm.itemCountOne" : "configForm.itemCount", {
              count: String(arrayValue.length),
            })}</span
          >
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${disabled}
            @click=${() => onPatch(path, [...arrayValue, defaultValue(itemsSchema)])}
          >
            ${t("configForm.add")}
          </button>
        </div>
      </div>
      ${arrayValue.length === 0
        ? renderSettingsEmpty(t("configForm.noItems"))
        : html`
            <div class="settings-subrows">
              ${arrayValue.map(
                (item, index) => html`
                  <div class="settings-row">
                    <div class="settings-row__text">
                      <span class="settings-row__title">#${index + 1}</span>
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
                            const nextValue = [...arrayValue];
                            nextValue.splice(index, 1);
                            onPatch(path, nextValue);
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
                    path: [...path, index],
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

function renderMapField(
  params: ConfigNodeRenderParams & {
    value: Record<string, unknown>;
    reservedKeys: Set<string>;
  },
  renderNode: ConfigNodeRenderer,
): TemplateResult {
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
              const nextValue = { ...value };
              let index = 1;
              let key = `custom-${index}`;
              while (key in nextValue) {
                index += 1;
                key = `custom-${index}`;
              }
              nextValue[key] = anySchema ? {} : defaultValue(schema);
              onPatch(path, nextValue);
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
                        @change=${(event: Event) => {
                          const nextKey = (event.target as HTMLInputElement).value.trim();
                          if (!nextKey || nextKey === key) {
                            return;
                          }
                          const nextValue = { ...value };
                          if (nextKey in nextValue) {
                            return;
                          }
                          nextValue[nextKey] = nextValue[key];
                          delete nextValue[key];
                          onPatch(path, nextValue);
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
                            const nextValue = { ...value };
                            delete nextValue[key];
                            onPatch(path, nextValue);
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
