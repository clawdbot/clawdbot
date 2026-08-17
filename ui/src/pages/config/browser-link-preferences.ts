import { renderSettingsToggleRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

export function renderBrowserLinkPreferencesRow(props: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return renderSettingsToggleRow({
    title: t("browserLinkPreferences.openInControlUi"),
    checked: props.enabled,
    onChange: props.onChange,
  });
}
