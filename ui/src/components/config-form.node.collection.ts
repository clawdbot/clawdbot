// Control UI renderers for structured config form nodes.
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import {
  containsRedactedSentinel,
  removePathValue,
  setPathValue,
} from "../lib/config-form-utils.ts";
import { arrayAddCandidates } from "./config-form-array-candidates.ts";
import {
  appendArrayRowIdentities,
  discardArrayRowIdentities,
  preserveArrayRowIdentities,
  rowIdentitiesForArray,
} from "./config-form-array-identity.ts";
import {
  ConfigFormCollectionDraft,
  type ConfigFormCollectionDraftCommit,
  type ConfigFormCollectionDraftProps,
} from "./config-form-collection-draft.ts";
import { copyWithPathPatch } from "./config-form-copy-on-write.ts";
import { arrayItemSchema } from "./config-form.array-items.ts";
import {
  arrayInputConstraints,
  canApplyArrayCandidate,
  canApplyObjectCandidate,
  configValuesEqual,
  defaultValue,
  isSupportedConfigValueValid,
  isObjectPropertyNameValid,
  NO_SAFE_DEFAULT,
  objectAdditionalPropertiesSchema,
  objectPropertyKeys,
  objectPropertySchema,
  requiredPropertyKeys,
} from "./config-form.constraints.ts";
import {
  getSensitiveRenderState,
  isAnySchema,
  jsonValue,
  renderCollectionDefaultDescription,
  renderFlatDefaultRow,
  renderFieldRow,
  renderJsonTextareaControl,
  renderTags,
  schemaWithDefault,
  type ConfigNodeRenderer,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSearch,
  matchesNodeSelf,
  resolveConfigFieldMeta as resolveFieldMeta,
} from "./config-form.search.ts";
import { configFieldId, hintForPath, type JsonSchema } from "./config-form.shared.ts";
import { renderSettingsEmpty } from "./settings-ui.ts";

const UNSET_ARRAY_SOURCE_IDENTITY = Symbol("unset-array-source");
const UNSET_MAP_SOURCE_IDENTITY = Symbol("unset-map-source");

function openCollectionDraft(event: Event, draftId: string): void {
  const block = (event.currentTarget as HTMLElement).closest(".cfg-block");
  const draft = Array.from(block?.children ?? []).find((child) => child.id === draftId);
  (draft as Partial<ConfigFormCollectionDraft> | undefined)?.openDraft?.call(draft);
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
    onRemove,
  } = params;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;

  const inherited = value === undefined && schema.default !== undefined;
  const fallback = inherited ? schema.default : value;
  const objectSourceIdentity = fallback === undefined ? UNSET_MAP_SOURCE_IDENTITY : fallback;
  const objectValue =
    fallback && typeof fallback === "object" && !Array.isArray(fallback)
      ? (fallback as Record<string, unknown>)
      : {};
  const defaultDescription = renderCollectionDefaultDescription(params, fallback);
  const entries = objectPropertyKeys(schema)
    .map((key) => [key, objectPropertySchema(schema, key)] as const)
    .filter((entry): entry is readonly [string, ConfigNodeRenderParams["schema"]] =>
      Boolean(entry[1]),
    );
  const requiredKeys = requiredPropertyKeys(schema);

  // Sort by hint order
  const sorted = entries.toSorted((left, right) => {
    const leftOrder = hintForPath([...path, left[0]], hints)?.order ?? 0;
    const rightOrder = hintForPath([...path, right[0]], hints)?.order ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left[0].localeCompare(right[0]);
  });

  const reservedKeys = new Set(entries.map(([key]) => key));
  const additionalProperties = objectAdditionalPropertiesSchema(schema);
  const allowExtra = Boolean(additionalProperties) && typeof additionalProperties === "object";
  const patchObjectChild = (childPath: Array<string | number>, childValue: unknown) => {
    if (
      childPath.length < path.length ||
      !path.every((segment, index) => segment === childPath[index])
    ) {
      return false;
    }
    let candidate: Record<string, unknown>;
    const relativePath = childPath.slice(path.length);
    if (relativePath.length === 0) {
      if (!childValue || typeof childValue !== "object" || Array.isArray(childValue)) {
        return false;
      }
      candidate = childValue as Record<string, unknown>;
    } else {
      try {
        candidate = structuredClone(objectValue);
      } catch {
        return false;
      }
      if (childValue === undefined) {
        removePathValue(candidate, relativePath);
      } else {
        setPathValue(candidate, relativePath, childValue);
      }
    }
    if (!canApplyObjectCandidate(schema, objectValue, candidate)) {
      return false;
    }
    if (inherited) {
      return onPatch(path, candidate) !== false;
    }
    const accepted =
      childValue === undefined && onRemove ? onRemove(childPath) : onPatch(childPath, childValue);
    return accepted !== false;
  };

  const fields = html`
    ${sorted.map(([propertyKey, node]) => {
      const hasInheritedChild = inherited && Object.hasOwn(objectValue, propertyKey);
      return renderNode({
        schema: hasInheritedChild ? schemaWithDefault(node, objectValue[propertyKey]) : node,
        value: inherited ? undefined : objectValue[propertyKey],
        path: [...path, propertyKey],
        hints,
        rawAvailable,
        unsupported,
        disabled,
        isRequired: requiredKeys.has(propertyKey),
        sourceIdentity: inherited ? undefined : objectValue[propertyKey],
        controlIdentity: params.controlIdentity ?? objectValue,
        rowIdentity: params.rowIdentity,
        searchCriteria: childSearchCriteria,
        revealSensitive,
        isSensitivePathRevealed,
        onToggleSensitivePath,
        onPatch: patchObjectChild,
      });
    })}
    ${allowExtra
      ? renderMapField(
          {
            ...params,
            schema: additionalProperties,
            value: objectValue,
            sourceIdentity: objectSourceIdentity,
            reservedKeys,
            validateKey: (key) => isObjectPropertyNameValid(schema, key),
            searchCriteria: childSearchCriteria,
            onPatch: patchObjectChild,
          },
          renderNode,
        )
      : nothing}
  `;

  // Top-level objects and label-less contexts emit rows directly into the
  // surrounding settings-group so row dividers stay sibling-driven.
  if (path.length === 1 || params.showLabel === false) {
    return html`${path.length === 1 ? renderFlatDefaultRow(defaultDescription) : nothing}${fields}`;
  }

  // Nested objects get collapsible treatment as an indented sub-block.
  return html`
    <details class="cfg-object cfg-block" ?open=${path.length <= 2}>
      <summary class="settings-row cfg-object__summary">
        <div class="settings-row__text">
          <span class="settings-row__title">${label}</span>
          ${help ? html`<span class="settings-row__desc">${help}</span>` : nothing}
          ${schema.default !== undefined
            ? html`<span class="settings-row__desc">${defaultDescription}</span>`
            : nothing}
          ${renderTags(tags)}
        </div>
        <div class="settings-row__control">
          <span class="settings-row__chevron cfg-object__chevron">${icons.chevronDown}</span>
        </div>
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
  const showHeaderMeta = params.showHeaderMeta ?? showLabel;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;

  const tupleItems = Array.isArray(schema.items) ? schema.items : undefined;
  const itemsSchema = Array.isArray(schema.items) ? (schema.items[0] ?? {}) : schema.items;
  if (!itemsSchema) {
    return renderFieldRow({
      label,
      tags: [],
      showLabel: true,
      control: nothing,
      error: t("configForm.unsupportedArray"),
    });
  }

  const inherited = value === undefined && Array.isArray(schema.default);
  const arrayValue = Array.isArray(value)
    ? value
    : Array.isArray(schema.default)
      ? schema.default
      : [];
  const arraySourceIdentity = Array.isArray(value)
    ? value
    : Array.isArray(schema.default)
      ? schema.default
      : UNSET_ARRAY_SOURCE_IDENTITY;
  const defaultDescription = renderCollectionDefaultDescription(params, arrayValue);
  const rowIdentities = rowIdentitiesForArray(arrayValue);
  const {
    minItems: minimumItems,
    maxItems: maximumItems,
    uniqueItems,
  } = arrayInputConstraints(schema);
  const itemSchemaAt = (index: number): JsonSchema =>
    arrayItemSchema(schema, index) ?? (tupleItems ? {} : itemsSchema);
  const { atomicCandidate, autoCandidate } = arrayAddCandidates({
    schema,
    value: arrayValue,
    minimumItems,
    maximumItems,
    uniqueItems,
    isUnset: value === undefined,
    isRequired: params.isRequired ?? false,
    itemSchemaAt,
  });
  const canAppend = maximumItems === undefined || arrayValue.length < maximumItems;
  const requiresDraft = atomicCandidate === undefined && autoCandidate === undefined;
  const nextItemSchema = itemSchemaAt(arrayValue.length);
  const draftId = configFieldId(path, "array-draft");
  const draftProps: ConfigFormCollectionDraftProps = {
    schema: nextItemSchema,
    label,
    disabled: disabled || !canAppend,
    identity: draftId,
    sourceIdentity: arraySourceIdentity,
    existingValues: uniqueItems ? arrayValue : undefined,
    validateValue: (candidate) => {
      const nextValue = [...arrayValue, candidate];
      return (
        (maximumItems === undefined || nextValue.length <= maximumItems) &&
        (nextValue.length < minimumItems || isSupportedConfigValueValid(schema, nextValue))
      );
    },
  };
  const patchArrayItem = (childPath: Array<string | number>, childValue: unknown) => {
    if (
      childPath.length <= path.length ||
      !path.every((segment, index) => segment === childPath[index])
    ) {
      return false;
    }
    const relativePath = childPath.slice(path.length);
    const itemIndex = relativePath[0];
    if (typeof itemIndex !== "number" || itemIndex < 0 || itemIndex >= arrayValue.length) {
      return false;
    }
    const nextValue = [...arrayValue];
    const itemPath = relativePath.slice(1);
    if (itemPath.length === 0) {
      if (childValue === undefined) {
        return false;
      }
      nextValue[itemIndex] = childValue;
    } else {
      const nextItem = copyWithPathPatch(arrayValue[itemIndex], itemPath, childValue);
      if (!nextItem.ok) {
        return false;
      }
      nextValue[itemIndex] = nextItem.value;
    }
    if (canApplyArrayCandidate(schema, arrayValue, nextValue, uniqueItems, true)) {
      preserveArrayRowIdentities(nextValue, rowIdentities);
      const accepted = onPatch(path, nextValue) !== false;
      if (!accepted) {
        discardArrayRowIdentities(nextValue);
      }
      return accepted;
    }
    return false;
  };

  return html`
    <div class="cfg-block cfg-array">
      <div class="settings-row">
        <div class="settings-row__text">
          ${showLabel ? html`<span class="settings-row__title">${label}</span>` : nothing}
          ${showHeaderMeta && help
            ? html`<span class="settings-row__desc">${help}</span>`
            : nothing}
          ${showHeaderMeta && schema.default !== undefined
            ? html`<span class="settings-row__desc">${defaultDescription}</span>`
            : nothing}
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
            aria-controls=${draftId}
            ?disabled=${disabled || (!canAppend && atomicCandidate === undefined)}
            @click=${(event: Event) => {
              if (atomicCandidate) {
                if (onPatch(path, atomicCandidate) === false) {
                  openCollectionDraft(event, draftId);
                }
              } else if (requiresDraft) {
                openCollectionDraft(event, draftId);
              } else if (autoCandidate) {
                appendArrayRowIdentities(
                  autoCandidate,
                  rowIdentities,
                  autoCandidate.length - arrayValue.length,
                );
                if (onPatch(path, autoCandidate) === false) {
                  discardArrayRowIdentities(autoCandidate);
                  openCollectionDraft(event, draftId);
                }
              }
            }}
          >
            ${t("configForm.add")}
          </button>
        </div>
      </div>
      <openclaw-config-form-collection-draft
        id=${draftId}
        .props=${draftProps}
        @config-collection-draft-commit=${(event: CustomEvent<ConfigFormCollectionDraftCommit>) => {
          const nextValue = [...arrayValue, event.detail.value];
          const canApply =
            !(
              uniqueItems && arrayValue.some((item) => configValuesEqual(item, event.detail.value))
            ) &&
            (maximumItems === undefined || arrayValue.length < maximumItems) &&
            isSupportedConfigValueValid(nextItemSchema, event.detail.value) &&
            (nextValue.length < minimumItems || isSupportedConfigValueValid(schema, nextValue));
          let accepted = false;
          if (canApply) {
            appendArrayRowIdentities(nextValue, rowIdentities, 1);
            accepted = onPatch(path, nextValue) !== false;
            if (!accepted) {
              discardArrayRowIdentities(nextValue);
            }
          }
          if (!accepted) {
            event.preventDefault();
          }
        }}
      ></openclaw-config-form-collection-draft>
      ${arrayValue.length === 0
        ? renderSettingsEmpty(t("configForm.noItems"))
        : html`
            <div class="settings-subrows">
              ${arrayValue.map((item, index) => {
                const itemSchema = itemSchemaAt(index);
                return html`
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
                          ?disabled=${disabled ||
                          arrayValue.length <= minimumItems ||
                          !canApplyArrayCandidate(
                            schema,
                            arrayValue,
                            arrayValue.toSpliced(index, 1),
                            uniqueItems,
                            false,
                          )}
                          @click=${() => {
                            const nextValue = arrayValue.toSpliced(index, 1);
                            if (
                              canApplyArrayCandidate(
                                schema,
                                arrayValue,
                                nextValue,
                                uniqueItems,
                                false,
                              )
                            ) {
                              preserveArrayRowIdentities(
                                nextValue,
                                rowIdentities.toSpliced(index, 1),
                              );
                              if (onPatch(path, nextValue) === false) {
                                discardArrayRowIdentities(nextValue);
                              }
                            }
                          }}
                        >
                          ${icons.trash}
                        </button>
                      </openclaw-tooltip>
                    </div>
                  </div>
                  ${renderNode({
                    schema: inherited ? schemaWithDefault(itemSchema, item) : itemSchema,
                    value: inherited ? undefined : item,
                    path: [...path, index],
                    hints,
                    rawAvailable,
                    unsupported,
                    disabled,
                    isRequired: true,
                    sourceIdentity: inherited ? undefined : item,
                    controlIdentity: arrayValue,
                    rowIdentity: rowIdentities[index],
                    searchCriteria: childSearchCriteria,
                    showLabel: false,
                    revealSensitive,
                    isSensitivePathRevealed,
                    onToggleSensitivePath,
                    // Inherited rows stay visually unset, but edits materialize the
                    // complete effective array through patchArrayItem at the parent path.
                    onPatch: patchArrayItem,
                  })}
                `;
              })}
            </div>
          `}
    </div>
  `;
}

function renderMapField(
  params: ConfigNodeRenderParams & {
    value: Record<string, unknown>;
    reservedKeys: Set<string>;
    validateKey: (key: string) => boolean;
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
    validateKey,
    onPatch,
    searchCriteria,
    revealSensitive,
    isSensitivePathRevealed,
    onToggleSensitivePath,
  } = params;
  const anySchema = isAnySchema(schema);
  const entryDefault = anySchema ? {} : defaultValue(schema);
  const draftId = configFieldId(path, "map-draft");
  const draftProps: ConfigFormCollectionDraftProps = {
    schema,
    label: t("configForm.customEntries"),
    disabled,
    identity: draftId,
    sourceIdentity: params.sourceIdentity ?? value,
    existingKeys: [...new Set([...Object.keys(value), ...reservedKeys])],
    validateKey,
  };
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
            aria-controls=${draftId}
            ?disabled=${disabled}
            @click=${(event: Event) => {
              if (entryDefault === NO_SAFE_DEFAULT) {
                openCollectionDraft(event, draftId);
                return;
              }
              const nextValue = { ...value };
              let index = 1;
              let key = `custom-${index}`;
              while (key in nextValue) {
                index += 1;
                key = `custom-${index}`;
              }
              nextValue[key] = entryDefault;
              if (onPatch(path, nextValue) === false) {
                openCollectionDraft(event, draftId);
              }
            }}
          >
            ${t("configForm.addEntry")}
          </button>
        </div>
      </div>

      <openclaw-config-form-collection-draft
        id=${draftId}
        .props=${draftProps}
        @config-collection-draft-commit=${(event: CustomEvent<ConfigFormCollectionDraftCommit>) => {
          const key = event.detail.key;
          if (
            !key ||
            Object.hasOwn(value, key) ||
            reservedKeys.has(key) ||
            onPatch(path, { ...value, [key]: event.detail.value }) === false
          ) {
            event.preventDefault();
          }
        }}
      ></openclaw-config-form-collection-draft>
      ${visibleEntries.length === 0
        ? renderSettingsEmpty(t("configForm.noCustomEntries"))
        : html`
            <div class="settings-subrows">
              ${visibleEntries.map(([key, entryValue]) => {
                const valuePath = [...path, key];
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
                        aria-label=${`${t("configForm.key")}: ${key}`}
                        .value=${key}
                        ?disabled=${disabled}
                        @change=${(event: Event) => {
                          const target = event.target as HTMLInputElement;
                          const nextKey = target.value.trim();
                          if (!nextKey || nextKey === key) {
                            target.value = key;
                            return;
                          }
                          // Renaming a key that still holds server-redacted secrets would
                          // submit the sentinel under a new key: the gateway fails closed
                          // (dead-end draft), and a delete+rename fold in one autosave
                          // window silently binds the deleted entry's old credential.
                          const error = !validateKey(nextKey)
                            ? t("configForm.invalidString")
                            : containsRedactedSentinel(value[key])
                              ? t("configForm.renameRedactedBlocked")
                              : "";
                          if (nextKey in value || error) {
                            target.value = key;
                            if (error) {
                              target.setCustomValidity(error);
                              target.reportValidity();
                              target.setCustomValidity("");
                            }
                            return;
                          }
                          const nextValue = { ...value, [nextKey]: value[key] };
                          delete nextValue[key];
                          if (onPatch(path, nextValue) === false) {
                            target.value = key;
                          }
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
                          schema,
                          path: valuePath,
                          ariaLabel: `${key}: ${t("configForm.jsonValue")}`,
                          sourceValue: entryValue,
                          rowIdentity: params.rowIdentity,
                          fallback: jsonValue(entryValue),
                          rows: 2,
                          sensitiveState,
                          disabled,
                          isRequired: true,
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
                        isRequired: true,
                        sourceIdentity: entryValue,
                        controlIdentity: value,
                        rowIdentity: params.rowIdentity,
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
