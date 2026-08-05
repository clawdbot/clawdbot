import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildControlUiSharedLocaleBundle,
  loadControlUiSharedCatalog,
} from "../../../scripts/lib/control-ui-i18n-shared-catalog.ts";

type NativeTranslation = {
  id?: unknown;
  source?: unknown;
  translated?: unknown;
};

type NativeSource = {
  id?: unknown;
  semanticKey?: unknown;
  source?: unknown;
  surface?: unknown;
};

type MessageDefinition = {
  defaultMessage: string;
  description: string;
};

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const definitionsPath = fileURLToPath(new URL("./messages.json", import.meta.url));
const outputPath = fileURLToPath(new URL("./locales.json", import.meta.url));
const nativeLocaleDir = path.join(rootDir, "apps", ".i18n", "native");
const nativeSourcePath = path.join(rootDir, "apps", ".i18n", "native-source.json");
const check = process.argv.includes("--check");
const checkSource = process.argv.includes("--check-source");

// Existing Control UI keys retain their identity and translation memory across both desktop UIs.
const SHARED_CONTROL_UI_KEYS = [
  "agentChip.agents",
  "chat.composer.placeholder",
  "chat.composer.runDone",
  "chat.composer.runInterrupted",
  "chat.runControls.sendMessage",
  "common.connected",
  "common.reset",
] as const;

function compareStableKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function placeholders(source: string): string {
  return [...source.matchAll(/\{([A-Za-z][\w]*)\}/gu)]
    .map((match) => match[1])
    .toSorted(compareStableKeys)
    .join("\0");
}

export function isDesktopLocaleSourceCurrent(
  checkedIn: unknown,
  expected: Record<string, Record<string, string>>,
): boolean {
  if (!checkedIn || typeof checkedIn !== "object" || Array.isArray(checkedIn)) {
    return false;
  }
  const actual = checkedIn as Record<string, unknown>;
  if (!actual.en || typeof actual.en !== "object" || Array.isArray(actual.en)) {
    return false;
  }
  const english = actual.en as Record<string, unknown>;
  if (
    Object.keys(english).length !== Object.keys(expected.en).length ||
    Object.entries(expected.en).some(
      ([semanticKey, source]) => !Object.hasOwn(english, semanticKey) || english[semanticKey] !== source,
    )
  ) {
    return false;
  }

  return Object.entries(actual).every(([locale, messages]) => {
    if (
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale) ||
      !messages ||
      typeof messages !== "object" ||
      Array.isArray(messages)
    ) {
      return false;
    }
    return Object.entries(messages).every(([semanticKey, translated]) => {
      if (typeof translated !== "string") {
        return false;
      }
      const source = expected.en[semanticKey];
      return source === undefined || placeholders(source) === placeholders(translated);
    });
  });
}

function loadNativeTranslations(locale: string): Map<string, { source: string; translated: string }> {
  const localePath = path.join(nativeLocaleDir, `${locale}.json`);
  const parsed = JSON.parse(readFileSync(localePath, "utf8")) as {
    entries?: NativeTranslation[];
  };
  const translations = new Map<string, { source: string; translated: string }>();
  for (const entry of parsed.entries ?? []) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.source !== "string" ||
      typeof entry.translated !== "string" ||
      !entry.translated.trim()
    ) {
      continue;
    }
    if (placeholders(entry.source) !== placeholders(entry.translated)) {
      continue;
    }
    translations.set(entry.id, { source: entry.source, translated: entry.translated });
  }
  return translations;
}

const definitions = JSON.parse(readFileSync(definitionsPath, "utf8")) as Record<
  string,
  MessageDefinition
>;
const nativeLocales = readdirSync(nativeLocaleDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .toSorted(compareStableKeys);
const catalog = await loadControlUiSharedCatalog({ rootDir, locales: nativeLocales });
const nativeInventory = JSON.parse(readFileSync(nativeSourcePath, "utf8")) as {
  entries?: NativeSource[];
};
const nativeLinuxIds = new Map(
  (nativeInventory.entries ?? [])
    .filter(
      (entry): entry is NativeSource & { id: string; semanticKey: string; source: string } =>
        entry.surface === "linux" &&
        typeof entry.id === "string" &&
        typeof entry.semanticKey === "string" &&
        typeof entry.source === "string",
    )
    .map((entry) => [entry.semanticKey, { id: entry.id, source: entry.source }] as const),
);
const bundle = buildControlUiSharedLocaleBundle(catalog, {
  keys: SHARED_CONTROL_UI_KEYS,
  prefixes: ["desktop"],
});

for (const locale of nativeLocales) {
  const translated = bundle[locale] ?? {};
  const native = loadNativeTranslations(locale);
  for (const [semanticKey, definition] of Object.entries(definitions)) {
    const owner = nativeLinuxIds.get(semanticKey);
    const ownedTranslation = owner ? native.get(owner.id) : undefined;
    if (
      ownedTranslation &&
      owner?.source === definition.defaultMessage &&
      ownedTranslation.source === definition.defaultMessage
    ) {
      translated[semanticKey] = ownedTranslation.translated;
    }
  }
  bundle[locale] = Object.fromEntries(
    Object.entries(translated).toSorted(([left], [right]) => compareStableKeys(left, right)),
  );
}

const ordered = Object.fromEntries(
  Object.entries(bundle).toSorted(([left], [right]) => {
    if (left === "en") {
      return -1;
    }
    if (right === "en") {
      return 1;
    }
    return compareStableKeys(left, right);
  }),
);
const serialized = `${JSON.stringify(ordered, null, 2)}\n`;

const executedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executedDirectly) {
  if (check || checkSource) {
    let current = false;
    if (existsSync(outputPath)) {
      const existing = readFileSync(outputPath, "utf8");
      if (check) {
        current = existing === serialized;
      } else {
        try {
          current = isDesktopLocaleSourceCurrent(JSON.parse(existing), ordered);
        } catch {
          current = false;
        }
      }
    }
    if (!current) {
      console.error(
        "Desktop locale bundle is stale; run node --import tsx apps/linux/ui/generate-locales.ts",
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outputPath, serialized);
    console.log(
      `Generated ${Object.keys(bundle.en).length} desktop messages for ${Object.keys(bundle).length} locales.`,
    );
  }
}
