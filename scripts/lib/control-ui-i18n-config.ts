import controlUiLocaleEntries from "./control-ui-i18n-config.json" with { type: "json" };
import type { LocaleEntry } from "./control-ui-i18n-sync-plan.ts";

type ConfiguredLocaleEntry = LocaleEntry & { staged?: boolean };
const configuredLocaleEntries = controlUiLocaleEntries as readonly ConfiguredLocaleEntry[];

const CONTROL_UI_STAGED_LOCALE_ENTRIES = configuredLocaleEntries.filter(
  (entry) => entry.staged === true,
) satisfies readonly LocaleEntry[];
export const CONTROL_UI_LOCALE_ENTRIES = configuredLocaleEntries.filter(
  (entry) => entry.staged !== true,
) satisfies readonly LocaleEntry[];
export const CONTROL_UI_LOCALE_REFRESH_ENTRIES: readonly LocaleEntry[] = [
  ...CONTROL_UI_STAGED_LOCALE_ENTRIES,
  ...CONTROL_UI_LOCALE_ENTRIES,
];
