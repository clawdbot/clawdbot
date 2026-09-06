import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { renderNode } from "../../components/config-form.node.ts";
import { hintForPath, humanize, type JsonSchema } from "../../components/config-form.shared.ts";
import {
  renderSettingsGroup,
  renderSettingsPage,
  renderSettingsRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { SETUP_CONSENT_DEFAULTS, SETUP_HISTORY_KEYS } from "./setup-schema.ts";
import type { ConfigProps } from "./view-types.ts";

export function renderSetupSection(schema: JsonSchema, props: ConfigProps, disabled: boolean) {
  const wizard = isRecord(props.formValue?.wizard) ? props.formValue.wizard : {};
  return renderSettingsPage(html`
    <details
      class="settings-section config-advanced-disclosure"
      id="config-section-wizard"
      ?open=${props.forceAdvancedSection === "wizard"}
    >
      <summary class="settings-section__heading config-advanced-disclosure__summary">
        ${t("configForm.sections.wizard.label")}
      </summary>
      <p class="settings-section__desc">${t("configForm.sections.wizard.description")}</p>
      ${renderSettingsGroup(
        Object.entries(SETUP_CONSENT_DEFAULTS).map(([key, defaultValue]) => {
          const field = schema.properties?.[key];
          return field
            ? renderNode({
                schema: { ...field, default: defaultValue },
                value: wizard[key],
                path: ["wizard", key],
                hints: props.uiHints,
                unsupported: new Set(),
                disabled,
                onPatch: props.onFormPatch,
                onRemove: props.onFormRemove,
              })
            : nothing;
        }),
      )}
      ${renderSettingsGroup(
        SETUP_HISTORY_KEYS.flatMap((key) => {
          const value = wizard[key];
          if (typeof value !== "string" || !value) {
            return [];
          }
          const hint = hintForPath(["wizard", key], props.uiHints);
          return [
            renderSettingsRow({
              title: hint?.label ?? schema.properties?.[key]?.title ?? humanize(key),
              description: value,
            }),
          ];
        }),
      )}
    </details>
  `);
}
