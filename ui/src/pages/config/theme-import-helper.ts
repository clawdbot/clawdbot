/** Custom theme import helpers — extracted from config-page.ts to keep
 *  the already-oversized Lit element under its LOC-ratchet ceiling. */

import { importCustomThemeFromUrl } from "../../app/custom-theme.ts";
import type { Settings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";

/** Duck-typed interface matching the reactive state properties on ConfigPage. */
export interface ThemeImportState {
  customThemeImportUrl: string;
  customThemeImportBusy: boolean;
  customThemeImportExpanded: boolean;
  customThemeImportSelectOnSuccess: boolean;
  customThemeImportMessage: { kind: "success" | "error"; text: string } | null;
}

export async function executeImportCustomTheme(
  state: ThemeImportState,
  settings: Settings,
  applySettings: (next: Settings) => void,
): Promise<void> {
  if (state.customThemeImportBusy) return;
  state.customThemeImportExpanded = true;
  state.customThemeImportBusy = true;
  state.customThemeImportMessage = null;
  try {
    const customTheme = await importCustomThemeFromUrl(state.customThemeImportUrl);
    const selectTheme = !settings.customTheme || state.customThemeImportSelectOnSuccess;
    applySettings({
      ...settings,
      customTheme,
      theme: selectTheme ? "custom" : settings.theme,
    });
    state.customThemeImportUrl = "";
    state.customThemeImportSelectOnSuccess = false;
    state.customThemeImportMessage = {
      kind: "success",
      text: t("configPage.themeImported", { name: customTheme.label }),
    };
  } catch (error) {
    state.customThemeImportMessage = {
      kind: "error",
      text: error instanceof Error ? error.message : String(error),
    };
  } finally {
    state.customThemeImportBusy = false;
  }
}

export function executeClearCustomTheme(
  state: ThemeImportState,
  settings: Settings,
  applySettings: (next: Settings) => void,
): void {
  state.customThemeImportExpanded = true;
  state.customThemeImportSelectOnSuccess = false;
  applySettings({
    ...settings,
    theme: settings.theme === "custom" ? "claw" : settings.theme,
    customTheme: undefined,
  });
  state.customThemeImportMessage = {
    kind: "success",
    text: t("configPage.themeRemoved"),
  };
}
