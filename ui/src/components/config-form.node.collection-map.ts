import { html, type TemplateResult } from "lit";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { containsRedactedSentinel } from "../lib/config-form-utils.ts";
import {
  openCollectionDraft,
  type ConfigFormCollectionDraftCommit,
  type ConfigFormCollectionDraftProps,
} from "./config-form-collection-draft.ts";
import { defaultValue, NO_SAFE_DEFAULT } from "./config-form.constraints.ts";
import {
  getSensitiveRenderState,
  isAnySchema,
  jsonValue,
  renderFieldRow,
  renderJsonTextareaControl,
  type ConfigNodeRenderer,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSearch,
} from "./config-form.search.ts";
import { configFieldId } from "./config-form.shared.ts";
import { renderSettingsEmpty } from "./settings-ui.ts";

export function renderMapField(
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
      ${
        visibleEntries.length === 0
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
                            const target = event.currentTarget;
                            if (!(target instanceof HTMLInputElement)) {
                              return;
                            }
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
                    ${
                      anySchema
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
                          })
                    }
                  `;
                })}
              </div>
            `
      }
    </div>
  `;
}
