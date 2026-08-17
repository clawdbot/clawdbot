import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
  mergeControlUiTranslationMaps,
} from "./lib/control-ui-i18n-catalog.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "./lib/control-ui-i18n-config.ts";
import { syncControlUiRawCopyBaseline } from "./lib/control-ui-i18n-raw-copy.ts";
import type { TranslationMap } from "./lib/control-ui-i18n-sync-plan.ts";
import { collectSourceFileContents } from "./lib/source-file-scan-cache.mts";

export type CatalogFallbackBaseline = {
  fallbacks: Record<string, string[]>;
  sourceHash: string;
  version: number;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES_DIR = path.join(ROOT, "ui", "src", "i18n", "locales");
const I18N_ASSETS_DIR = path.join(ROOT, "ui", "src", "i18n", ".i18n");
const SOURCE_LOCALE_PATH = path.join(LOCALES_DIR, "en.ts");
const ACTIVITY_SOURCE_LOCALE_PATH = path.join(LOCALES_DIR, "en-activity.ts");
const FALLBACK_BASELINE_PATH = path.join(I18N_ASSETS_DIR, "catalog-fallbacks.json");
const FALLBACK_BASELINE_VERSION = 1;
const CONTROL_UI_TEST_FILE_PATTERN = /\.(?:test|browser\.test|node\.test)\.tsx?$/u;

function compareStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toRepoPath(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

export function formatControlUiCatalogFallbackDriftError(): string {
  return [
    "control-ui catalog fallback baseline drift detected.",
    "Run `pnpm ui:i18n:sync` (included in `pnpm release:prep`) and commit the generated locale artifacts.",
  ].join("\n");
}

async function importLocaleModule<T>(filePath: string): Promise<T> {
  const stats = await stat(filePath);
  return (await import(`${pathToFileURL(filePath).href}?ts=${stats.mtimeMs}`)) as T;
}

async function loadLocaleMap(filePath: string, exportName: string): Promise<TranslationMap | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  const mod = await importLocaleModule<Record<string, TranslationMap>>(filePath);
  return mod[exportName] ?? null;
}

async function loadSourceLocaleMap(): Promise<TranslationMap> {
  const source = await loadLocaleMap(SOURCE_LOCALE_PATH, "en");
  const activitySource = (
    await importLocaleModule<{
      registerActivityEnglish: { catalog: TranslationMap };
    }>(ACTIVITY_SOURCE_LOCALE_PATH)
  ).registerActivityEnglish.catalog;
  if (!source || !activitySource) {
    throw new Error("Control UI English source catalogs are incomplete");
  }
  return mergeControlUiTranslationMaps(source, activitySource);
}

async function readSourceLocaleRaw(): Promise<string> {
  const sources = await Promise.all(
    [SOURCE_LOCALE_PATH, ACTIVITY_SOURCE_LOCALE_PATH].map((filePath) => readFile(filePath, "utf8")),
  );
  return sources.join("\n");
}

function extractPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ""))]
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

export function flattenControlUiCatalog(
  value: unknown,
  label: string,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}${prefix ? `:${prefix}` : ""} must be an object`);
  }
  for (const [key, nested] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === "string") {
      out.set(fullKey, nested);
    } else if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error(`${label}:${fullKey} must be a string or object`);
    } else {
      flattenControlUiCatalog(nested, label, fullKey, out);
    }
  }
  return out;
}

export function analyzeControlUiCatalogs(
  sourceFlat: ReadonlyMap<string, string>,
  localeFlats: ReadonlyMap<string, ReadonlyMap<string, string>>,
): { errors: string[]; fallbacks: Record<string, string[]> } {
  const errors: string[] = [];
  const sourceKeys = [...sourceFlat.keys()];
  const sourceKeySet = new Set(sourceKeys);
  const fallbackLocalesByKey = new Map<string, string[]>();

  for (const [locale, localeFlat] of [...localeFlats.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const localeKeys = [...localeFlat.keys()];
    const orphanKeys = localeKeys.filter((key) => !sourceKeySet.has(key));
    if (orphanKeys.length > 0) {
      errors.push(`${locale}: orphan keys: ${orphanKeys.join(", ")}`);
    }

    const expectedPresentOrder = sourceKeys.filter((key) => localeFlat.has(key));
    const actualPresentOrder = localeKeys.filter((key) => sourceKeySet.has(key));
    if (!compareStringArrays(actualPresentOrder, expectedPresentOrder)) {
      errors.push(`${locale}: keys are not in English catalog order`);
    }

    for (const key of sourceKeys) {
      const translated = localeFlat.get(key);
      if (translated === undefined) {
        const locales = fallbackLocalesByKey.get(key) ?? [];
        locales.push(locale);
        fallbackLocalesByKey.set(key, locales);
        continue;
      }
      const sourcePlaceholders = extractPlaceholders(sourceFlat.get(key) ?? "");
      const translatedPlaceholders = extractPlaceholders(translated);
      if (!compareStringArrays(sourcePlaceholders, translatedPlaceholders)) {
        errors.push(
          `${locale}:${key} expected {${sourcePlaceholders.join("},{")}} got {${translatedPlaceholders.join("},{")}}`,
        );
      }
    }
  }

  const fallbacks: Record<string, string[]> = {};
  for (const [key, locales] of [...fallbackLocalesByKey.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    fallbacks[key] = locales.toSorted((left, right) => left.localeCompare(right));
  }
  return { errors, fallbacks };
}

export function verifyControlUiReferencedKeys(
  sourceFlat: ReadonlyMap<string, string>,
  sourceFiles: readonly { content: string; relativeFile: string }[],
): { literalReferences: number; templatePrefixReferences: number } {
  const sourceKeys = [...sourceFlat.keys()];
  const errors: string[] = [];
  let literalReferences = 0;
  let templatePrefixReferences = 0;

  for (const { content, relativeFile } of sourceFiles) {
    const sourceFile = ts.createSourceFile(relativeFile, content, ts.ScriptTarget.Latest, true);
    const reportMissing = (node: ts.Node, description: string) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      errors.push(`${relativeFile}:${line}: ${description}`);
    };
    const verifyArgument = (rawArgument: ts.Expression): void => {
      const argument = ts.isParenthesizedExpression(rawArgument)
        ? rawArgument.expression
        : ts.isAsExpression(rawArgument) || ts.isTypeAssertionExpression(rawArgument)
          ? rawArgument.expression
          : rawArgument;
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        literalReferences += 1;
        if (!sourceFlat.has(argument.text)) {
          reportMissing(argument, `missing English catalog key ${JSON.stringify(argument.text)}`);
        }
      } else if (ts.isTemplateExpression(argument)) {
        templatePrefixReferences += 1;
        const prefix = argument.head.text;
        if (prefix && !sourceKeys.some((key) => key.startsWith(prefix))) {
          reportMissing(argument, `missing English catalog subtree ${JSON.stringify(prefix)}`);
        }
      } else if (ts.isConditionalExpression(argument)) {
        verifyArgument(argument.whenTrue);
        verifyArgument(argument.whenFalse);
      }
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments[0]
      ) {
        verifyArgument(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (errors.length > 0) {
    throw new Error(
      [
        "control-ui referenced translation key verification failed.",
        errors.slice(0, 50).join("\n"),
        errors.length > 50 ? `...and ${errors.length - 50} more` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return { literalReferences, templatePrefixReferences };
}

async function buildCatalogFallbackBaseline(
  options: {
    allowCatalogDrift?: boolean;
  } = {},
): Promise<CatalogFallbackBaseline> {
  const sourceRaw = await readSourceLocaleRaw();
  const sourceMap = await loadSourceLocaleMap();
  const sourceFlat = flattenControlUiCatalog(sourceMap, "en");
  const localeFlats = new Map<string, Map<string, string>>();
  for (const entry of CONTROL_UI_LOCALE_ENTRIES) {
    const memoryPath = path.join(I18N_ASSETS_DIR, `${entry.locale}.tm.jsonl`);
    if (!existsSync(memoryPath)) {
      throw new Error(`${toRepoPath(memoryPath)} does not contain ${entry.locale} translations`);
    }
    const localeMap = materializeControlUiLocaleCatalog(
      sourceFlat,
      loadControlUiTranslationMemory(memoryPath),
    );
    localeFlats.set(entry.locale, flattenControlUiCatalog(localeMap, entry.locale));
  }

  const analysis = analyzeControlUiCatalogs(sourceFlat, localeFlats);
  if (analysis.errors.length > 0 && !options.allowCatalogDrift) {
    throw new Error(
      [
        "control-ui catalog verification failed.",
        analysis.errors.slice(0, 50).join("\n"),
        analysis.errors.length > 50 ? `...and ${analysis.errors.length - 50} more` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (analysis.errors.length > 0) {
    process.stdout.write(
      `control-ui-i18n: catalog: tolerated_errors=${analysis.errors.length} during scoped sync\n`,
    );
  }

  return {
    fallbacks: analysis.fallbacks,
    sourceHash: createHash("sha256").update(sourceRaw).digest("hex"),
    version: FALLBACK_BASELINE_VERSION,
  };
}

function printCatalogFallbackSummary(baseline: CatalogFallbackBaseline) {
  const fallbackPairCount = Object.values(baseline.fallbacks).reduce(
    (total, locales) => total + locales.length,
    0,
  );
  process.stdout.write(
    `control-ui-i18n: catalog: fallback_keys=${Object.keys(baseline.fallbacks).length} fallback_pairs=${fallbackPairCount}\n`,
  );
}

async function verifyControlUiSourceCatalogShape() {
  const sourceMap = await loadSourceLocaleMap();
  const sourceFlat = flattenControlUiCatalog(sourceMap, "en");
  const sourceFiles = (
    await collectSourceFileContents({
      ignoredDirNames: new Set(["test-helpers"]),
      repoRoot: ROOT,
      scanExtensions: new Set([".ts", ".tsx"]),
      scanRoots: ["ui/src"],
    })
  ).filter(({ relativeFile }) => !CONTROL_UI_TEST_FILE_PATTERN.test(relativeFile));
  const referenced = verifyControlUiReferencedKeys(sourceFlat, sourceFiles);
  process.stdout.write(
    `control-ui-i18n: source: keys=${sourceFlat.size} literal_references=${referenced.literalReferences} template_prefix_references=${referenced.templatePrefixReferences}\n`,
  );
}

export async function syncControlUiCatalogFallbackBaseline(options: {
  allowCatalogDrift?: boolean;
  checkOnly: boolean;
  write: boolean;
}) {
  const baseline = await buildCatalogFallbackBaseline({
    allowCatalogDrift: options.allowCatalogDrift,
  });
  const expected = `${JSON.stringify(baseline, null, 2)}\n`;
  const current = existsSync(FALLBACK_BASELINE_PATH)
    ? await readFile(FALLBACK_BASELINE_PATH, "utf8")
    : "";
  if (!options.checkOnly && options.write && current !== expected) {
    await mkdir(I18N_ASSETS_DIR, { recursive: true });
    await writeFile(FALLBACK_BASELINE_PATH, expected, "utf8");
  }
  if (options.checkOnly && current !== expected) {
    throw new Error(formatControlUiCatalogFallbackDriftError());
  }
  printCatalogFallbackSummary(baseline);
}

export async function verifyRuntimeLocaleConfig() {
  const registryRaw = await readFile(
    path.join(ROOT, "ui", "src", "i18n", "lib", "registry.ts"),
    "utf8",
  );
  const typesRaw = await readFile(path.join(ROOT, "ui", "src", "i18n", "lib", "types.ts"), "utf8");
  for (const entry of CONTROL_UI_LOCALE_ENTRIES) {
    if (!registryRaw.includes(`"${entry.locale}"`) || !typesRaw.includes(`| "${entry.locale}"`)) {
      throw new Error(`runtime locale config is missing ${entry.locale}`);
    }
  }

  const enMap = (await loadLocaleMap(SOURCE_LOCALE_PATH, "en")) ?? {};
  const languageMap = enMap.languages;
  const languageKeys =
    languageMap && typeof languageMap === "object"
      ? Object.keys(languageMap).toSorted((left, right) => left.localeCompare(right))
      : [];
  const expectedLanguageKeys = [
    "en",
    ...CONTROL_UI_LOCALE_ENTRIES.map((entry) => entry.languageKey),
  ].toSorted((left, right) => left.localeCompare(right));
  if (!compareStringArrays(languageKeys, expectedLanguageKeys)) {
    throw new Error(
      `ui/src/i18n/locales/en.ts languages block is out of sync: expected ${expectedLanguageKeys.join(", ")}, got ${languageKeys.join(", ")}`,
    );
  }
}

export async function verifyControlUiGeneratedCatalogs(options: {
  checkOnly: boolean;
  write: boolean;
}) {
  await verifyRuntimeLocaleConfig();
  await syncControlUiRawCopyBaseline(options);
  await syncControlUiCatalogFallbackBaseline(options);
}

async function verifyControlUiContributorCatalogs(options: { checkOnly: boolean; write: boolean }) {
  await verifyRuntimeLocaleConfig();
  await syncControlUiRawCopyBaseline(options);
  // Foreign catalogs may be stale after an English rename, deletion, or
  // placeholder change. The post-merge locale workflow owns that repair.
  await verifyControlUiSourceCatalogShape();
}

function usage(): never {
  console.error("Usage: node --import tsx scripts/control-ui-i18n-verify.ts <verify|baseline>");
  process.exit(2);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if ((command !== "verify" && command !== "baseline") || rest.length > 0) {
    usage();
  }
  await verifyControlUiContributorCatalogs({
    checkOnly: command === "verify",
    write: command === "baseline",
  });
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
