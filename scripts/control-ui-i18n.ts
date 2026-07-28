// Control Ui I18N script supports OpenClaw repository automation.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { completeSimple, type AssistantMessage, type Model } from "openclaw/plugin-sdk/llm";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { formatDurationCompact } from "../src/infra/format-time/format-duration.ts";
import {
  syncControlUiCatalogFallbackBaseline,
  verifyControlUiGeneratedCatalogs,
  verifyRuntimeLocaleConfig,
} from "./control-ui-i18n-verify.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "./lib/control-ui-i18n-config.ts";
import { syncControlUiRawCopyBaseline } from "./lib/control-ui-i18n-raw-copy.ts";
import {
  compareStringArrays,
  createControlUiLocaleSyncPlan,
  flattenTranslations,
  resolveLocaleMetaProvenance,
  type GlossaryEntry,
  type LocaleEntry,
  type LocaleMeta,
  type TranslationBatchItem,
  type TranslationMap,
  type TranslationMemoryEntry,
} from "./lib/control-ui-i18n-sync-plan.ts";
import { sleep } from "./lib/sleep.mjs";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";

export { shouldReuseExistingTranslation } from "./lib/control-ui-i18n-sync-plan.ts";

const { formatGeneratedModule } = (await import(
  new URL("./lib/format-generated-module.mjs", import.meta.url).href
)) as {
  formatGeneratedModule: (
    source: string,
    options: {
      errorLabel: string;
      outputPath: string;
      repoRoot: string;
    },
  ) => string;
};

type RunProcessParentSignalState = {
  done: boolean;
  signal: NodeJS.Signals | null;
};

const CONTROL_UI_I18N_WORKFLOW = 1;
const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-6";
const DEFAULT_PROVIDER = "openai";
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
const RUN_PROCESS_OUTPUT_MAX_CHARS = 1024 * 1024;
const RUN_PROCESS_TIMEOUT_MS = 120_000;
const RUN_PROCESS_KILL_GRACE_MS = 5_000;
const activeRunProcessParentSignals = new Set<RunProcessParentSignalState>();
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

const LOCALE_ENTRIES: readonly LocaleEntry[] = CONTROL_UI_LOCALE_ENTRIES;

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
    case "hi":
      return "Hindi";
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
    case "ru":
      return "Russian";
    case "sv":
      return "Swedish";
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

type PlaceholderMismatch = {
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

export function filterPlaceholderCompatibleTranslations(
  sourceFlat: ReadonlyMap<string, string>,
  translatedFlat: ReadonlyMap<string, string>,
): Map<string, string> {
  return new Map(
    [...translatedFlat].filter(([key, translated]) => {
      const source = sourceFlat.get(key);
      return (
        source !== undefined &&
        compareStringArrays(
          extractTranslationPlaceholders(source),
          extractTranslationPlaceholders(translated),
        )
      );
    }),
  );
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

async function loadGlossary(filePath: string): Promise<GlossaryEntry[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as GlossaryEntry[];
  return Array.isArray(parsed) ? parsed : [];
}

async function loadMeta(filePath: string): Promise<LocaleMeta | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as LocaleMeta;
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
    "- Preserve Swift interpolation expressions such as \\(name) exactly, including the backslash and parentheses.",
    "- Preserve Kotlin interpolation expressions such as $name and ${value} exactly.",
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

export function buildBatchPrompt(
  items: readonly TranslationBatchItem[],
  validationError?: string,
): string {
  const payload = Object.fromEntries(items.map((item) => [item.key, item.text]));
  const lines = ["Translate this JSON object.", "Return ONLY a JSON object with the same keys."];
  if (validationError) {
    lines.push(
      "",
      "Your previous response failed validation. Correct that exact failure in the new response:",
      validationError,
    );
  }
  lines.push("", JSON.stringify(payload, null, 2));
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  return formatDurationCompact(ms, { spaced: true }) ?? "0ms";
}

function logProgress(message: string) {
  process.stdout.write(`control-ui-i18n: ${message}\n`);
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

function maybeReraiseRunProcessParentSignal(signal: NodeJS.Signals): void {
  for (const state of activeRunProcessParentSignals) {
    if (state.signal === null || !state.done) {
      return;
    }
  }
  process.kill(process.pid, signal);
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
    let parentSignalPending: NodeJS.Signals | null = null;
    const parentSignalState: RunProcessParentSignalState = { done: false, signal: null };
    activeRunProcessParentSignals.add(parentSignalState);
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
      const result = spawnSync(resolveWindowsTaskkillPath(), taskkillArgs, { stdio: "ignore" });
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
        parentSignalPending = signal;
        parentSignalState.signal = signal;
        signalChild(signal);
        cleanupParentSignalHandlers();
        if (!processGroupIsAlive()) {
          parentSignalState.done = true;
          maybeReraiseRunProcessParentSignal(signal);
          return;
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        waitingForKillGrace = true;
        // Keep this timer ref'ed so parent signal relay can force-kill stubborn
        // process groups before re-raising the original signal.
        killTimer = setTimeout(() => {
          waitingForKillGrace = false;
          killTimer = undefined;
          signalChild("SIGKILL");
          parentSignalState.done = true;
          maybeReraiseRunProcessParentSignal(signal);
        }, killGraceMs);
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
      if (!parentSignalPending && killTimer) {
        clearTimeout(killTimer);
      }
      if (!parentSignalPending) {
        activeRunProcessParentSignals.delete(parentSignalState);
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
      if (parentSignalPending) {
        if (processGroupIsAlive()) {
          childClosedResult = { code, signal };
          return;
        }
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        parentSignalState.done = true;
        maybeReraiseRunProcessParentSignal(parentSignalPending);
        return;
      }
      if (waitingForKillGrace && processGroupIsAlive()) {
        childClosedResult = { code, signal };
        return;
      }
      finishClose(code, signal);
    });
  });
}

async function formatGeneratedTypeScript(filePath: string, source: string): Promise<string> {
  const formatted = formatGeneratedModule(source, {
    errorLabel: "control ui locale",
    outputPath: filePath,
    repoRoot: ROOT,
  });
  return restoreReplacementCorruptedStringLiterals(source, formatted);
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

function createTranslationClientAccess(
  targetLocale: string,
  glossary: readonly GlossaryEntry[],
): ClientAccess {
  let client: TranslationClient | null = null;
  return {
    async getClient() {
      client ??= await TranslationClient.create(buildSystemPrompt(targetLocale, glossary));
      return client;
    },
    async resetClient() {
      await client?.close();
      client = null;
    },
  };
}

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

// Models intermittently wrap the JSON reply in a Markdown code fence even
// when told not to; strip it instead of burning a retry on a parse error.
function parseTranslationReply(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
  const json = fenced ? expectDefined(fenced[1], "fenced translation JSON body") : trimmed;
  return JSON.parse(json);
}

export function parseTranslationBatchReply(
  raw: string,
  items: readonly TranslationBatchItem[],
  locale: string,
): Map<string, string> {
  const parsed = parseTranslationReply(raw);
  const translated = new Map<string, string>();
  for (const item of items) {
    const value = parsed[item.key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`missing translation for ${item.key}`);
    }
    translated.set(item.key, value);
  }
  assertPlaceholderParity(new Map(items.map((item) => [item.key, item.text])), translated, locale);
  return translated;
}

async function translateBatch(
  clientAccess: ClientAccess,
  items: readonly TranslationBatchItem[],
  context: TranslationBatchContext,
): Promise<Map<string, string>> {
  const batchLabel = formatBatchLabel(context);
  const splitDepth = context.splitDepth ?? 0;
  let lastError: Error | null = null;
  let validationError: string | undefined;
  for (let attempt = 0; attempt < TRANSLATE_MAX_ATTEMPTS; attempt += 1) {
    const attemptNumber = attempt + 1;
    const attemptLabel = `${batchLabel} attempt ${attemptNumber}/${TRANSLATE_MAX_ATTEMPTS}`;
    const startedAt = Date.now();
    logProgress(`${attemptLabel}: start keys=${items.length}`);
    let promptCompleted = false;
    try {
      const raw = await (
        await clientAccess.getClient()
      ).prompt(buildBatchPrompt(items, validationError), attemptLabel);
      promptCompleted = true;
      const translated = parseTranslationBatchReply(raw, items, context.locale);
      logProgress(`${attemptLabel}: done (${formatDuration(Date.now() - startedAt)})`);
      return translated;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (promptCompleted) {
        validationError = lastError.message;
      }
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

type NativeTranslationEntry = {
  id: string;
  source: string;
  sourcePath: string;
};

export async function translateNativeEntries(
  entries: readonly NativeTranslationEntry[],
  targetLocale: string,
  glossary: readonly GlossaryEntry[] = [],
): Promise<Map<string, string>> {
  if (!hasTranslationProvider()) {
    throw new Error("native app translation requires OPENAI_API_KEY or ANTHROPIC_API_KEY");
  }
  const pending = entries.map((entry) => ({
    cacheKey: cacheKey(entry.id, hashText(entry.source), targetLocale),
    key: entry.id,
    text: entry.source,
    textHash: hashText(entry.source),
  }));
  const batches = buildTranslationBatches(pending);
  const clientAccess = createTranslationClientAccess(targetLocale, glossary);
  try {
    const translated = new Map<string, string>();
    for (const [batchIndex, batch] of batches.entries()) {
      const result = await translateBatch(clientAccess, batch, {
        locale: targetLocale,
        localeCount: 1,
        localeIndex: 1,
        batchCount: batches.length,
        batchIndex: batchIndex + 1,
      });
      for (const [id, value] of result) {
        translated.set(id, value);
      }
    }
    return translated;
  } finally {
    await clientAccess.resetClient();
  }
}

type SyncOutcome = {
  changed: boolean;
  fallbackCount: number;
  locale: string;
  wrote: boolean;
};

export function assertNoControlUiFallbacks(
  outcomes: ReadonlyArray<Pick<SyncOutcome, "fallbackCount" | "locale">>,
) {
  const fallbackLocales = outcomes.filter((outcome) => outcome.fallbackCount > 0);
  if (fallbackLocales.length === 0) {
    return;
  }
  throw new Error(
    [
      "control-ui-i18n generated locales still contain English fallbacks.",
      ...fallbackLocales.map(
        (outcome) => `${outcome.locale}: ${outcome.fallbackCount} fallback keys`,
      ),
    ].join("\n"),
  );
}

async function syncLocale(
  entry: LocaleEntry,
  options: { allowTranslate: boolean; checkOnly: boolean; force: boolean; write: boolean },
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
  // Placeholder changes invalidate the old translation even when the key stays
  // stable. Treat it as pending so the locale bot can repair source-only PRs.
  const reusableExistingFlat = filterPlaceholderCompatibleTranslations(sourceFlat, existingFlat);
  const previousMeta = await loadMeta(metaPath(entry));
  const glossaryFilePath = glossaryPath(entry);
  const glossary = await loadGlossary(glossaryFilePath);
  const tm = await loadTranslationMemory(tmPath(entry));
  const allowTranslate = options.allowTranslate;
  const plan = createControlUiLocaleSyncPlan({
    allowTranslate,
    cacheKeyFor: (key, textHash) => cacheKey(key, textHash, entry.locale),
    entry,
    existingFlat: reusableExistingFlat,
    force: options.force,
    hashText,
    previousMeta,
    sourceFlat,
    sourceHash,
    translationMemory: tm,
  });

  // Writing NEW English fallbacks trips the shipped-fallback CI gate
  // (test/scripts/control-ui-i18n.test.ts), and post-merge translation is owned
  // by the control-ui-locale-refresh workflow. An unauthenticated local sync
  // must fail here instead of silently recording fallback bundles; refreshing
  // already-recorded fallback copy (force mode) stays allowed.
  if (!allowTranslate && options.write && !options.checkOnly && !isProviderAuthOptional()) {
    if (plan.newFallbackCount > 0) {
      throw new Error(
        `${localeLabel}: ${plan.newFallbackCount} new key(s) need translation but no provider is configured. ` +
          `Commit only locales/en.ts and let the control-ui-locale-refresh workflow translate after merge, ` +
          `or export ANTHROPIC_API_KEY/OPENAI_API_KEY and rerun. ` +
          `Set ${ENV_AUTH_OPTIONAL}=1 to record English fallbacks anyway.`,
      );
    }
  }

  if (allowTranslate && plan.pending.length > 0) {
    const batches = buildTranslationBatches(plan.pending);
    const batchCount = batches.length;
    logProgress(
      `${localeLabel}: start keys=${sourceFlat.size} pending=${plan.pending.length} batches=${batchCount} provider=${resolveConfiguredProvider()} model=${resolveConfiguredModel()} thinking=${resolveThinkingLevel()} timeout=${formatDuration(resolvePromptTimeoutMs())} batch_chars=${resolveBatchCharBudget()}`,
    );
    const clientAccess = createTranslationClientAccess(entry.locale, glossary);
    try {
      for (const [batchIndex, batch] of batches.entries()) {
        const translated = await translateBatch(clientAccess, batch, {
          ...context,
          batchCount,
          batchIndex: batchIndex + 1,
          locale: entry.locale,
        });
        plan.recordTranslations(batch, translated, {
          model: resolveConfiguredModel(),
          provider: resolveConfiguredProvider(),
          sourceLocale: SOURCE_LOCALE,
          updatedAt: () => new Date().toISOString(),
        });
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

  // Do not infer fallback state from source-text equality alone.
  // Product names, config keys, and other intentional carry-through strings may
  // legitimately stay identical to English. Track fallback keys from actual
  // fallback decisions and previous fallback metadata instead.

  const provenance = resolveLocaleMetaProvenance({
    didTranslate: allowTranslate && plan.pending.length > 0,
    model: allowTranslate ? resolveConfiguredModel() : "",
    previousMeta,
    provider: allowTranslate ? resolveConfiguredProvider() : "",
  });
  const artifacts = plan.render({
    defaultGlossary: DEFAULT_GLOSSARY,
    generatedAt: new Date().toISOString(),
    glossary,
    model: provenance.model,
    provider: provenance.provider,
    workflow: CONTROL_UI_I18N_WORKFLOW,
  });
  assertPlaceholderParity(sourceFlat, artifacts.nextFlat, entry.locale);

  const expectedLocale = await formatGeneratedTypeScript(existingPath, artifacts.localeModule);
  const expectedMeta = artifacts.meta;
  const expectedGlossary = artifacts.glossary;
  const expectedTm = artifacts.translationMemory;

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
      `${localeLabel}: done changed=${changed} fallbacks=${artifacts.fallbackCount} elapsed=${formatDuration(Date.now() - localeStartedAt)}`,
    );
    return {
      changed,
      fallbackCount: artifacts.fallbackCount,
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
    `${localeLabel}: done changed=${changed} fallbacks=${artifacts.fallbackCount} elapsed=${formatDuration(Date.now() - localeStartedAt)}${!options.checkOnly && options.write && changed ? " wrote" : ""}`,
  );
  return {
    changed,
    fallbackCount: artifacts.fallbackCount,
    locale: entry.locale,
    wrote: !options.checkOnly && options.write && changed,
  } satisfies SyncOutcome;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "check") {
    await verifyControlUiGeneratedCatalogs({
      checkOnly: true,
      write: false,
    });
  } else {
    await verifyRuntimeLocaleConfig();
  }
  if (args.command === "sync" && args.write && !args.localeFilter) {
    await syncControlUiRawCopyBaseline({
      checkOnly: false,
      write: args.write,
    });
  }

  const entries = args.localeFilter
    ? LOCALE_ENTRIES.filter((entry) => entry.locale === args.localeFilter)
    : [...LOCALE_ENTRIES];

  if (entries.length === 0) {
    throw new Error(`unknown locale: ${args.localeFilter}`);
  }

  const allowTranslate = args.command === "sync" && hasTranslationProvider();
  logProgress(
    `command=${args.command} locales=${entries.length} provider=${allowTranslate ? resolveConfiguredProvider() : "disabled"} model=${allowTranslate ? resolveConfiguredModel() : "n/a"} thinking=${allowTranslate ? resolveThinkingLevel() : "n/a"} timeout=${formatDuration(resolvePromptTimeoutMs())} batch_chars=${resolveBatchCharBudget()}`,
  );
  const outcomes: SyncOutcome[] = [];
  for (const [index, entry] of entries.entries()) {
    const outcome = await syncLocale(
      entry,
      {
        allowTranslate,
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

  if (args.command === "sync" && args.write) {
    await syncControlUiCatalogFallbackBaseline({
      // A scoped matrix worker can observe unsynced sibling locales. The final
      // aggregate sync still rebuilds and validates the complete catalog.
      allowCatalogDrift: Boolean(args.localeFilter),
      checkOnly: false,
      write: true,
    });
  }

  if (args.command === "check") {
    assertNoControlUiFallbacks(outcomes);
    if (changed.length > 0) {
      throw new Error(
        [
          "control-ui-i18n drift detected.",
          "Run `node --import tsx scripts/control-ui-i18n.ts sync --write` and commit the results.",
        ].join("\n"),
      );
    }
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
