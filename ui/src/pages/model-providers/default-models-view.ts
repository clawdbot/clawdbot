import { html, nothing } from "lit";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { modelCatalogRef, type DefaultModelSelection, type ModelPickerEntry } from "./data.ts";

type DefaultModelsViewProps = {
  models: ModelPickerEntry[];
  selection: DefaultModelSelection;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  dirty: boolean;
  busy: Record<string, boolean>;
  message?: { kind: "success" | "error"; text: string };
  onPrimaryChange: (model: string) => void;
  onFallbackAdd: (model: string) => void;
  onFallbackRemove: (index: number) => void;
  onUtilityChange: (model: string | null) => void;
  onSave: () => void;
  onReset: () => void;
};

type ModelOptionGroup = {
  provider: string;
  label: string;
  models: Array<{ ref: string; label: string }>;
};

const AUTOMATIC_UTILITY_VALUE = "__openclaw_automatic_utility__";

function modelGroups(models: ModelPickerEntry[]): ModelOptionGroup[] {
  const groups = new Map<string, ModelOptionGroup>();
  const seen = new Set<string>();
  for (const model of models) {
    const ref = modelCatalogRef(model);
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    const groupKey = model.provider || "saved-selection";
    const group = groups.get(groupKey) ?? {
      provider: groupKey,
      label: model.provider
        ? providerDisplayLabel(model.provider)
        : t("modelProviders.defaults.savedSelection"),
      models: [],
    };
    group.models.push({ ref, label: model.name || ref });
    groups.set(groupKey, group);
  }
  const sortedGroups = [...groups.values()];
  for (const group of sortedGroups) {
    group.models = group.models.toSorted((a, b) => a.label.localeCompare(b.label));
  }
  return sortedGroups.toSorted((a, b) => a.label.localeCompare(b.label));
}

function renderModelOptions(models: ModelPickerEntry[], selected = "") {
  return modelGroups(models).map(
    (group) => html`
      <optgroup label=${group.label}>
        ${group.models.map(
          (model) =>
            html`<option value=${model.ref} ?selected=${model.ref === selected}>
              ${model.label}
            </option>`,
        )}
      </optgroup>
    `,
  );
}

export function renderDefaultModels(props: DefaultModelsViewProps) {
  const disabled = !props.canMutate || props.models.length === 0;
  const saving = Boolean(props.busy.defaults);
  const title = props.mutationBlockedReason ?? "";
  const body = html`
    <div class="settings-row settings-row--stacked model-providers__defaults">
      ${props.models.length === 0
        ? html`<div class="callout warning">${t("modelProviders.defaults.noModels")}</div>`
        : nothing}
      <div class="model-providers__default-grid">
        <label class="field">
          <span>${t("modelProviders.defaults.primary")}</span>
          <select
            class="settings-select"
            .value=${props.selection.primary}
            ?disabled=${disabled || saving}
            title=${title}
            @change=${(event: Event) =>
              props.onPrimaryChange((event.target as HTMLSelectElement).value)}
          >
            <option value="" ?disabled=${Boolean(props.selection.primary)}>
              ${t("modelProviders.defaults.selectModel")}
            </option>
            ${renderModelOptions(props.models, props.selection.primary)}
          </select>
        </label>
        <label class="field">
          <span>${t("modelProviders.defaults.utility")}</span>
          <select
            class="settings-select"
            .value=${props.selection.utilityModel ?? AUTOMATIC_UTILITY_VALUE}
            ?disabled=${disabled || saving}
            title=${title}
            @change=${(event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              props.onUtilityChange(value === AUTOMATIC_UTILITY_VALUE ? null : value);
            }}
          >
            <option value=${AUTOMATIC_UTILITY_VALUE}>
              ${t("modelProviders.defaults.automatic")}
            </option>
            <option value="">${t("modelProviders.defaults.disabled")}</option>
            ${renderModelOptions(props.models, props.selection.utilityModel ?? "")}
          </select>
        </label>
      </div>
      <div class="model-providers__fallbacks">
        <div class="model-providers__fallback-heading">
          <span>${t("modelProviders.defaults.fallbacks")}</span>
          ${saving ? html`<span class="muted">${t("modelProviders.saving")}</span>` : nothing}
        </div>
        ${props.selection.fallbacks.length === 0
          ? html`<div class="card-sub">${t("modelProviders.defaults.noFallbacks")}</div>`
          : props.selection.fallbacks.map(
              (fallback, index) => html`
                <div class="model-providers__fallback-row">
                  <code>${fallback}</code>
                  <button
                    class="btn btn--sm"
                    ?disabled=${disabled || saving}
                    title=${title}
                    @click=${() => props.onFallbackRemove(index)}
                  >
                    ${t("common.remove")}
                  </button>
                </div>
              `,
            )}
        <label class="field model-providers__fallback-add">
          <span>${t("modelProviders.defaults.addFallback")}</span>
          <select
            class="settings-select"
            .value=${""}
            ?disabled=${disabled || saving || !props.selection.primary}
            title=${title}
            @change=${(event: Event) => {
              const select = event.target as HTMLSelectElement;
              if (select.value) {
                props.onFallbackAdd(select.value);
                select.value = "";
              }
            }}
          >
            <option value="">${t("modelProviders.defaults.selectFallback")}</option>
            ${renderModelOptions(
              props.models.filter((model) => {
                const ref = modelCatalogRef(model);
                return ref !== props.selection.primary && !props.selection.fallbacks.includes(ref);
              }),
            )}
          </select>
        </label>
      </div>
      ${props.message
        ? html`<div class="callout ${props.message.kind}" role="status">${props.message.text}</div>`
        : nothing}
    </div>
  `;
  return renderSettingsSection(
    {
      title: t("modelProviders.defaults.title"),
      description: t("modelProviders.defaults.subtitle"),
      actions: html`
        <div class="model-providers__form-actions">
          ${props.dirty
            ? html`<span class="muted">${t("modelProviders.defaults.unsaved")}</span>`
            : nothing}
          <button class="btn btn--sm" ?disabled=${saving || !props.dirty} @click=${props.onReset}>
            ${t("common.cancel")}
          </button>
          <button
            class="btn primary btn--sm"
            ?disabled=${disabled || saving || !props.dirty || !props.selection.primary}
            title=${title}
            @click=${props.onSave}
          >
            ${saving ? t("modelProviders.saving") : t("common.save")}
          </button>
        </div>
      `,
    },
    body,
  );
}
