import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_I18N_LOCALES } from "./native-app-i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RESOURCE_ROOT = path.join(ROOT, "apps", "android", "app", "src", "main", "res");
const SOURCE_ROOT = path.join(ROOT, "apps", "android", "app", "src", "main");
const ANDROID_QUALIFIERS: Record<string, string> = {
  id: "in",
  "zh-CN": "zh-rCN",
  "zh-TW": "zh-rTW",
  "pt-BR": "pt-rBR",
  "ja-JP": "ja",
};
const localeDirectory = (locale: string) => `values-${ANDROID_QUALIFIERS[locale] ?? locale}`;
const LOCALES = ["values", ...NATIVE_I18N_LOCALES.map(localeDirectory)] as const;
const STRING_RE = /<string\s+name="([A-Za-z0-9_]+)"[^>]*>([\s\S]*?)<\/string>/gu;
const FORMAT_RE = /%\d+\$[a-z]/giu;
const INVALID_APOSTROPHE_RE = /(?:&apos;|(?<!\\)')/u;

async function readStrings(locale: string): Promise<Map<string, string>> {
  const source = await readFile(path.join(RESOURCE_ROOT, locale, "strings.xml"), "utf8");
  return new Map(
    [...source.matchAll(STRING_RE)]
      .map((match) => [match[1], match[2]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
  );
}

async function readAndroidSource(root = SOURCE_ROOT): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const sources: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (fullPath.startsWith(`${RESOURCE_ROOT}${path.sep}values`)) {
        continue;
      }
      sources.push(await readAndroidSource(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(?:kt|kts|xml)$/u.test(entry.name)) {
      sources.push(await readFile(fullPath, "utf8"));
    }
  }
  return sources.join("\n");
}

function findInvalidResourceSyntax(strings: Map<string, string>): string[] {
  return [...strings]
    .filter(([, value]) => {
      const trimmed = value.trim();
      const isQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
      return !isQuoted && INVALID_APOSTROPHE_RE.test(trimmed);
    })
    .map(([key]) => key);
}

export async function checkAndroidAppI18n() {
  const [source, localeStrings] = await Promise.all([
    readAndroidSource(),
    Promise.all(LOCALES.map(readStrings)),
  ]);
  const [base, ...translations] = localeStrings;
  const baseKeys = new Set(base.keys());
  const problems: Array<readonly [string, string[]]> = translations.flatMap((strings, index) => {
    const locale = NATIVE_I18N_LOCALES[index];
    const keys = new Set(strings.keys());
    const placeholderMismatches = [...base].flatMap(([key, sourceValue]) => {
      const translatedValue = strings.get(key);
      if (!translatedValue) {
        return [];
      }
      const expected = [...sourceValue.matchAll(FORMAT_RE)].map((match) => match[0]).toSorted();
      const actual = [...translatedValue.matchAll(FORMAT_RE)].map((match) => match[0]).toSorted();
      return expected.join("\u0000") === actual.join("\u0000") ? [] : [key];
    });
    return [
      [`${locale} missing`, [...baseKeys].filter((key) => !keys.has(key))],
      [`${locale} extra`, [...keys].filter((key) => !baseKeys.has(key))],
      [`${locale} placeholders`, placeholderMismatches],
      [`${locale} syntax`, findInvalidResourceSyntax(strings)],
    ] as const;
  });
  problems.push(["English syntax", findInvalidResourceSyntax(base)]);
  const unusedBaseKeys = [...baseKeys].filter(
    (key) => !source.includes(`R.string.${key}`) && !source.includes(`@string/${key}`),
  );
  problems.push(["English unused", unusedBaseKeys]);
  if (problems.some(([, keys]) => keys.length)) {
    throw new Error(
      [
        "Android app i18n resources are out of sync.",
        ...problems.map(([label, keys]) => `${label}=${keys.join(",") || "none"}`),
      ].join("\n"),
    );
  }
  process.stdout.write(
    `android-app-i18n: keys=${baseKeys.size} locales=${NATIVE_I18N_LOCALES.join(",")}\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const [command] = process.argv.slice(2);
  if (command !== "check") {
    throw new Error("usage: node --import tsx scripts/android-app-i18n.ts check");
  }
  await checkAndroidAppI18n();
}
