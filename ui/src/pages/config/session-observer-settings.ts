import { html, nothing } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { renderSettingsRow, renderSettingsToggleRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

const AUTO_VALUE = "__openclaw_observer_auto__";

export type SessionObserverModelSelection =
  | { kind: "auto" }
  | { kind: "disabled" }
  | { kind: "model"; model: string };

export function buildSessionObserverTogglePatch(enabled: boolean) {
  return {
    gateway: {
      controlUi: {
        // The server default is enabled. null restores that default; false is an explicit opt-out.
        sessionObserver: enabled ? null : false,
      },
    },
  };
}

export function buildSessionObserverUtilityModelPatch(selection: SessionObserverModelSelection) {
  return {
    agents: {
      defaults: {
        utilityModel:
          selection.kind === "auto" ? null : selection.kind === "disabled" ? "" : selection.model,
      },
    },
  };
}

function resolvedModelLabel(status: SystemInfoResult["defaultAgentUtilityModel"]): string {
  if (!status || status.status === "unavailable") {
    return t("configView.sessionObserver.modelUnavailable");
  }
  if (status.status === "disabled") {
    return t("configView.sessionObserver.modelDisabled");
  }
  return t(
    status.status === "auto"
      ? "configView.sessionObserver.modelAuto"
      : "configView.sessionObserver.modelConfigured",
    { model: status.model },
  );
}

function modelOptions(models: readonly ModelCatalogEntry[]) {
  const seen = new Set<string>();
  return models
    .filter((model) => model.available !== false)
    .map((model) => ({
      value: model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`,
      label: model.name || model.id,
    }))
    .filter((model) => {
      if (seen.has(model.value)) {
        return false;
      }
      seen.add(model.value);
      return true;
    })
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function renderSessionObserverSettings(props: {
  enabled: boolean;
  utilityModel: string | undefined;
  resolvedUtilityModel: SystemInfoResult["defaultAgentUtilityModel"];
  models: readonly ModelCatalogEntry[];
  modelsUnavailable: boolean;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onUtilityModelChange: (selection: SessionObserverModelSelection) => void;
}) {
  const selected = props.utilityModel === undefined ? AUTO_VALUE : props.utilityModel;
  const options = modelOptions(props.models);
  const selectedIsCatalogModel = options.some((option) => option.value === selected);
  return html`
    <div class="settings-group">
      ${renderSettingsToggleRow({
        title: t("configView.sessionObserver.toggle"),
        description: t("configView.sessionObserver.toggleHint"),
        checked: props.enabled,
        disabled: props.disabled,
        onChange: props.onEnabledChange,
      })}
      ${renderSettingsRow({
        title: t("configView.sessionObserver.resolvedModel"),
        description: resolvedModelLabel(props.resolvedUtilityModel),
      })}
      ${renderSettingsRow({
        title: t("configView.sessionObserver.modelPicker"),
        description: props.modelsUnavailable
          ? t("configView.sessionObserver.modelCatalogUnavailable")
          : t("configView.sessionObserver.modelPickerHint"),
        control: html`
          <select
            class="settings-select"
            aria-label=${t("configView.sessionObserver.modelPicker")}
            .value=${selected}
            ?disabled=${props.disabled}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              props.onUtilityModelChange(
                value === AUTO_VALUE
                  ? { kind: "auto" }
                  : value === ""
                    ? { kind: "disabled" }
                    : { kind: "model", model: value },
              );
            }}
          >
            <option value=${AUTO_VALUE}>${t("configView.sessionObserver.auto")}</option>
            <option value="">${t("configView.sessionObserver.disabled")}</option>
            ${selected !== AUTO_VALUE && selected !== "" && !selectedIsCatalogModel
              ? html`<option value=${selected} ?disabled=${props.modelsUnavailable}>
                  ${selected}
                </option>`
              : nothing}
            ${options.map(
              (option) => html`<option value=${option.value} ?disabled=${props.modelsUnavailable}>
                ${option.label}
              </option>`,
            )}
          </select>
        `,
      })}
    </div>
  `;
}
