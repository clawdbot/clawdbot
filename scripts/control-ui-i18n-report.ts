import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const I18N_ASSETS_DIR = path.join(ROOT, "ui/src/i18n/.i18n");
const RAW_COPY_BASELINE_PATH = path.join(I18N_ASSETS_DIR, "raw-copy-baseline.json");
const DEFAULT_TOP = 10;
const LOCALE_LABELS: Record<string, string> = {
  ar: "Arabic",
  de: "German",
  es: "Spanish",
  fa: "Persian",
  fr: "French",
  id: "Indonesian",
  it: "Italian",
  "ja-JP": "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  "pt-BR": "Brazilian Portuguese",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
};
const REPORT_LOCALES = new Set(Object.keys(LOCALE_LABELS));
const PATH_LABELS: Record<string, string> = {
  "ui/src/ui/chat/chat-queue.ts": "Chat queue",
  "ui/src/ui/chat/grouped-render.ts": "Chat message groups",
  "ui/src/ui/chat/side-result-render.ts": "Chat tool result panel",
  "ui/src/ui/chat/tool-cards.ts": "Chat tool cards",
  "ui/src/ui/views/agents-panels-overview.ts": "Agents overview panel",
  "ui/src/ui/views/agents-panels-tools-skills.ts": "Agents tools and skills panel",
  "ui/src/ui/views/agents-utils.ts": "Agents shared UI helpers",
  "ui/src/ui/views/chat.ts": "Chat page",
  "ui/src/ui/views/config-form.render.ts": "Config form",
  "ui/src/ui/views/config-quick.ts": "Quick config page",
  "ui/src/ui/views/config.ts": "Config page",
  "ui/src/ui/views/cron.ts": "Cron page",
  "ui/src/ui/views/usage-query.ts": "Usage filters",
  "ui/src/ui/views/usage-render-details.ts": "Usage detail view",
  "ui/src/ui/views/usage-render-overview.ts": "Usage overview",
};

type RawCopyKind = "html-attribute" | "html-text" | "object-property";

export type RawCopyBaselineEntry = {
  count: number;
  kind: RawCopyKind;
  name: string;
  path: string;
  text: string;
};

type RawCopyBaseline = {
  entries: RawCopyBaselineEntry[];
  version: number;
};

type LocaleMeta = {
  fallbackKeys: string[];
  generatedAt: string;
  locale: string;
  model: string;
  provider: string;
  sourceHash: string;
  totalKeys: number;
  translatedKeys: number;
  workflow: number;
};

type ReportArgs = {
  locale?: string;
  surface?: string;
  top: number;
};

export type RawCopySummary = {
  entries: number;
  occurrences: number;
  topPaths: Array<{ count: number; path: string }>;
};

export type LocaleSummary = {
  fallbackKeysInScope: string[];
  meta: LocaleMeta;
};

type ReportInput = {
  locale?: LocaleSummary;
  rawCopy: RawCopySummary;
  surface?: string;
};

export function parseArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { top: DEFAULT_TOP };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--surface") {
      args.surface = readOptionValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--locale") {
      args.locale = parseLocale(readOptionValue(argv, (index += 1), arg));
      continue;
    }
    if (arg === "--top") {
      const raw = readOptionValue(argv, (index += 1), arg);
      if (!/^[1-9][0-9]*$/.test(raw)) {
        throw new Error(`--top must be a positive integer: ${raw}`);
      }
      const top = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(top)) {
        throw new Error(`--top must be a positive integer: ${raw}`);
      }
      args.top = top;
      continue;
    }
    throw new Error(`unknown argument: ${arg}\n${usage()}`);
  }
  return args;
}

function readOptionValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseLocale(locale: string) {
  if (!REPORT_LOCALES.has(locale)) {
    throw new Error(`unknown locale: ${locale}`);
  }
  return locale;
}

export function filterRawCopyEntries(entries: RawCopyBaselineEntry[], surface?: string) {
  if (!surface) {
    return entries;
  }
  const normalized = normalizeToken(surface);
  return entries.filter((entry) => pathTokens(entry.path).some((token) => token === normalized));
}

export function summarizeRawCopy(entries: RawCopyBaselineEntry[], top: number): RawCopySummary {
  const byPath = new Map<string, number>();
  let occurrences = 0;

  for (const entry of entries) {
    occurrences += entry.count;
    byPath.set(entry.path, (byPath.get(entry.path) ?? 0) + entry.count);
  }

  const rankedPaths = [...byPath.entries()]
    .map(([entryPath, count]) => ({ count, path: entryPath }))
    .toSorted(compareCountThenName((entry) => entry.path));

  return {
    entries: entries.length,
    occurrences,
    topPaths: rankedPaths.slice(0, top),
  };
}

function compareCountThenName<T>(nameOf: (value: T) => string) {
  return (left: T & { count: number }, right: T & { count: number }) =>
    right.count - left.count || nameOf(left).localeCompare(nameOf(right));
}

function pathTokens(repoPath: string) {
  return repoPath.split("/").flatMap((part) => surfaceTokens(part.replace(/\.[^.]+$/, "")));
}

function surfaceTokens(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(normalizeToken);
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

export function filterTranslationKeysBySurface(keys: string[], surface?: string) {
  if (!surface) {
    return keys;
  }
  const normalized = normalizeToken(surface);
  return keys.filter((key) =>
    key.split(".").some((part) => surfaceTokens(part).some((token) => token === normalized)),
  );
}

export function formatReport(input: ReportInput) {
  const lines = [
    "Control UI i18n baseline report",
    `Scope: ${formatSurfaceLabel(input.surface)}, ${
      input.locale ? formatLocaleLabel(input.locale.meta.locale) : "no locale selected"
    }`,
    "Based on: current raw-copy baseline and locale metadata. Not a drift check.",
    "",
    "Current i18n state",
    `  Hardcoded UI text outside i18n: ${input.rawCopy.entries} pieces in code, ${input.rawCopy.occurrences} total occurrences.`,
    ...formatLocaleState(input.locale),
    "",
    "Current issue",
    ...formatIssueLines(input),
    "",
    "Focus modules",
    ...formatTopPathLines(input.rawCopy.topPaths),
    "",
    "Next steps",
    ...formatNextStepLines(input),
  ];

  return `${lines.join("\n")}\n`;
}

function formatLocaleState(locale?: LocaleSummary) {
  if (!locale) {
    return ["  Existing translation keys: not checked. Add --locale <code> to include them."];
  }
  return [
    `  Existing ${locale.meta.locale} translation keys (all Control UI): ${locale.meta.translatedKeys}/${locale.meta.totalKeys} filled, ${formatFallbackCount(locale.meta.fallbackKeys.length)}.`,
  ];
}

function formatIssueLines(input: ReportInput) {
  const scope = input.surface ? formatSurfaceLabel(input.surface) : "Control UI";
  const lines: string[] = [];

  if (input.rawCopy.entries === 0) {
    lines.push(`  No hardcoded UI text found in ${scope}.`);
  } else {
    lines.push(`  ${scope} still has UI text written directly in code.`);
  }

  if (!input.locale) {
    lines.push("  Locale-specific gaps were not checked.");
    return lines;
  }

  if (input.locale.fallbackKeysInScope.length === 0) {
    lines.push(`  No ${input.locale.meta.locale} locale problems found in this scope.`);
    return lines;
  }

  lines.push(
    `  ${input.locale.meta.locale} has ${formatMissingKeyCount(input.locale.fallbackKeysInScope.length)}.`,
  );
  return lines;
}

function formatNextStepLines(input: ReportInput) {
  if (input.rawCopy.entries === 0) {
    return ["  No module work needed for hardcoded text in this scope."];
  }
  return [
    "  Move text from the focus modules into translation keys.",
    "  Do not hand-edit generated locale, translation memory, or i18n metadata files.",
    "  Run pnpm ui:i18n:sync after adding translation keys.",
  ];
}

function formatTopPathLines(entries: Array<{ count: number; path: string }>) {
  if (entries.length === 0) {
    return ["  none"];
  }
  return entries.map((entry) => `  ${entry.count} ${formatPathLabel(entry.path)}: ${entry.path}`);
}

function formatMissingKeyCount(count: number) {
  return `${count} missing ${count === 1 ? "key" : "keys"}`;
}

function formatFallbackCount(count: number) {
  return `${count} ${count === 1 ? "fallback" : "fallbacks"}`;
}

function formatSurfaceLabel(surface?: string) {
  if (!surface) {
    return "all Control UI";
  }
  return toTitleWords(surface);
}

function formatLocaleLabel(locale: string) {
  const label = LOCALE_LABELS[locale];
  return label ? `${label} (${locale})` : locale;
}

function formatPathLabel(repoPath: string) {
  return PATH_LABELS[repoPath] ?? toTitleWords(path.basename(repoPath).replace(/\.[^.]+$/, ""));
}

function toTitleWords(value: string) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

async function loadRawCopyBaseline(): Promise<RawCopyBaseline> {
  const parsed = JSON.parse(await readFile(RAW_COPY_BASELINE_PATH, "utf8")) as RawCopyBaseline;
  if (!Array.isArray(parsed.entries)) {
    throw new Error("raw-copy baseline is missing entries");
  }
  return parsed;
}

async function loadLocaleMeta(locale: string): Promise<LocaleMeta> {
  const metaPath = path.join(I18N_ASSETS_DIR, `${locale}.meta.json`);
  if (!existsSync(metaPath)) {
    throw new Error(`unknown locale metadata: ${locale}`);
  }
  return JSON.parse(await readFile(metaPath, "utf8")) as LocaleMeta;
}

async function buildReport(args: ReportArgs) {
  const baseline = await loadRawCopyBaseline();
  const entries = filterRawCopyEntries(baseline.entries, args.surface);
  const input: ReportInput = {
    rawCopy: summarizeRawCopy(entries, args.top),
    surface: args.surface,
  };

  if (args.locale) {
    const meta = await loadLocaleMeta(args.locale);
    input.locale = {
      fallbackKeysInScope: filterTranslationKeysBySurface(meta.fallbackKeys, args.surface),
      meta,
    };
  }

  return formatReport(input);
}

function usage() {
  return [
    "usage: node --import tsx scripts/control-ui-i18n-report.ts [--surface <name>] [--locale <locale>] [--top <n>]",
    "example: pnpm ui:i18n:report --surface chat --locale zh-CN --top 20",
  ].join("\n");
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  try {
    process.stdout.write(await buildReport(parseArgs(cliArgs)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
