// Native locale automation should react to message semantics, not source offsets
// or unrelated changes in the web translation memory.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INVENTORY_PATH = "apps/.i18n/native-source.json";
const LINUX_MESSAGES_PATH = "apps/linux/ui/messages.json";
const ENGLISH_SOURCE_PATH_RE = /^ui\/src\/i18n\/locales\/en(?:-agents)?\.ts$/u;
const TRANSLATION_MEMORY_PATH_RE = /^ui\/src\/i18n\/\.i18n\/[^/]+\.tm\.jsonl$/u;
const FORCE_REFRESH_PATH_RE =
  /^(?:scripts\/(?:control-ui-i18n|android-app-i18n|apple-app-i18n|native-app-i18n|native-i18n-locales)\.ts|scripts\/lib\/(?:control-ui-i18n-(?:catalog|config|shared-catalog|sync-plan)\.ts|native-i18n-refresh-plan\.mjs)|apps\/linux\/ui\/generate-locales\.ts|ui\/src\/i18n\/\.i18n\/glossary\.[^/]+\.json|\.github\/actions\/(?:create-generated-pr-tokens|publish-generated-pr)\/action\.yml|\.github\/workflows\/native-app-locale-refresh\.yml)$/u;
const HEX_SHA_RE = /^[0-9a-f]{40}$/u;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

function exceededGitSafetyLimits(error) {
  return error?.code === "ENOBUFS" || error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM";
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
}

function readRevision(cwd, revision, filePath) {
  try {
    return runGit(cwd, ["show", `${revision}:${filePath}`]);
  } catch (error) {
    if (exceededGitSafetyLimits(error)) {
      throw error;
    }
    return undefined;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "line")
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function normalizeNativeI18nInventory(raw) {
  if (raw === undefined) {
    return undefined;
  }
  const inventory = JSON.parse(raw);
  const entries = inventory.entries.map((entry) => JSON.stringify(stableValue(entry))).toSorted();
  return JSON.stringify({ ...stableValue(inventory), entries });
}

function normalizeLinuxMessages(raw) {
  return raw === undefined ? undefined : JSON.stringify(stableValue(JSON.parse(raw)));
}

function hashTranslationSource(source) {
  return createHash("sha256").update(source.trim().split(/\s+/u).join(" ")).digest("hex");
}

function parseRelevantTranslationMemory(raw, relevantSourcesByKey) {
  if (raw === undefined) {
    return [];
  }

  const memoryByCacheKey = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line);
    if (entry.cache_key && entry.translated.trim()) {
      memoryByCacheKey.set(entry.cache_key, entry);
    }
  }

  const effectiveTranslations = new Map();
  for (const entry of memoryByCacheKey.values()) {
    for (const key of [entry.segment_id, ...(entry.segment_ids ?? [])]) {
      const source = relevantSourcesByKey.get(key);
      if (source !== undefined && entry.text_hash === hashTranslationSource(source)) {
        effectiveTranslations.set(key, entry.translated);
      }
    }
  }

  return [...effectiveTranslations]
    .map(([key, translated]) => JSON.stringify({ key, translated }))
    .toSorted();
}

function changesRelevantEnglishMessage(
  cwd,
  beforeSha,
  headSha,
  filePath,
  relevantKeys,
  relevantSources,
) {
  const diff = runGit(cwd, [
    "diff",
    "--no-ext-diff",
    "--unified=0",
    beforeSha,
    headSha,
    "--",
    filePath,
  ]);
  const relevantLeaves = new Set(
    [...relevantKeys].map((key) => key.split(".").at(-1)).filter(Boolean),
  );
  return diff
    .split("\n")
    .filter((line) => /^[+-](?![+-])/u.test(line))
    .some((line) => {
      const property = /^[-+]\s*([\w$]+)\s*:/u.exec(line)?.[1];
      if (property && relevantLeaves.has(property)) {
        return true;
      }
      for (const match of line.matchAll(/"(?:\\.|[^"\\])*"/gu)) {
        if (relevantSources.has(JSON.parse(match[0]))) {
          return true;
        }
      }
      return false;
    });
}

/**
 * Returns the safe, deterministic refresh decision before locale fan-out or
 * credential acquisition. Missing history deliberately falls back to refresh.
 */
function resolveNativeI18nRefreshPlan({ beforeSha, cwd = process.cwd(), eventName, headSha }) {
  if (eventName !== "push") {
    return { refresh: true, reason: "manual-dispatch" };
  }
  if (!HEX_SHA_RE.test(beforeSha) || !HEX_SHA_RE.test(headSha) || /^0+$/u.test(beforeSha)) {
    return { refresh: true, reason: "unknown-push-base" };
  }

  try {
    runGit(cwd, ["cat-file", "-e", `${beforeSha}^{commit}`]);
  } catch {
    try {
      runGit(cwd, ["fetch", "--no-tags", "--depth=1", "origin", beforeSha]);
    } catch {
      return { refresh: true, reason: "unavailable-push-base" };
    }
  }

  const changedPaths = runGit(cwd, ["diff", "--name-only", "-z", beforeSha, headSha])
    .split("\0")
    .filter(Boolean);
  if (changedPaths.some((filePath) => FORCE_REFRESH_PATH_RE.test(filePath))) {
    return { refresh: true, reason: "semantic-tooling-or-glossary-changed" };
  }

  const previousInventory = readRevision(cwd, beforeSha, INVENTORY_PATH);
  const currentInventory = readRevision(cwd, headSha, INVENTORY_PATH);
  if (
    normalizeNativeI18nInventory(previousInventory) !==
    normalizeNativeI18nInventory(currentInventory)
  ) {
    return { refresh: true, reason: "native-message-catalog-changed" };
  }

  const previousLinuxMessages = readRevision(cwd, beforeSha, LINUX_MESSAGES_PATH);
  const currentLinuxMessages = readRevision(cwd, headSha, LINUX_MESSAGES_PATH);
  if (
    normalizeLinuxMessages(previousLinuxMessages) !== normalizeLinuxMessages(currentLinuxMessages)
  ) {
    return { refresh: true, reason: "linux-message-catalog-changed" };
  }

  const changedTranslationMemories = changedPaths.filter((filePath) =>
    TRANSLATION_MEMORY_PATH_RE.test(filePath),
  );
  const changedEnglishSources = changedPaths.filter((filePath) =>
    ENGLISH_SOURCE_PATH_RE.test(filePath),
  );
  if (changedTranslationMemories.length === 0 && changedEnglishSources.length === 0) {
    return { refresh: false, reason: "semantic-inputs-unchanged" };
  }

  const inventoryEntries = currentInventory ? JSON.parse(currentInventory).entries : [];
  const linuxMessages = JSON.parse(currentLinuxMessages ?? "{}");
  const relevantSourcesByKey = new Map();
  for (const entry of inventoryEntries) {
    for (const key of [entry.id, entry.semanticKey].filter(Boolean)) {
      relevantSourcesByKey.set(key, entry.source);
    }
  }
  for (const [key, value] of Object.entries(linuxMessages)) {
    if (typeof value === "string") {
      relevantSourcesByKey.set(key, value);
    } else if (value && typeof value.defaultMessage === "string") {
      relevantSourcesByKey.set(key, value.defaultMessage);
    }
  }
  const relevantKeys = new Set(relevantSourcesByKey.keys());
  const relevantSources = new Set(relevantSourcesByKey.values());

  if (
    changedEnglishSources.some((filePath) =>
      changesRelevantEnglishMessage(
        cwd,
        beforeSha,
        headSha,
        filePath,
        relevantKeys,
        relevantSources,
      ),
    )
  ) {
    return { refresh: true, reason: "shared-native-english-changed" };
  }

  const relevantMemoryChanged = changedTranslationMemories.some((filePath) => {
    const previous = parseRelevantTranslationMemory(
      readRevision(cwd, beforeSha, filePath),
      relevantSourcesByKey,
    );
    const current = parseRelevantTranslationMemory(
      readRevision(cwd, headSha, filePath),
      relevantSourcesByKey,
    );
    return JSON.stringify(previous) !== JSON.stringify(current);
  });
  return {
    refresh: relevantMemoryChanged,
    reason: relevantMemoryChanged
      ? "shared-native-translations-changed"
      : "semantic-inputs-unchanged",
  };
}

export function planNativeI18nRefresh(options) {
  try {
    return resolveNativeI18nRefreshPlan(options);
  } catch (error) {
    if (exceededGitSafetyLimits(error)) {
      return { refresh: true, reason: "semantic-input-safety-limit-exceeded" };
    }
    throw error;
  }
}

function main() {
  const { BEFORE_SHA = "", EVENT_NAME = "", GITHUB_OUTPUT, HEAD_SHA = "" } = process.env;
  if (!GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required for native locale refresh planning");
  }
  const result = planNativeI18nRefresh({
    beforeSha: BEFORE_SHA,
    eventName: EVENT_NAME,
    headSha: HEAD_SHA,
  });
  appendFileSync(GITHUB_OUTPUT, `refresh=${result.refresh}\nreason=${result.reason}\n`, "utf8");
  process.stdout.write(
    `native locale refresh: refresh=${result.refresh} reason=${result.reason}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
