// Control Ui I18N script supports OpenClaw repository automation.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { completeSimple, type AssistantMessage, type Model } from "openclaw/plugin-sdk/llm";
import * as ts from "typescript";
import { formatErrorMessage } from "../src/infra/errors.ts";

interface TranslationMap {
  [key: string]: string | TranslationMap;
}

type TranslationValue = string | { [key: string]: TranslationValue };

type LocaleEntry = {
  exportName: string;
  fileName: string;
  languageKey: string;
  locale: string;
};

type GlossaryEntry = {
  source: string;
  target: string;
};

type TranslationMemoryEntry = {
  cache_key: string;
  model: string;
  provider: string;
  segment_id: string;
  source_path: string;
  src_lang: string;
  text: string;
  text_hash: string;
  tgt_lang: string;
  translated: string;
  updated_at: string;
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

type TranslationBatchItem = {
  cacheKey: string;
  key: string;
  text: string;
  textHash: string;
};

type RawCopyFinding = {
  kind: "html-attribute" | "html-text" | "object-property";
  line: number;
  name: string;
  path: string;
  text: string;
};

type RawCopyBaselineEntry = {
  count: number;
  kind: RawCopyFinding["kind"];
  name: string;
  path: string;
  text: string;
};

type RawCopyBaseline = {
  version: number;
  entries: RawCopyBaselineEntry[];
};

const CONTROL_UI_I18N_WORKFLOW = 1;
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-6";
const DEFAULT_PROVIDER = "openai";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOCALES_DIR = path.join(ROOT, "ui", "src", "i18n", "locales");
const I18N_ASSETS_DIR = path.join(ROOT, "ui", "src", "i18n", ".i18n");
const SOURCE_LOCALE_PATH = path.join(LOCALES_DIR, "en.ts");
const SOURCE_LOCALE = "en";
const CONTROL_UI_SOURCE_DIR = path.join(ROOT, "ui", "src", "ui");
const RAW_COPY_BASELINE_PATH = path.join(I18N_ASSETS_DIR, "raw-copy-baseline.json");
const RAW_COPY_BASELINE_VERSION = 1;
const MAX_BATCH_ITEMS = 20;
const DEFAULT_BATCH_CHAR_BUDGET = 2_000;
const TRANSLATE_MAX_ATTEMPTS = 2;
const TRANSLATE_BASE_DELAY_MS = 15_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const RUN_PROCESS_OUTPUT_MAX_CHARS = 1024 * 1024;
const RUN_PROCESS_TIMEOUT_MS = 120_000;
const RUN_PROCESS_KILL_GRACE_MS = 5_000;
const PROGRESS_HEARTBEAT_MS = 30_000;
const ENV_PROVIDER = "OPENCLAW_CONTROL_UI_I18N_PROVIDER";
const ENV_MODEL = "OPENCLAW_CONTROL_UI_I18N_MODEL";
const ENV_THINKING = "OPENCLAW_CONTROL_UI_I18N_THINKING";
const ENV_BATCH_CHAR_BUDGET = "OPENCLAW_CONTROL_UI_I18N_BATCH_CHAR_BUDGET";
const ENV_PROMPT_TIMEOUT = "OPENCLAW_CONTROL_UI_I18N_PROMPT_TIMEOUT";
const ENV_AUTH_OPTIONAL = "OPENCLAW_CONTROL_UI_I18N_AUTH_OPTIONAL";

type TranslationProvider = "openai" | "anthropic";

const TRANSLATION_PROVIDER_DEFAULTS: Record<TranslationProvider, Omit<Model, "id" | "name">> = {
  openai: {
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 32_000,
  },
  anthropic: {
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
};

const LOCALE_ENTRIES: readonly LocaleEntry[] = [
  { locale: "zh-CN", fileName: "zh-CN.ts", exportName: "zh_CN", languageKey: "zhCN" },
  { locale: "zh-TW", fileName: "zh-TW.ts", exportName: "zh_TW", languageKey: "zhTW" },
  { locale: "pt-BR", fileName: "pt-BR.ts", exportName: "pt_BR", languageKey: "ptBR" },
  { locale: "de", fileName: "de.ts", exportName: "de", languageKey: "de" },
  { locale: "es", fileName: "es.ts", exportName: "es", languageKey: "es" },
  { locale: "ja-JP", fileName: "ja-JP.ts", exportName: "ja_JP", languageKey: "jaJP" },
  { locale: "ko", fileName: "ko.ts", exportName: "ko", languageKey: "ko" },
  { locale: "fr", fileName: "fr.ts", exportName: "fr", languageKey: "fr" },
  { locale: "ar", fileName: "ar.ts", exportName: "ar", languageKey: "ar" },
  { locale: "it", fileName: "it.ts", exportName: "it", languageKey: "it" },
  { locale: "tr", fileName: "tr.ts", exportName: "tr", languageKey: "tr" },
  { locale: "uk", fileName: "uk.ts", exportName: "uk", languageKey: "uk" },
  { locale: "id", fileName: "id.ts", exportName: "id", languageKey: "id" },
  { locale: "pl", fileName: "pl.ts", exportName: "pl", languageKey: "pl" },
  { locale: "th", fileName: "th.ts", exportName: "th", languageKey: "th" },
  { locale: "vi", fileName: "vi.ts", exportName: "vi", languageKey: "vi" },
  { locale: "nl", fileName: "nl.ts", exportName: "nl", languageKey: "nl" },
  { locale: "fa", fileName: "fa.ts", exportName: "fa", languageKey: "fa" },
];

const DEFAULT_GLOSSARY: readonly GlossaryEntry[] = [
  { source: "OpenClaw", target: "OpenClaw" },
  { source: "Gateway", target: "Gateway" },
  { source: "Control UI", target: "Control UI" },
  { source: "Skills", target: "Skills" },
  { source: "Tailscale", target: "Tailscale" },
  { source: "WhatsApp", target: "WhatsApp" },
  { source: "Telegram", target: "Telegram" },
  { source: "Discord", target: "Discord" },
  { source: "Signal", target: "Signal" },
  { source: "iMessage", target: "iMessage" },
];

function usage(): never {
  console.error(
    [
      "Usage:",
      "  node --import tsx scripts/control-ui-i18n.ts check",
      "  node --import tsx scripts/control-ui-i18n.ts sync [--write] [--locale <code>] [--force]",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "sync") {
    usage();
  }

  let localeFilter: string | null = null;
  let write = false;
  let force = false;

  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    switch (part) {
      case "--locale":
        localeFilter = rest[index + 1] ?? null;
        index += 1;
        break;
      case "--write":
        write = true;
        break;
      case "--force":
        force = true;
        break;
      default:
        usage();
    }
  }

  if (command === "check" && write) {
    usage();
  }

  return {
    command,
    force,
    localeFilter,
    write,
  };
}

function prettyLanguageLabel(locale: string): string {
  switch (locale) {
    case "en":
      return "English";
    case "zh-CN":
      return "Simplified Chinese";
    case "zh-TW":
      return "Traditional Chinese";
    case "pt-BR":
      return "Brazilian Portuguese";
    case "ja-JP":
      return "Japanese";
    case "ko":
      return "Korean";
    case "fr":
      return "French";
    case "ar":
      return "Arabic";
    case "it":
      return "Italian";
    case "tr":
      return "Turkish";
    case "uk":
      return "Ukrainian";
    case "id":
      return "Indonesian";
    case "pl":
      return "Polish";
    case "th":
      return "Thai";
    case "vi":
      return "Vietnamese";
    case "nl":
      return "Dutch";
    case "fa":
      return "Persian";
    case "de":
      return "German";
    case "es":
      return "Spanish";
    default:
      return locale;
  }
}

function resolveConfiguredProvider(): string {
  const configured = process.env[ENV_PROVIDER]?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return "openai";
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return "anthropic";
  }
  return DEFAULT_PROVIDER;
}

function resolveConfiguredModel(): string {
  const configured = process.env[ENV_MODEL]?.trim();
  if (configured) {
    return configured;
  }
  return resolveConfiguredProvider() === "anthropic"
    ? DEFAULT_ANTHROPIC_MODEL
    : DEFAULT_OPENAI_MODEL;
}

function hasTranslationProvider(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim());
}

function resolveKnownTranslationProvider(): TranslationProvider {
  const provider = resolveConfiguredProvider();
  if (provider === "openai" || provider === "anthropic") {
    return provider;
  }
  throw new Error(`Unsupported translation provider: ${provider}`);
}

function normalizeText(text: string): string {
  return text.trim().split(/\s+/).join(" ");
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashText(text: string): string {
  return sha256(normalizeText(text));
}

function cacheNamespace(): string {
  return [
    `wf=${CONTROL_UI_I18N_WORKFLOW}`,
    "engine=openclaw-llm",
    `provider=${resolveConfiguredProvider()}`,
    `model=${resolveConfiguredModel()}`,
  ].join("|");
}

function cacheKey(segmentId: string, textHash: string, targetLocale: string): string {
  return sha256([cacheNamespace(), SOURCE_LOCALE, targetLocale, segmentId, textHash].join("|"));
}

function localeFilePath(entry: LocaleEntry): string {
  return path.join(LOCALES_DIR, entry.fileName);
}

function glossaryPath(entry: LocaleEntry): string {
  return path.join(I18N_ASSETS_DIR, `glossary.${entry.locale}.json`);
}

function metaPath(entry: LocaleEntry): string {
  return path.join(I18N_ASSETS_DIR, `${entry.locale}.meta.json`);
}

function tmPath(entry: LocaleEntry): string {
  return path.join(I18N_ASSETS_DIR, `${entry.locale}.tm.jsonl`);
}

async function importLocaleModule<T>(filePath: string): Promise<T> {
  const stats = await stat(filePath);
  const href = `${pathToFileURL(filePath).href}?ts=${stats.mtimeMs}`;
  return (await import(href)) as T;
}

async function loadLocaleMap(filePath: string, exportName: string): Promise<TranslationMap | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  const mod = await importLocaleModule<Record<string, TranslationMap>>(filePath);
  return mod[exportName] ?? null;
}

function flattenTranslations(value: TranslationMap, prefix = "", out = new Map<string, string>()) {
  for (const [key, nested] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === "string") {
      out.set(fullKey, nested);
      continue;
    }
    flattenTranslations(nested, fullKey, out);
  }
  return out;
}

function setNestedValue(root: TranslationMap, dottedKey: string, value: string) {
  const parts = dottedKey.split(".");
  let cursor: TranslationMap = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const next = cursor[key];
    if (!next || typeof next === "string") {
      const replacement: TranslationMap = {};
      cursor[key] = replacement;
      cursor = replacement;
      continue;
    }
    cursor = next;
  }
  cursor[parts.at(-1)!] = value;
}

function compareStringArrays(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export type PlaceholderMismatch = {
  key: string;
  locale: string;
  sourcePlaceholders: string[];
  translatedPlaceholders: string[];
};

function extractTranslationPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ""))]
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

export function findPlaceholderMismatches(
  sourceFlat: ReadonlyMap<string, string>,
  translatedFlat: ReadonlyMap<string, string>,
  locale: string,
): PlaceholderMismatch[] {
  const mismatches: PlaceholderMismatch[] = [];
  for (const [key, sourceText] of sourceFlat.entries()) {
    const sourcePlaceholders = extractTranslationPlaceholders(sourceText);
    const translatedPlaceholders = extractTranslationPlaceholders(translatedFlat.get(key) ?? "");
    if (!compareStringArrays(sourcePlaceholders, translatedPlaceholders)) {
      mismatches.push({
        key,
        locale,
        sourcePlaceholders,
        translatedPlaceholders,
      });
    }
  }
  return mismatches;
}

function assertPlaceholderParity(
  sourceFlat: ReadonlyMap<string, string>,
  translatedFlat: ReadonlyMap<string, string>,
  locale: string,
) {
  const mismatches = findPlaceholderMismatches(sourceFlat, translatedFlat, locale);
  if (mismatches.length === 0) {
    return;
  }

  const details = mismatches
    .slice(0, 20)
    .map(
      (mismatch) =>
        `${mismatch.locale}:${mismatch.key} expected {${mismatch.sourcePlaceholders.join("},{")}} got {${mismatch.translatedPlaceholders.join("},{")}}`,
    )
    .join("\n");
  throw new Error(
    [
      `control-ui-i18n placeholder mismatch detected for ${locale}.`,
      details,
      mismatches.length > 20 ? `...and ${mismatches.length - 20} more` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function renderTranslationValue(value: TranslationValue, indent = 0): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }

  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);
  return `{\n${entries
    .map(([key, nested]) => {
      const renderedKey = isIdentifier(key) ? key : JSON.stringify(key);
      return `${innerPad}${renderedKey}: ${renderTranslationValue(nested, indent + 1)},`;
    })
    .join("\n")}\n${pad}}`;
}

function renderLocaleModule(entry: LocaleEntry, value: TranslationMap): string {
  return [
    "// Generated locale bundle for Control UI translations.",
    "// Run `pnpm ui:i18n:sync` instead of editing this file directly.",
    'import type { TranslationMap } from "../lib/types.ts";',
    "",
    `export const ${entry.exportName}: TranslationMap = ${renderTranslationValue(value)};`,
    "",
  ].join("\n");
}

async function loadGlossary(filePath: string): Promise<GlossaryEntry[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as GlossaryEntry[];
  return Array.isArray(parsed) ? parsed : [];
}

function renderGlossary(entries: readonly GlossaryEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

async function loadMeta(filePath: string): Promise<LocaleMeta | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as LocaleMeta;
}

function renderMeta(meta: LocaleMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

async function loadTranslationMemory(
  filePath: string,
): Promise<Map<string, TranslationMemoryEntry>> {
  const entries = new Map<string, TranslationMemoryEntry>();
  if (!existsSync(filePath)) {
    return entries;
  }
  const raw = await readFile(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as TranslationMemoryEntry;
    if (parsed.cache_key && parsed.translated.trim()) {
      entries.set(parsed.cache_key, parsed);
    }
  }
  return entries;
}

function renderTranslationMemory(entries: Map<string, TranslationMemoryEntry>): string {
  const ordered = [...entries.values()].toSorted((left, right) =>
    left.cache_key.localeCompare(right.cache_key),
  );
  if (ordered.length === 0) {
    return "";
  }
  return `${ordered.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function buildTranslationMemoryByTextHash(
  entries: Map<string, TranslationMemoryEntry>,
  locale: string,
): Map<string, TranslationMemoryEntry> {
  const byTextHash = new Map<string, TranslationMemoryEntry>();
  for (const entry of entries.values()) {
    if (entry.tgt_lang !== locale || !entry.text_hash || !entry.translated.trim()) {
      continue;
    }
    byTextHash.set(entry.text_hash, entry);
  }
  return byTextHash;
}

function buildGlossaryPrompt(glossary: readonly GlossaryEntry[]): string {
  if (glossary.length === 0) {
    return "";
  }
  return [
    "Required terminology (use exactly when the source term matches):",
    ...glossary
      .filter((entry) => entry.source.trim() && entry.target.trim())
      .map((entry) => `- ${entry.source} -> ${entry.target}`),
  ].join("\n");
}

function buildSystemPrompt(targetLocale: string, glossary: readonly GlossaryEntry[]): string {
  const glossaryBlock = buildGlossaryPrompt(glossary);
  const lines = [
    "You are a translation function, not a chat assistant.",
    `Translate UI strings from ${prettyLanguageLabel(SOURCE_LOCALE)} to ${prettyLanguageLabel(targetLocale)}.`,
    "",
    "Rules:",
    "- Output ONLY valid JSON.",
    "- The JSON must be an object whose keys exactly match the provided ids.",
    "- Translate all English prose; keep code, URLs, product names, CLI commands, config keys, and env vars in English.",
    "- Preserve placeholders exactly, including {count}, {time}, {shown}, {total}, and similar tokens.",
    "- Preserve punctuation, ellipses, arrows, and casing when they are part of literal UI text.",
    "- Preserve Markdown, inline code, HTML tags, and slash commands when present.",
    "- Use fluent, neutral product UI language.",
    "- Do not add explanations, comments, or extra keys.",
    "- Never return an empty string for a key; if unsure, return the source text unchanged.",
  ];
  if (glossaryBlock) {
    lines.push("", glossaryBlock);
  }
  return lines.join("\n");
}

function buildBatchPrompt(items: readonly TranslationBatchItem[]): string {
  const payload = Object.fromEntries(items.map((item) => [item.key, item.text]));
  return [
    "Translate this JSON object.",
    "Return ONLY a JSON object with the same keys.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function logProgress(message: string) {
  process.stdout.write(`control-ui-i18n: ${message}\n`);
}

function toRepoPath(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function normalizeRawCopyText(raw: string): string {
  return raw
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&middot;/giu, "·")
    .trim();
}

function hasHumanLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

function lineNumberForOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function parseDoubleQuotedString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function pushRawCopyFinding(
  findings: RawCopyFinding[],
  params: Omit<RawCopyFinding, "text"> & { text: string },
) {
  const text = normalizeRawCopyText(params.text);
  if (!text || !hasHumanLetters(text)) {
    return;
  }
  findings.push({
    ...params,
    text,
  });
}

async function walkControlUiSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "test-helpers") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkControlUiSourceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) {
      continue;
    }
    if (/\.(?:test|browser\.test|node\.test)\.tsx?$/u.test(entry.name)) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function collectRawCopyFromSource(params: {
  filePath: string;
  source: string;
  sourceFile: ts.SourceFile;
}): RawCopyFinding[] {
  const { filePath, source, sourceFile } = params;
  const repoPath = toRepoPath(filePath);
  const findings: RawCopyFinding[] = [];
  const attrPattern =
    /\b(aria-label|placeholder|title)\s*=\s*"((?:(?!\$\{)[^"\\]|\\.)*?\p{L}(?:(?!\$\{)[^"\\]|\\.)*?)"/gu;
  for (const match of source.matchAll(attrPattern)) {
    const rawText = match[2];
    if (!rawText) {
      continue;
    }
    pushRawCopyFinding(findings, {
      kind: "html-attribute",
      line: lineNumberForOffset(source, match.index ?? 0),
      name: match[1] ?? "attribute",
      path: repoPath,
      text: parseDoubleQuotedString(rawText),
    });
  }

  const propertyPattern =
    /\b(label|title|subtitle|description|help|placeholder)\s*:\s*"((?:[^"\\]|\\.)*?\p{L}(?:[^"\\]|\\.)*?)"/gu;
  for (const match of source.matchAll(propertyPattern)) {
    const rawText = match[2];
    if (!rawText) {
      continue;
    }
    pushRawCopyFinding(findings, {
      kind: "object-property",
      line: lineNumberForOffset(source, match.index ?? 0),
      name: match[1] ?? "property",
      path: repoPath,
      text: parseDoubleQuotedString(rawText),
    });
  }

  const textPattern = />\s*([^<>{}]*?\p{L}[^<>{}]*?)\s*</gu;
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sourceFile) === "html") {
      const template = node.template;
      const chunks: Array<{ offset: number; text: string }> = [];
      if (ts.isNoSubstitutionTemplateLiteral(template)) {
        chunks.push({
          offset: template.getStart(sourceFile) + 1,
          text: template.text,
        });
      } else {
        chunks.push({
          offset: template.head.getStart(sourceFile) + 1,
          text: template.head.text,
        });
        for (const span of template.templateSpans) {
          chunks.push({
            offset: span.literal.getStart(sourceFile) + 1,
            text: span.literal.text,
          });
        }
      }
      for (const chunk of chunks) {
        for (const match of chunk.text.matchAll(textPattern)) {
          const rawText = match[1];
          if (!rawText) {
            continue;
          }
          pushRawCopyFinding(findings, {
            kind: "html-text",
            line: lineNumberForOffset(source, chunk.offset + (match.index ?? 0)),
            name: "text",
            path: repoPath,
            text: rawText,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return findings;
}

async function collectControlUiRawCopyFindings(): Promise<RawCopyFinding[]> {
  const files = await walkControlUiSourceFiles(CONTROL_UI_SOURCE_DIR);
  const findings: RawCopyFinding[] = [];
  for (const filePath of files.toSorted((left, right) => left.localeCompare(right))) {
    const source = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    findings.push(...collectRawCopyFromSource({ filePath, source, sourceFile }));
  }
  return findings;
}

function summarizeRawCopyFindings(findings: RawCopyFinding[]): RawCopyBaselineEntry[] {
  const counts = new Map<string, RawCopyBaselineEntry>();
  for (const finding of findings) {
    const key = [finding.path, finding.kind, finding.name, finding.text].join("\u0000");
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    counts.set(key, {
      count: 1,
      kind: finding.kind,
      name: finding.name,
      path: finding.path,
      text: finding.text,
    });
  }
  return [...counts.values()].toSorted(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name) ||
      left.text.localeCompare(right.text),
  );
}

function formatRawCopyBaseline(entries: RawCopyBaselineEntry[]): string {
  return `${JSON.stringify(
    {
      version: RAW_COPY_BASELINE_VERSION,
      entries,
    } satisfies RawCopyBaseline,
    null,
    2,
  )}\n`;
}

function formatRawCopyBaselineDiff(
  current: RawCopyBaselineEntry[],
  expected: RawCopyBaselineEntry[],
) {
  const keyFor = (entry: RawCopyBaselineEntry) =>
    [entry.path, entry.kind, entry.name, entry.text].join("\u0000");
  const currentByKey = new Map(current.map((entry) => [keyFor(entry), entry]));
  const expectedByKey = new Map(expected.map((entry) => [keyFor(entry), entry]));
  const added = current.filter((entry) => {
    const expectedEntry = expectedByKey.get(keyFor(entry));
    return !expectedEntry || expectedEntry.count !== entry.count;
  });
  const removed = expected.filter((entry) => {
    const currentEntry = currentByKey.get(keyFor(entry));
    return !currentEntry || currentEntry.count !== entry.count;
  });
  const lines: string[] = [];
  for (const entry of added.slice(0, 20)) {
    lines.push(
      `+ ${entry.path} ${entry.kind}:${entry.name} x${entry.count} ${JSON.stringify(entry.text)}`,
    );
  }
  for (const entry of removed.slice(0, 20)) {
    lines.push(
      `- ${entry.path} ${entry.kind}:${entry.name} x${entry.count} ${JSON.stringify(entry.text)}`,
    );
  }
  const extra = added.length + removed.length - lines.length;
  if (extra > 0) {
    lines.push(`... ${extra} more baseline delta(s)`);
  }
  return lines.join("\n");
}

async function syncControlUiRawCopyBaseline(options: { checkOnly: boolean; write: boolean }) {
  const findings = await collectControlUiRawCopyFindings();
  const entries = summarizeRawCopyFindings(findings);
  const expected = formatRawCopyBaseline(entries);
  const current = existsSync(RAW_COPY_BASELINE_PATH)
    ? await readFile(RAW_COPY_BASELINE_PATH, "utf8")
    : "";
  if (!options.checkOnly && options.write && current !== expected) {
    await mkdir(I18N_ASSETS_DIR, { recursive: true });
    await writeFile(RAW_COPY_BASELINE_PATH, expected, "utf8");
  }
  if (options.checkOnly && current !== expected) {
    let currentEntries: RawCopyBaselineEntry[];
    try {
      const parsed = JSON.parse(current) as Partial<RawCopyBaseline>;
      currentEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      currentEntries = [];
    }
    const diff = formatRawCopyBaselineDiff(entries, currentEntries);
    throw new Error(
      [
        "control-ui raw-copy baseline drift detected.",
        diff,
        "Move user-facing strings into ui/src/i18n/locales/en.ts, or update the baseline with `node --import tsx scripts/control-ui-i18n.ts sync --write` when the raw string is intentional.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  logProgress(`raw-copy: baseline entries=${entries.length}`);
}

function isPromptTimeoutError(error: Error): boolean {
  return error.message.toLowerCase().includes("timed out");
}

export function isProviderAuthError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("401") ||
    message.includes("authentication_error") ||
    message.includes("incorrect api key") ||
    message.includes("invalid x-api-key")
  );
}

function isProviderAuthOptional(): boolean {
  const raw = process.env[ENV_AUTH_OPTIONAL]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolvePromptTimeoutMs(): number {
  const raw = process.env[ENV_PROMPT_TIMEOUT]?.trim();
  if (!raw) {
    return DEFAULT_PROMPT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROMPT_TIMEOUT_MS;
}

function resolveThinkingLevel(): "low" | "high" {
  return process.env[ENV_THINKING]?.trim().toLowerCase() === "high" ? "high" : "low";
}

function resolveBatchCharBudget(): number {
  const raw = process.env[ENV_BATCH_CHAR_BUDGET]?.trim();
  if (!raw) {
    return DEFAULT_BATCH_CHAR_BUDGET;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_CHAR_BUDGET;
}

function estimateBatchChars(items: readonly TranslationBatchItem[]): number {
  return items.reduce((total, item) => total + item.key.length + item.text.length + 8, 2);
}

type RunProcessOptions = {
  cwd?: string;
  input?: string;
  killGraceMs?: number;
  maxOutputChars?: number;
  rejectOnFailure?: boolean;
  timeoutMs?: number;
};

type ProcessOutputCapture = {
  text: string;
  truncatedChars: number;
};

function resolveRunProcessOutputLimit(options: RunProcessOptions): number {
  const value = options.maxOutputChars;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return RUN_PROCESS_OUTPUT_MAX_CHARS;
  }
  return Math.max(1, Math.floor(value));
}

export function appendBoundedProcessOutput(
  capture: ProcessOutputCapture,
  chunk: unknown,
  maxChars: number,
): ProcessOutputCapture {
  const nextText = capture.text + String(chunk);
  if (nextText.length <= maxChars) {
    return { text: nextText, truncatedChars: capture.truncatedChars };
  }
  const truncatedChars = capture.truncatedChars + nextText.length - maxChars;
  return { text: nextText.slice(-maxChars), truncatedChars };
}

function formatProcessOutput(capture: ProcessOutputCapture): string {
  if (capture.truncatedChars === 0) {
    return capture.text;
  }
  return `[output truncated ${capture.truncatedChars} chars; showing tail]\n${capture.text}`;
}

export async function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd: options.cwd ?? ROOT,
      detached: useProcessGroup,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const maxOutputChars = resolveRunProcessOutputLimit(options);
    const timeoutMs = options.timeoutMs ?? RUN_PROCESS_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? RUN_PROCESS_KILL_GRACE_MS;
    let stdout: ProcessOutputCapture = { text: "", truncatedChars: 0 };
    let stderr: ProcessOutputCapture = { text: "", truncatedChars: 0 };
    let timedOut = false;
    let settled = false;
    let waitingForKillGrace = false;
    let childClosedResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const parentSignalHandlers: { handler: () => void; signal: NodeJS.Signals }[] = [];
    const cleanupParentSignalHandlers = () => {
      for (const { signal, handler } of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.length = 0;
    };
    const signalWindowsProcessTree = (force: boolean): boolean => {
      if (process.platform !== "win32" || typeof child.pid !== "number") {
        return false;
      }
      const taskkillArgs = ["/PID", String(child.pid), "/T"];
      if (force) {
        taskkillArgs.push("/F");
      }
      const result = spawnSync("taskkill.exe", taskkillArgs, { stdio: "ignore" });
      return result.status === 0;
    };
    const signalChild = (signal: NodeJS.Signals) => {
      if (useProcessGroup && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            stderr = appendBoundedProcessOutput(
              stderr,
              `failed to send ${signal} to process group: ${error instanceof Error ? error.message : String(error)}\n`,
              maxOutputChars,
            );
          }
        }
      }
      if (process.platform === "win32") {
        const force = signal === "SIGKILL";
        if (signalWindowsProcessTree(force) || (!force && signalWindowsProcessTree(true))) {
          return;
        }
      }
      child.kill(signal);
    };
    const relayParentSignal = (signal: NodeJS.Signals) => {
      const handler = () => {
        signalChild(signal);
        cleanupParentSignalHandlers();
        process.kill(process.pid, signal);
      };
      parentSignalHandlers.push({ handler, signal });
      process.once(signal, handler);
    };
    const relayedSignals: NodeJS.Signals[] =
      process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of relayedSignals) {
      relayParentSignal(signal);
    }
    const processGroupIsAlive = () => {
      if (!useProcessGroup || typeof child.pid !== "number") {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      cleanupParentSignalHandlers();
      callback();
    };
    const finishClose = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => {
        const stdoutText = formatProcessOutput(stdout);
        const stderrText = formatProcessOutput(stderr);
        if (timedOut) {
          reject(new Error(`${executable} ${args.join(" ")} timed out after ${timeoutMs}ms`));
          return;
        }
        if ((code ?? 1) !== 0 && options.rejectOnFailure) {
          reject(
            new Error(
              `${executable} ${args.join(" ")} failed: ${
                stderrText.trim() || stdoutText.trim() || (signal ? `terminated by ${signal}` : "")
              }`,
            ),
          );
          return;
        }
        if ((code ?? 1) === 0 && stdout.truncatedChars > 0) {
          reject(
            new Error(
              `${executable} ${args.join(" ")} produced more than ${maxOutputChars} stdout chars`,
            ),
          );
          return;
        }
        resolve({ code: code ?? 1, stderr: stderrText, stdout: stdout.text });
      });
    };
    const scheduleKill = () => {
      if (waitingForKillGrace) {
        return;
      }
      waitingForKillGrace = true;
      killTimer = setTimeout(() => {
        waitingForKillGrace = false;
        killTimer = undefined;
        signalChild("SIGKILL");
        if (childClosedResult) {
          finishClose(childClosedResult.code, childClosedResult.signal);
        }
      }, killGraceMs);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signalChild("SIGTERM");
      scheduleKill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedProcessOutput(stdout, chunk, maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBoundedProcessOutput(stderr, chunk, maxOutputChars);
    });
    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    child.once("close", (code, signal) => {
      if (waitingForKillGrace && processGroupIsAlive()) {
        childClosedResult = { code, signal };
        return;
      }
      finishClose(code, signal);
    });
  });
}

async function formatGeneratedTypeScript(filePath: string, source: string): Promise<string> {
  const result = await runProcess(
    "pnpm",
    ["exec", "oxfmt", "--stdin-filepath", path.relative(ROOT, filePath)],
    {
      input: source,
      rejectOnFailure: true,
    },
  );
  return restoreReplacementCorruptedStringLiterals(source, result.stdout);
}

function restoreReplacementCorruptedStringLiterals(source: string, formatted: string): string {
  if (!formatted.includes("\uFFFD") || source.includes("\uFFFD")) {
    return formatted;
  }

  const stringLiteralPattern = /"(?:\\.|[^"\\])*"/gu;
  const sourceLiterals = [...source.matchAll(stringLiteralPattern)];
  const formattedLiterals = [...formatted.matchAll(stringLiteralPattern)];
  if (sourceLiterals.length !== formattedLiterals.length) {
    return formatted;
  }

  let output = "";
  let cursor = 0;
  for (const [index, formattedLiteral] of formattedLiterals.entries()) {
    const replacement = sourceLiterals[index]?.[0];
    const literal = formattedLiteral[0];
    const start = formattedLiteral.index;
    if (replacement === undefined || start === undefined) {
      return formatted;
    }
    output += formatted.slice(cursor, start);
    output += literal.includes("\uFFFD") && !replacement.includes("\uFFFD") ? replacement : literal;
    cursor = start + literal.length;
  }
  return `${output}${formatted.slice(cursor)}`;
}

type LocaleRunContext = {
  localeCount: number;
  localeIndex: number;
};

type TranslationBatchContext = LocaleRunContext & {
  batchCount: number;
  batchIndex: number;
  locale: string;
  splitDepth?: number;
  segmentLabel?: string;
};

type ClientAccess = {
  getClient: () => Promise<TranslationClient>;
  resetClient: () => Promise<void>;
};

function formatLocaleLabel(locale: string, context: LocaleRunContext): string {
  return `[${context.localeIndex}/${context.localeCount}] ${locale}`;
}

function formatBatchLabel(context: TranslationBatchContext): string {
  const suffix = context.segmentLabel ? `.${context.segmentLabel}` : "";
  return `${formatLocaleLabel(context.locale, context)} batch ${context.batchIndex}/${context.batchCount}${suffix}`;
}

function buildTranslationBatches(items: readonly TranslationBatchItem[]): TranslationBatchItem[][] {
  const batches: TranslationBatchItem[][] = [];
  const budget = resolveBatchCharBudget();
  let current: TranslationBatchItem[] = [];
  let currentChars = 2;

  for (const item of items) {
    const itemChars = estimateBatchChars([item]);
    const wouldOverflow = current.length > 0 && currentChars + itemChars > budget;
    const reachedMaxItems = current.length >= MAX_BATCH_ITEMS;
    if (wouldOverflow || reachedMaxItems) {
      batches.push(current);
      current = [];
      currentChars = 2;
    }
    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

export function resolveTranslationModel(): Model {
  const provider = resolveKnownTranslationProvider();
  const modelId = resolveConfiguredModel();
  return {
    ...TRANSLATION_PROVIDER_DEFAULTS[provider],
    id: modelId,
    name: modelId,
  };
}

class TranslationClient {
  private closed = false;
  private sequence: Promise<unknown> = Promise.resolve();
  private readonly model: Model;

  private constructor(private readonly systemPrompt: string) {
    this.model = resolveTranslationModel();
  }

  static async create(systemPrompt: string): Promise<TranslationClient> {
    return new TranslationClient(systemPrompt);
  }

  async prompt(message: string, label: string): Promise<string> {
    const result = this.sequence.then(async () => {
      if (this.closed) {
        throw new Error("translation runtime unavailable");
      }

      const timeoutMs = resolvePromptTimeoutMs();
      const startedAt = Date.now();
      const controller = new AbortController();

      return await new Promise<string>((resolve, reject) => {
        const heartbeat = setInterval(() => {
          logProgress(
            `${label}: still waiting (${formatDuration(Date.now() - startedAt)} / ${formatDuration(timeoutMs)})`,
          );
        }, PROGRESS_HEARTBEAT_MS);
        const timer = setTimeout(() => {
          clearInterval(heartbeat);
          controller.abort();
          reject(new Error(`${label}: translation prompt timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        completeSimple(
          this.model,
          {
            systemPrompt: this.systemPrompt,
            messages: [{ role: "user", content: message, timestamp: Date.now() }],
          },
          {
            maxTokens: 4096,
            reasoning: resolveThinkingLevel(),
            signal: controller.signal,
            timeoutMs,
          },
        )
          .then((assistantMessage) => {
            clearTimeout(timer);
            clearInterval(heartbeat);
            resolve(extractTranslationResult(assistantMessage));
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            clearInterval(heartbeat);
            reject(toLintErrorObject(error, "Non-Error rejection"));
          });
      });
    });

    this.sequence = result.catch(() => undefined);
    return await result;
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
  }
}

function extractTranslationResult(message: AssistantMessage): string {
  if (message.errorMessage || message.stopReason === "error") {
    throw new Error(message.errorMessage?.trim() || "translation provider error");
  }
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!text) {
    throw new Error("assistant translation not found");
  }
  return text;
}

async function translateBatch(
  clientAccess: ClientAccess,
  items: readonly TranslationBatchItem[],
  context: TranslationBatchContext,
): Promise<Map<string, string>> {
  const batchLabel = formatBatchLabel(context);
  const splitDepth = context.splitDepth ?? 0;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < TRANSLATE_MAX_ATTEMPTS; attempt += 1) {
    const attemptNumber = attempt + 1;
    const attemptLabel = `${batchLabel} attempt ${attemptNumber}/${TRANSLATE_MAX_ATTEMPTS}`;
    const startedAt = Date.now();
    logProgress(`${attemptLabel}: start keys=${items.length}`);
    try {
      const raw = await (
        await clientAccess.getClient()
      ).prompt(buildBatchPrompt(items), attemptLabel);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const translated = new Map<string, string>();
      for (const item of items) {
        const value = parsed[item.key];
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`missing translation for ${item.key}`);
        }
        translated.set(item.key, value);
      }
      logProgress(`${attemptLabel}: done (${formatDuration(Date.now() - startedAt)})`);
      return translated;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await clientAccess.resetClient();
      logProgress(
        `${attemptLabel}: failed after ${formatDuration(Date.now() - startedAt)}: ${lastError.message}`,
      );
      if (isPromptTimeoutError(lastError) && items.length > 1) {
        const midpoint = Math.ceil(items.length / 2);
        logProgress(
          `${batchLabel}: splitting timed out batch into ${midpoint} + ${items.length - midpoint} keys`,
        );
        const left = await translateBatch(clientAccess, items.slice(0, midpoint), {
          ...context,
          splitDepth: splitDepth + 1,
          segmentLabel: `${context.segmentLabel ?? ""}a`,
        });
        const right = await translateBatch(clientAccess, items.slice(midpoint), {
          ...context,
          splitDepth: splitDepth + 1,
          segmentLabel: `${context.segmentLabel ?? ""}b`,
        });
        return new Map([...left, ...right]);
      }
      if (isPromptTimeoutError(lastError)) {
        break;
      }
      if (attempt + 1 < TRANSLATE_MAX_ATTEMPTS) {
        const delayMs = TRANSLATE_BASE_DELAY_MS * attemptNumber;
        logProgress(`${attemptLabel}: retrying in ${formatDuration(delayMs)}`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError ?? new Error("translation failed");
}

type SyncOutcome = {
  changed: boolean;
  fallbackCount: number;
  locale: string;
  wrote: boolean;
};

async function syncLocale(
  entry: LocaleEntry,
  options: { checkOnly: boolean; force: boolean; write: boolean },
  context: LocaleRunContext,
) {
  const localeLabel = formatLocaleLabel(entry.locale, context);
  const localeStartedAt = Date.now();
  const sourceRaw = await readFile(SOURCE_LOCALE_PATH, "utf8");
  const sourceHash = sha256(sourceRaw);
  const sourceMap = (await loadLocaleMap(SOURCE_LOCALE_PATH, "en")) ?? {};
  const sourceFlat = flattenTranslations(sourceMap);
  const existingPath = localeFilePath(entry);
  const existingMap = (await loadLocaleMap(existingPath, entry.exportName)) ?? {};
  const existingFlat = flattenTranslations(existingMap);
  const previousMeta = await loadMeta(metaPath(entry));
  const previousFallbackKeys = new Set(previousMeta?.fallbackKeys ?? []);
  const glossaryFilePath = glossaryPath(entry);
  const glossary = await loadGlossary(glossaryFilePath);
  const tm = await loadTranslationMemory(tmPath(entry));
  const tmByTextHash = buildTranslationMemoryByTextHash(tm, entry.locale);
  const allowTranslate = hasTranslationProvider();

  const nextFlat = new Map<string, string>();
  const pending: TranslationBatchItem[] = [];
  const fallbackKeys: string[] = [];

  for (const [key, text] of sourceFlat.entries()) {
    const textHash = hashText(text);
    const segmentCacheKey = cacheKey(key, textHash, entry.locale);
    const cached = tm.get(segmentCacheKey);
    const cachedByText = tmByTextHash.get(textHash);
    const existing = existingFlat.get(key);
    const shouldRefreshFallback = previousFallbackKeys.has(key);

    if (cached && !(allowTranslate && shouldRefreshFallback)) {
      nextFlat.set(key, cached.translated);
      if (shouldRefreshFallback) {
        fallbackKeys.push(key);
      }
      continue;
    }

    if (cachedByText && (shouldRefreshFallback || existing === undefined)) {
      nextFlat.set(key, cachedByText.translated);
      tm.set(segmentCacheKey, {
        ...cachedByText,
        cache_key: segmentCacheKey,
        segment_id: key,
        source_path: `ui/src/i18n/locales/${entry.fileName}`,
      });
      continue;
    }

    if (existing !== undefined && !(allowTranslate && shouldRefreshFallback)) {
      nextFlat.set(key, existing);
      if (shouldRefreshFallback) {
        fallbackKeys.push(key);
      }
      continue;
    }

    pending.push({
      cacheKey: segmentCacheKey,
      key,
      text,
      textHash,
    });
  }

  if (allowTranslate && pending.length > 0) {
    const batches = buildTranslationBatches(pending);
    const batchCount = batches.length;
    logProgress(
      `${localeLabel}: start keys=${sourceFlat.size} pending=${pending.length} batches=${batchCount} provider=${resolveConfiguredProvider()} model=${resolveConfiguredModel()} thinking=${resolveThinkingLevel()} timeout=${formatDuration(resolvePromptTimeoutMs())} batch_chars=${resolveBatchCharBudget()}`,
    );
    let client: TranslationClient | null = null;
    const clientAccess: ClientAccess = {
      async getClient() {
        if (!client) {
          client = await TranslationClient.create(buildSystemPrompt(entry.locale, glossary));
        }
        return client;
      },
      async resetClient() {
        if (!client) {
          return;
        }
        await client.close();
        client = null;
      },
    };
    try {
      for (const [batchIndex, batch] of batches.entries()) {
        const translated = await translateBatch(clientAccess, batch, {
          ...context,
          batchCount,
          batchIndex: batchIndex + 1,
          locale: entry.locale,
        });
        for (const item of batch) {
          const value = translated.get(item.key);
          if (!value) {
            continue;
          }
          nextFlat.set(item.key, value);
          tm.set(item.cacheKey, {
            cache_key: item.cacheKey,
            model: resolveConfiguredModel(),
            provider: resolveConfiguredProvider(),
            segment_id: item.key,
            source_path: `ui/src/i18n/locales/${entry.fileName}`,
            src_lang: SOURCE_LOCALE,
            text: item.text,
            text_hash: item.textHash,
            tgt_lang: entry.locale,
            translated: value,
            updated_at: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (isProviderAuthOptional() && isProviderAuthError(failure)) {
        logProgress(`${localeLabel}: translation provider auth failed; skipping refresh`);
        return {
          changed: false,
          fallbackCount: previousMeta?.fallbackKeys.length ?? 0,
          locale: entry.locale,
          wrote: false,
        } satisfies SyncOutcome;
      }
      throw failure;
    } finally {
      await clientAccess.resetClient();
    }
  } else if (allowTranslate) {
    logProgress(
      `${localeLabel}: no translation work needed (all keys reused from cache or existing files)`,
    );
  } else {
    logProgress(`${localeLabel}: no provider configured, using English fallback for pending keys`);
  }

  for (const item of pending) {
    if (nextFlat.has(item.key)) {
      continue;
    }
    const existing = existingFlat.get(item.key);
    if (existing !== undefined && !options.force) {
      nextFlat.set(item.key, existing);
      if (previousFallbackKeys.has(item.key)) {
        fallbackKeys.push(item.key);
      }
      continue;
    }
    nextFlat.set(item.key, item.text);
    fallbackKeys.push(item.key);
  }

  // Do not infer fallback state from source-text equality alone.
  // Product names, config keys, and other intentional carry-through strings may
  // legitimately stay identical to English. Track fallback keys from actual
  // fallback decisions and previous fallback metadata instead.

  assertPlaceholderParity(sourceFlat, nextFlat, entry.locale);

  const nextMap: TranslationMap = {};
  for (const [key, value] of sourceFlat.entries()) {
    setNestedValue(nextMap, key, nextFlat.get(key) ?? value);
  }

  const nextProvider = allowTranslate
    ? resolveConfiguredProvider()
    : (previousMeta?.provider ?? "");
  const nextModel = allowTranslate ? resolveConfiguredModel() : (previousMeta?.model ?? "");
  const sortedFallbackKeys = [...new Set(fallbackKeys)].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const translatedKeys = sourceFlat.size - sortedFallbackKeys.length;
  const semanticMetaChanged =
    !previousMeta ||
    previousMeta.locale !== entry.locale ||
    previousMeta.sourceHash !== sourceHash ||
    previousMeta.provider !== nextProvider ||
    previousMeta.model !== nextModel ||
    previousMeta.totalKeys !== sourceFlat.size ||
    previousMeta.translatedKeys !== translatedKeys ||
    previousMeta.workflow !== CONTROL_UI_I18N_WORKFLOW ||
    !compareStringArrays(previousMeta.fallbackKeys, sortedFallbackKeys);

  const nextMeta: LocaleMeta = {
    fallbackKeys: sortedFallbackKeys,
    generatedAt: semanticMetaChanged ? new Date().toISOString() : previousMeta.generatedAt,
    locale: entry.locale,
    model: nextModel,
    provider: nextProvider,
    sourceHash,
    totalKeys: sourceFlat.size,
    translatedKeys,
    workflow: CONTROL_UI_I18N_WORKFLOW,
  };

  const expectedLocale = await formatGeneratedTypeScript(
    existingPath,
    renderLocaleModule(entry, nextMap),
  );
  const expectedMeta = renderMeta(nextMeta);
  const expectedGlossary = renderGlossary(glossary.length === 0 ? DEFAULT_GLOSSARY : glossary);
  const expectedTm = renderTranslationMemory(tm);

  const currentLocale = existsSync(existingPath) ? await readFile(existingPath, "utf8") : "";
  const currentMeta = existsSync(metaPath(entry)) ? await readFile(metaPath(entry), "utf8") : "";
  const currentGlossary = existsSync(glossaryFilePath)
    ? await readFile(glossaryFilePath, "utf8")
    : "";
  const currentTm = existsSync(tmPath(entry)) ? await readFile(tmPath(entry), "utf8") : "";

  const changed =
    currentLocale !== expectedLocale ||
    currentMeta !== expectedMeta ||
    currentGlossary !== expectedGlossary ||
    currentTm !== expectedTm;

  if (
    !changed ||
    (previousMeta?.sourceHash === sourceHash &&
      !options.force &&
      !options.checkOnly &&
      !options.write)
  ) {
    logProgress(
      `${localeLabel}: done changed=${changed} fallbacks=${nextMeta.fallbackKeys.length} elapsed=${formatDuration(Date.now() - localeStartedAt)}`,
    );
    return {
      changed,
      fallbackCount: nextMeta.fallbackKeys.length,
      locale: entry.locale,
      wrote: false,
    } satisfies SyncOutcome;
  }

  if (!options.checkOnly && options.write) {
    await mkdir(LOCALES_DIR, { recursive: true });
    await mkdir(I18N_ASSETS_DIR, { recursive: true });
    await writeFile(existingPath, expectedLocale, "utf8");
    await writeFile(metaPath(entry), expectedMeta, "utf8");
    await writeFile(glossaryFilePath, expectedGlossary, "utf8");
    if (expectedTm) {
      await writeFile(tmPath(entry), expectedTm, "utf8");
    } else if (existsSync(tmPath(entry))) {
      await writeFile(tmPath(entry), "", "utf8");
    }
  }

  logProgress(
    `${localeLabel}: done changed=${changed} fallbacks=${nextMeta.fallbackKeys.length} elapsed=${formatDuration(Date.now() - localeStartedAt)}${!options.checkOnly && options.write && changed ? " wrote" : ""}`,
  );
  return {
    changed,
    fallbackCount: nextMeta.fallbackKeys.length,
    locale: entry.locale,
    wrote: !options.checkOnly && options.write && changed,
  } satisfies SyncOutcome;
}

async function verifyRuntimeLocaleConfig() {
  const registryRaw = await readFile(
    path.join(ROOT, "ui", "src", "i18n", "lib", "registry.ts"),
    "utf8",
  );
  const typesRaw = await readFile(path.join(ROOT, "ui", "src", "i18n", "lib", "types.ts"), "utf8");
  const expectedLocaleSnippets = LOCALE_ENTRIES.map((entry) => entry.locale);
  for (const locale of expectedLocaleSnippets) {
    if (!registryRaw.includes(`"${locale}"`) || !typesRaw.includes(`| "${locale}"`)) {
      throw new Error(`runtime locale config is missing ${locale}`);
    }
  }

  const enMap = (await loadLocaleMap(SOURCE_LOCALE_PATH, "en")) ?? {};
  const languageMap = enMap.languages;
  const languageKeys =
    languageMap && typeof languageMap === "object"
      ? Object.keys(languageMap).toSorted((left, right) => left.localeCompare(right))
      : [];
  const expectedLanguageKeys = ["en", ...LOCALE_ENTRIES.map((entry) => entry.languageKey)].toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (!compareStringArrays(languageKeys, expectedLanguageKeys)) {
    throw new Error(
      `ui/src/i18n/locales/en.ts languages block is out of sync: expected ${expectedLanguageKeys.join(", ")}, got ${languageKeys.join(", ")}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await verifyRuntimeLocaleConfig();
  if (args.command === "check" || (args.command === "sync" && args.write && !args.localeFilter)) {
    await syncControlUiRawCopyBaseline({
      checkOnly: args.command === "check",
      write: args.write,
    });
  }

  const entries = args.localeFilter
    ? LOCALE_ENTRIES.filter((entry) => entry.locale === args.localeFilter)
    : [...LOCALE_ENTRIES];

  if (entries.length === 0) {
    throw new Error(`unknown locale: ${args.localeFilter}`);
  }

  logProgress(
    `command=${args.command} locales=${entries.length} provider=${hasTranslationProvider() ? resolveConfiguredProvider() : "fallback-only"} model=${hasTranslationProvider() ? resolveConfiguredModel() : "n/a"} thinking=${hasTranslationProvider() ? resolveThinkingLevel() : "n/a"} timeout=${formatDuration(resolvePromptTimeoutMs())} batch_chars=${resolveBatchCharBudget()}`,
  );
  const outcomes: SyncOutcome[] = [];
  for (const [index, entry] of entries.entries()) {
    const outcome = await syncLocale(
      entry,
      {
        checkOnly: args.command === "check",
        force: args.force,
        write: args.write,
      },
      {
        localeCount: entries.length,
        localeIndex: index + 1,
      },
    );
    outcomes.push(outcome);
  }

  const changed = outcomes.filter((outcome) => outcome.changed);
  const summary = outcomes
    .map(
      (outcome) =>
        `${outcome.locale}: ${outcome.changed ? "dirty" : "clean"} (fallbacks=${outcome.fallbackCount}${outcome.wrote ? ", wrote" : ""})`,
    )
    .join("\n");
  process.stdout.write(`${summary}\n`);

  if (args.command === "check" && changed.length > 0) {
    throw new Error(
      [
        "control-ui-i18n drift detected.",
        "Run `node --import tsx scripts/control-ui-i18n.ts sync --write` and commit the results.",
      ].join("\n"),
    );
  }

  if (args.command === "sync" && !args.write && changed.length > 0) {
    process.stdout.write(
      "dry-run only. re-run with `node --import tsx scripts/control-ui-i18n.ts sync --write` to update files.\n",
    );
  }
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  await main().catch((error: unknown) => {
    console.error(formatErrorMessage(error));
    process.exit(1);
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
