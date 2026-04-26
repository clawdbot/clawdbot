import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";

interface TranslationMap {
  [key: string]: string | TranslationMap;
}

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

const CONTROL_UI_I18N_WORKFLOW = 1;
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-6";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_PI_PACKAGE_VERSION = "0.58.3";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOCALES_DIR = path.join(ROOT, "ui", "src", "i18n", "locales");
const I18N_ASSETS_DIR = path.join(ROOT, "ui", "src", "i18n", ".i18n");
const SOURCE_LOCALE_PATH = path.join(LOCALES_DIR, "en.ts");
const SOURCE_LOCALE = "en";
const MAX_BATCH_ITEMS = 20;
const DEFAULT_BATCH_CHAR_BUDGET = 2_000;
const TRANSLATE_MAX_ATTEMPTS = 2;
const TRANSLATE_BASE_DELAY_MS = 15_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const PROGRESS_HEARTBEAT_MS = 30_000;
const ENV_PROVIDER = "OPENCLAW_CONTROL_UI_I18N_PROVIDER";
const ENV_MODEL = "OPENCLAW_CONTROL_UI_I18N_MODEL";
const ENV_THINKING = "OPENCLAW_CONTROL_UI_I18N_THINKING";
const ENV_PI_EXECUTABLE = "OPENCLAW_CONTROL_UI_I18N_PI_EXECUTABLE";
const ENV_PI_ARGS = "OPENCLAW_CONTROL_UI_I18N_PI_ARGS";
const ENV_PI_PACKAGE_VERSION = "OPENCLAW_CONTROL_UI_I18N_PI_PACKAGE_VERSION";
const ENV_BATCH_CHAR_BUDGET = "OPENCLAW_CONTROL_UI_I18N_BATCH_CHAR_BUDGET";
const ENV_PROMPT_TIMEOUT = "OPENCLAW_CONTROL_UI_I18N_PROMPT_TIMEOUT";

const LOCALE_ENTRIES: readonly LocaleEntry[] = [
  { locale: "zh-CN", fileName: "zh-CN.ts", exportName: "zh_CN", languageKey: "zhCN" },
  { locale: "zh-TW", fileName: "zh-TW.ts", exportName: "zh_TW", languageKey: "zhTW" },
  { locale: "pt-BR", fileName: "pt-BR.ts", exportName: "pt_BR", languageKey: "ptBR" },
  { locale: "de", fileName: "de.ts", exportName: "de", languageKey: "de" },
  { locale: "es", fileName: "es.ts", exportName: "es", languageKey: "es" },
  { locale: "ja-JP", fileName: "ja-JP.ts", exportName: "ja_JP", languageKey: "jaJP" },
  { locale: "ko", fileName: "ko.ts", exportName: "ko", languageKey: "ko" },
  { locale: "fr", fileName: "fr.ts", exportName: "fr", languageKey: "fr" },
  { locale: "tr", fileName: "tr.ts", exportName: "tr", languageKey: "tr" },
  { locale: "uk", fileName: "uk.ts", exportName: "uk", languageKey: "uk" },
  { locale: "id", fileName: "id.ts", exportName: "id", languageKey: "id" },
  { locale: "pl", fileName: "pl.ts", exportName: "pl", languageKey: "pl" },
  { locale: "th", fileName: "th.ts", exportName: "th", languageKey: "th" },
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
    "engine=pi",
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
    'import type { TranslationMap } from "../lib/types.ts";',
    "",
    "// Generated by scripts/control-ui-i18n.ts.",
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
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isPromptTimeoutError(error: Error): boolean {
  return error.message.toLowerCase().includes("timed out");
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

type PiCommand = {
  args: string[];
  executable: string;
};

function resolvePiPackageVersion(): string {
  return process.env[ENV_PI_PACKAGE_VERSION]?.trim() || DEFAULT_PI_PACKAGE_VERSION;
}

function getPiRuntimeDir() {
  return path.join(
    homedir(),
    ".cache",
    "openclaw",
    "control-ui-i18n",
    "pi-runtime",
    resolvePiPackageVersion(),
  );
}

async function resolvePiCommand(): Promise<PiCommand> {
  const explicitExecutable = process.env[ENV_PI_EXECUTABLE]?.trim();
  if (explicitExecutable) {
    return {
      executable: explicitExecutable,
      args: process.env[ENV_PI_ARGS]?.trim().split(/\s+/).filter(Boolean) ?? [],
    };
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, process.platform === "win32" ? "pi.cmd" : "pi");
    if (existsSync(candidate)) {
      return { executable: candidate, args: [] };
    }
  }

  const runtimeDir = getPiRuntimeDir();
  const cliPath = path.join(
    runtimeDir,
    "node_modules",
    "@mariozechner",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  if (!existsSync(cliPath)) {
    await mkdir(runtimeDir, { recursive: true });
    await runProcess(
      "npm",
      [
        "install",
        "--silent",
        "--no-audit",
        "--no-fund",
        `@mariozechner/pi-coding-agent@${resolvePiPackageVersion()}`,
      ],
      {
        cwd: runtimeDir,
        rejectOnFailure: true,
      },
    );
  }
  return { executable: "node", args: [cliPath] };
}

type RunProcessOptions = {
  cwd?: string;
  input?: string;
  rejectOnFailure?: boolean;
};

async function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    child.once("close", (code) => {
      if ((code ?? 1) !== 0 && options.rejectOnFailure) {
        reject(
          new Error(`${executable} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`),
        );
        return;
      }
      resolve({ code: code ?? 1, stderr, stdout });
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
  return result.stdout;
}

type PendingPrompt = {
  id: string;
  reject: (reason?: unknown) => void;
  resolve: (value: string) => void;
  responseReceived: boolean;
};

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
  getClient: () => Promise<PiRpcClient>;
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

class PiRpcClient {
  private readonly stderrChunks: string[] = [];
  private closed = false;
  private pending: PendingPrompt | null = null;
  private readonly process;
  private readonly stdin;
  private requestCount = 0;
  private sequence = Promise.resolve();

  private constructor(processHandle: ReturnType<typeof spawn>) {
    this.process = processHandle;
    this.stdin = processHandle.stdin;
  }

  static async create(systemPrompt: string): Promise<PiRpcClient> {
    const command = await resolvePiCommand();
    const args = [
      ...command.args,
      "--mode",
      "rpc",
      "--provider",
      resolveConfiguredProvider(),
      "--model",
      resolveConfiguredModel(),
      "--thinking",
      resolveThinkingLevel(),
      "--no-session",
      "--system-prompt",
      systemPrompt,
    ];
    const child = spawn(command.executable, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new PiRpcClient(child);
    client.bindProcess();
    await client.waitForBoot();
    return client;
  }

  private bindProcess() {
    const stderr = createInterface({ input: this.process.stderr });
    stderr.on("line", (line) => {
      this.stderrChunks.push(line);
    });

    const stdout = createInterface({ input: this.process.stdout });
    stdout.on("line", (line) => {
      void this.handleStdoutLine(line);
    });

    this.process.once("error", (error) => {
      this.rejectPending(error);
    });

    this.process.once("close", () => {
      this.closed = true;
      this.rejectPending(
        new Error(`pi process closed${this.stderr() ? ` (${this.stderr()})` : ""}`),
      );
    });
  }

  private async waitForBoot() {
    await sleep(150);
  }

  private stderr() {
    return this.stderrChunks.join("\n").trim();
  }

  private rejectPending(error: Error) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      pending.reject(error);
    }
  }

  private async handleStdoutLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const pending = this.pending;
    if (!pending) {
      return;
    }

    switch (parsed.type) {
      case "response": {
        if (parsed.id !== pending.id) {
          return;
        }
        const success = parsed.success === true;
        if (!success) {
          const errorText =
            typeof parsed.error === "string" && parsed.error.trim()
              ? parsed.error.trim()
              : "pi prompt failed";
          this.pending = null;
          pending.reject(new Error(errorText));
          return;
        }
        pending.responseReceived = true;
        return;
      }
      case "agent_end": {
        try {
          const result = extractTranslationResult(parsed);
          this.pending = null;
          pending.resolve(result);
        } catch (error) {
          this.pending = null;
          pending.reject(error);
        }
      }
    }
  }

  async prompt(message: string, label: string): Promise<string> {
    this.sequence = this.sequence.then(async () => {
      if (this.closed) {
        throw new Error(`pi process unavailable${this.stderr() ? ` (${this.stderr()})` : ""}`);
      }

      const id = `req-${++this.requestCount}`;
      const payload = JSON.stringify({ type: "prompt", id, message });
      const timeoutMs = resolvePromptTimeoutMs();
      const startedAt = Date.now();

      return await new Promise<string>((resolve, reject) => {
        const heartbeat = setInterval(() => {
          const responseState = this.pending?.responseReceived
            ? "response=received"
            : "response=pending";
          logProgress(
            `${label}: still waiting (${formatDuration(Date.now() - startedAt)} / ${formatDuration(timeoutMs)}, ${responseState})`,
          );
        }, PROGRESS_HEARTBEAT_MS);
        const timer = setTimeout(() => {
          if (this.pending?.id === id) {
            this.pending = null;
            clearInterval(heartbeat);
            void this.close();
            const stderr = this.stderr();
            reject(
              new Error(
                `${label}: translation prompt timed out after ${timeoutMs}ms${stderr ? ` (pi stderr: ${stderr})` : ""}`,
              ),
            );
          }
        }, timeoutMs);

        this.pending = {
          id,
          reject: (reason) => {
            clearTimeout(timer);
            clearInterval(heartbeat);
            reject(reason);
          },
          resolve: (value) => {
            clearTimeout(timer);
            clearInterval(heartbeat);
            resolve(value);
          },
          responseReceived: false,
        };

        this.stdin.write(`${payload}\n`, (error) => {
          if (!error) {
            return;
          }
          clearTimeout(timer);
          clearInterval(heartbeat);
          if (this.pending?.id === id) {
            this.pending = null;
          }
          reject(error);
        });
      });
    });

    return (await this.sequence) as string;
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stdin.end();
    this.process.kill("SIGTERM");
    await sleep(150);
    if (!this.process.killed) {
      this.process.kill("SIGKILL");
    }
  }
}

function extractTranslationResult(payload: Record<string, unknown>): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    if ((message as { role?: string }).role !== "assistant") {
      continue;
    }
    const errorMessage = (message as { errorMessage?: string }).errorMessage;
    const stopReason = (message as { stopReason?: string }).stopReason;
    if (errorMessage || stopReason === "error") {
      throw new Error(errorMessage?.trim() || "pi error");
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((block): block is { type?: string; text?: string } =>
          Boolean(block && typeof block === "object"),
        )
        .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
        .join("");
    }
  }
  throw new Error("assistant translation not found");
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
  const allowTranslate = hasTranslationProvider();

  const nextFlat = new Map<string, string>();
  const pending: TranslationBatchItem[] = [];
  const fallbackKeys: string[] = [];

  for (const [key, text] of sourceFlat.entries()) {
    const textHash = hashText(text);
    const segmentCacheKey = cacheKey(key, textHash, entry.locale);
    const cached = tm.get(segmentCacheKey);
    const existing = existingFlat.get(key);
    const shouldRefreshFallback = previousFallbackKeys.has(key);

    if (cached && !(allowTranslate && shouldRefreshFallback)) {
      nextFlat.set(key, cached.translated);
      if (shouldRefreshFallback) {
        fallbackKeys.push(key);
      }
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
    let client: PiRpcClient | null = null;
    const clientAccess: ClientAccess = {
      async getClient() {
        if (!client) {
          client = await PiRpcClient.create(buildSystemPrompt(entry.locale, glossary));
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

await main().catch((error) => {
  console.error(formatErrorMessage(error));
  process.exit(1);
});
