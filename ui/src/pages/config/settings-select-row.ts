// Shared labeled select rendering for compact Control UI preference rows.
import { html } from "lit";
import { renderSettingsRow } from "../../components/settings-ui.ts";

export function renderSettingsSelectRow<T extends string>(params: {
  title: string;
  value: T;
  setting: "send-shortcut" | "follow-up-mode" | "catalog-open-target";
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: string) => void;
}) {
  return renderSettingsRow({
    title: params.title,
    control: html`
      <select
        class="settings-select"
        ?data-settings-send-shortcut=${params.setting === "send-shortcut"}
        ?data-settings-follow-up-mode=${params.setting === "follow-up-mode"}
        ?data-settings-catalog-open-target=${params.setting === "catalog-open-target"}
        aria-label=${params.title}
        .value=${params.value}
        @change=${(event: Event) =>
          params.onChange((event.currentTarget as HTMLSelectElement).value)}
      >
        ${params.options.map(
          (option) => html`
            <option value=${option.value} ?selected=${params.value === option.value}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    `,
  });
}
