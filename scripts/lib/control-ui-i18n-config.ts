import controlUiLocaleEntries from "./control-ui-i18n-config.json" with { type: "json" };
import type { LocaleEntry } from "./control-ui-i18n-sync-plan.ts";

export const CONTROL_UI_LOCALE_ENTRIES = controlUiLocaleEntries satisfies readonly LocaleEntry[];
