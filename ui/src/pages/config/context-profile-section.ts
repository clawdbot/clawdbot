/**
 * Context Profile preset section — renders preset selector, apply button,
 * and inline status feedback. Extracted from quick.ts to keep the
 * already-oversized settings view module under its LOC-ratchet ceiling.
 */

import { html, nothing } from "lit";
import {
  renderSettingsRow,
  renderSettingsSegmented,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { CONFIG_PRESETS, type ConfigPresetId } from "./presets.ts";

export type PresetSectionProps = {
  activePresetId?: ConfigPresetId | null;
  pendingPresetId?: ConfigPresetId | null;
  presetApplying?: ConfigPresetId | null;
  presetError?: string | null;
  onSelectPreset?: (presetId: ConfigPresetId | null) => void;
  onApplyPreset?: (presetId: ConfigPresetId) => void;
};

export function renderContextProfileSection(props: PresetSectionProps, configBusy: boolean) {
  return [
    renderSettingsRow({
      title: t("quickSettings.presets.title"),
      control: renderSettingsSegmented<ConfigPresetId | "">({
        value: props.pendingPresetId ?? props.activePresetId ?? "",
        options: [
          { value: "" as const, label: t("quickSettings.presets.none") },
          ...CONFIG_PRESETS.map((p) => ({
            value: p.id,
            label: t(`quickSettings.presets.${p.id}.label`),
          })),
        ],
        disabled: configBusy || props.presetApplying != null,
        onChange: (id) => {
          if (id && id !== props.activePresetId) {
            props.onSelectPreset?.(id);
          } else if (id && id === props.activePresetId) {
            // Re-selecting the active preset clears the pending selection
            props.onSelectPreset?.(null);
          } else if (!id) {
            props.onSelectPreset?.(null);
          }
        },
      }),
    }),
    // Explicit Apply button when a different preset is pending
    props.pendingPresetId != null && props.pendingPresetId !== props.activePresetId
      ? renderSettingsRow({
          title: "",
          control: html`
            <button
              class="btn btn--sm primary"
              ?disabled=${configBusy || props.presetApplying != null}
              @click=${() => props.onApplyPreset?.(props.pendingPresetId!)}
            >
              ${t("quickSettings.presets.apply")}
              ${t(`quickSettings.presets.${props.pendingPresetId}.label`)}
            </button>
          `,
        })
      : nothing,
    // ponytail: inline applying / error feedback for preset application
    props.presetApplying != null
      ? renderSettingsRow({
          title: "",
          control: renderSettingsStatus({
            kind: "muted",
            label: t("quickSettings.presets.applying"),
          }),
        })
      : props.presetError
        ? renderSettingsRow({
            title: "",
            control: renderSettingsStatus({ kind: "danger", label: props.presetError }),
          })
        : nothing,
  ].filter(Boolean);
}
