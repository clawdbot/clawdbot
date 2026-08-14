import { html, nothing } from "lit";
import { renderModelPicker, type ModelPickerOption } from "../../components/model-picker.ts";
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
  message?: { kind: "success" | "error"; text: string; warning?: string };
  onPrimaryChange: (model: string) => void;
  onFallbackAdd: (model: string) => void;
  onFallbackRemove: (index: number) => void;
  onUtilityChange: (model: string | null) => void;
  onSave: () => void;
  onReset: () => void;
};

const AUTOMATIC_UTILITY_VALUE = "__openclaw_automatic_utility__";

function modelOptions(models: ModelPickerEntry[]): ModelPickerOption[] {
  const seen = new Set<string>();
  const options: ModelPickerOption[] = [];
  for (const model of models) {
    const ref = modelCatalogRef(model);
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    options.push({
      value: ref,
      label: model.name || ref,
      ...(model.provider ? { provider: model.provider } : {}),
    });
  }
  return options.toSorted((a, b) => a.label.localeCompare(b.label));
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
          ${renderModelPicker({
            label: t("modelProviders.defaults.primary"),
            value: props.selection.primary,
            options: [
              {
                value: "",
                label: t("modelProviders.defaults.selectModel"),
                disabled: Boolean(props.selection.primary),
              },
              ...modelOptions(props.models),
            ],
            disabled: disabled || saving,
            title,
            onChange: props.onPrimaryChange,
          })}
        </label>
        <label class="field">
          <span>${t("modelProviders.defaults.utility")}</span>
          ${renderModelPicker({
            label: t("modelProviders.defaults.utility"),
            value: props.selection.utilityModel ?? AUTOMATIC_UTILITY_VALUE,
            options: [
              {
                value: AUTOMATIC_UTILITY_VALUE,
                label: t("modelProviders.defaults.automatic"),
              },
              { value: "", label: t("modelProviders.defaults.disabled") },
              ...modelOptions(props.models),
            ],
            disabled: disabled || saving,
            title,
            onChange: (value) =>
              props.onUtilityChange(value === AUTOMATIC_UTILITY_VALUE ? null : value),
          })}
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
          ${renderModelPicker({
            label: t("modelProviders.defaults.addFallback"),
            value: "",
            options: [
              { value: "", label: t("modelProviders.defaults.selectFallback") },
              ...modelOptions(
                props.models.filter((model) => {
                  const ref = modelCatalogRef(model);
                  return (
                    ref !== props.selection.primary && !props.selection.fallbacks.includes(ref)
                  );
                }),
              ),
            ],
            disabled: disabled || saving || !props.selection.primary,
            title,
            onChange: (value) => {
              if (value) {
                props.onFallbackAdd(value);
              }
            },
          })}
        </label>
      </div>
      ${props.message
        ? html`<div
            class="callout ${props.message.kind}"
            role=${props.message.kind === "error" ? "alert" : "status"}
          >
            ${props.message.text}
          </div>`
        : nothing}
      ${props.message?.warning
        ? html`<div class="callout warning" role="status">${props.message.warning}</div>`
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
