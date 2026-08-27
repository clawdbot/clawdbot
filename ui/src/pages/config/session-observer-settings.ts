import { html } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import { providerIdFromModelRef } from "../../components/provider-icon.ts";
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
      provider: model.provider,
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
  const selectedProvider = providerIdFromModelRef(selected);
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
        control: renderModelPicker({
          label: t("configView.sessionObserver.modelPicker"),
          value: selected,
          options: [
            { value: AUTO_VALUE, label: t("configView.sessionObserver.auto") },
            { value: "", label: t("configView.sessionObserver.disabled") },
            ...(selected !== AUTO_VALUE && selected !== "" && !selectedIsCatalogModel
              ? [
                  {
                    value: selected,
                    label: selected,
                    disabled: props.modelsUnavailable,
                    ...(selectedProvider ? { provider: selectedProvider } : {}),
                  },
                ]
              : []),
            ...options.map(({ value, label, provider }) => ({
              value,
              label,
              provider,
              disabled: props.modelsUnavailable,
            })),
          ],
          disabled: props.disabled,
          onChange: (value) =>
            props.onUtilityModelChange(
              value === AUTO_VALUE
                ? { kind: "auto" }
                : value === ""
                  ? { kind: "disabled" }
                  : { kind: "model", model: value },
            ),
        }),
      })}
    </div>
  `;
}
