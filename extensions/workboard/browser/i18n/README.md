# Workboard translations

`locales/en.ts` owns the browser plugin's source text. `locales/translated.json`
preserves the existing Control UI translations for those keys, validated against
the English text hashes by the canonical translation-memory materializer.
Missing translations fall back to English.

Regenerate the snapshot from the repository root after refreshing the shared
translation memory:

```sh
node --import ./scripts/tsx.mjs --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs';
import en from './extensions/workboard/browser/i18n/locales/en.ts';
import { CONTROL_UI_LOCALE_ENTRIES } from './scripts/lib/control-ui-i18n-config.ts';
import { loadControlUiTranslationMemory, materializeControlUiLocaleCatalog } from './scripts/lib/control-ui-i18n-catalog.ts';
import { flattenTranslations } from './scripts/lib/control-ui-i18n-sync-plan.ts';
const source = flattenTranslations(en);
const catalogs = Object.fromEntries(CONTROL_UI_LOCALE_ENTRIES.map(({ locale }) => [
  locale,
  materializeControlUiLocaleCatalog(source, loadControlUiTranslationMemory(`ui/src/i18n/.i18n/${locale}.tm.jsonl`)),
]));
writeFileSync('extensions/workboard/browser/i18n/locales/translated.json', `${JSON.stringify(catalogs, null, 2)}\n`);
NODE
```

The shared translation authoring pipeline currently discovers core catalogs.
Adding plugin-owned source catalogs to that discovery is follow-up work; new
Workboard copy can be translated directly in the plugin catalog meanwhile.
