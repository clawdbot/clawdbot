/** Doctor repair for broken session transcript branches and legacy OpenAI Codex metadata. */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { resolveStateDir } from "../config/paths.js";
import { shortenHomePath } from "../utils.js";

type TranscriptEntry = Record<string, unknown> & {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  message?: unknown;
};

type TranscriptRepairResult = {
  filePath: string;
  broken: boolean;
  repaired: boolean;
  originalEntries: number;
  activeEntries: number;
  legacyOpenAICodexEntries: number;
  backupPath?: string;
  reason?: string;
};

const LEGACY_OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_PROVIDER_ID = "openai";
const LEGACY_OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const OPENAI_CHATGPT_RESPONSES_API = "openai-chatgpt-responses";

function parseTranscriptEntries(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as TranscriptEntry);
      }
    } catch {
      return [];
    }
  }
  return entries;
}

function getEntryId(entry: TranscriptEntry): string | null {
  return typeof entry.id === "string" && entry.id.trim() ? entry.id : null;
}

function getParentId(entry: TranscriptEntry): string | null {
  return typeof entry.parentId === "string" && entry.parentId.trim() ? entry.parentId : null;
}

function getMessage(entry: TranscriptEntry): Record<string, unknown> | null {
  return entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
    ? (entry.message as Record<string, unknown>)
    : null;
}

function normalizeLegacyOpenAICodexTranscriptMetadata(entries: TranscriptEntry[]): number {
  let changed = 0;
  for (const entry of entries) {
    const message = getMessage(entry);
    if (!message) {
      continue;
    }
    let touched = false;
    if (message.provider === LEGACY_OPENAI_CODEX_PROVIDER_ID) {
      message.provider = OPENAI_PROVIDER_ID;
      touched = true;
    }
    if (message.api === LEGACY_OPENAI_CODEX_RESPONSES_API) {
      message.api = OPENAI_CHATGPT_RESPONSES_API;
      touched = true;
    }
    if (touched) {
      changed += 1;
    }
  }
  return changed;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
  return text || null;
}

function selectActivePath(entries: TranscriptEntry[]): TranscriptEntry[] | null {
  const sessionEntries = entries.filter((entry) => entry.type !== "session");
  const leaf = sessionEntries.at(-1);
  const leafId = leaf ? getEntryId(leaf) : null;
  if (!leaf || !leafId) {
    return null;
  }

  const byId = new Map<string, TranscriptEntry>();
  for (const entry of sessionEntries) {
    const id = getEntryId(entry);
    if (id) {
      byId.set(id, entry);
    }
  }

  const active: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = leaf;
  while (current) {
    const id = getEntryId(current);
    if (!id || seen.has(id)) {
      return null;
    }
    seen.add(id);
    active.unshift(current);
    const parentId = getParentId(current);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return active;
}

function hasBrokenPromptRewriteBranch(entries: TranscriptEntry[], activePath: TranscriptEntry[]) {
  const activeIds = new Set(activePath.map(getEntryId).filter((id): id is string => Boolean(id)));
  const activeUserByParentAndText = new Set<string>();

  for (const entry of activePath) {
    const id = getEntryId(entry);
    const message = getMessage(entry);
    if (!id || message?.role !== "user") {
      continue;
    }
    const text = textFromContent(message.content);
    if (text !== null) {
      activeUserByParentAndText.add(`${getParentId(entry) ?? ""}\0${text.trim()}`);
    }
  }

  for (const entry of entries) {
    const id = getEntryId(entry);
    if (!id || activeIds.has(id)) {
      continue;
    }
    const message = getMessage(entry);
    if (message?.role !== "user") {
      continue;
    }
    const text = textFromContent(message.content);
    if (!text || !hasInternalRuntimeContext(text)) {
      continue;
    }
    const visibleText = stripInternalRuntimeContext(text).trim();
    if (
      visibleText &&
      activeUserByParentAndText.has(`${getParentId(entry) ?? ""}\0${visibleText}`)
    ) {
      return true;
    }
  }
  return false;
}

async function writeActiveTranscript(params: {
  filePath: string;
  entries: TranscriptEntry[];
  activePath: TranscriptEntry[];
}): Promise<string> {
  const header = params.entries.find((entry) => entry.type === "session");
  if (!header) {
    throw new Error("missing session header");
  }
  const backupPath = `${params.filePath}.pre-doctor-branch-repair-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.bak`;
  await fs.copyFile(params.filePath, backupPath);
  const next = [header, ...params.activePath].map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(params.filePath, `${next}\n`, "utf-8");
  return backupPath;
}

async function writeTranscriptEntries(params: {
  filePath: string;
  entries: TranscriptEntry[];
}): Promise<string> {
  const backupPath = `${params.filePath}.pre-doctor-openai-codex-repair-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.bak`;
  await fs.copyFile(params.filePath, backupPath);
  const next = params.entries.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(params.filePath, `${next}\n`, "utf-8");
  return backupPath;
}

/** Repairs one transcript file by keeping the active branch and backing up the original file. */
export async function repairBrokenSessionTranscriptFile(params: {
  filePath: string;
  shouldRepair: boolean;
}): Promise<TranscriptRepairResult> {
  try {
    const raw = await fs.readFile(params.filePath, "utf-8");
    const entries = parseTranscriptEntries(raw);
    const legacyOpenAICodexEntries = normalizeLegacyOpenAICodexTranscriptMetadata(entries);
    const activePath = selectActivePath(entries);
    if (!activePath) {
      if (legacyOpenAICodexEntries > 0 && params.shouldRepair) {
        const backupPath = await writeTranscriptEntries({ filePath: params.filePath, entries });
        return {
          filePath: params.filePath,
          broken: true,
          repaired: true,
          originalEntries: entries.length,
          activeEntries: 0,
          legacyOpenAICodexEntries,
          backupPath,
          reason: "no active branch",
        };
      }
      return {
        filePath: params.filePath,
        broken: legacyOpenAICodexEntries > 0,
        repaired: false,
        originalEntries: entries.length,
        activeEntries: 0,
        legacyOpenAICodexEntries,
        reason: "no active branch",
      };
    }
    const broken = hasBrokenPromptRewriteBranch(entries, activePath);
    if (!broken && legacyOpenAICodexEntries === 0) {
      return {
        filePath: params.filePath,
        broken: false,
        repaired: false,
        originalEntries: entries.length,
        activeEntries: activePath.length,
        legacyOpenAICodexEntries,
      };
    }
    if (!params.shouldRepair) {
      return {
        filePath: params.filePath,
        broken: true,
        repaired: false,
        originalEntries: entries.length,
        activeEntries: activePath.length,
        legacyOpenAICodexEntries,
      };
    }
    const backupPath = broken
      ? await writeActiveTranscript({
          filePath: params.filePath,
          entries,
          activePath,
        })
      : await writeTranscriptEntries({ filePath: params.filePath, entries });
    return {
      filePath: params.filePath,
      broken: true,
      repaired: true,
      originalEntries: entries.length,
      activeEntries: activePath.length,
      legacyOpenAICodexEntries,
      backupPath,
    };
  } catch (err) {
    return {
      filePath: params.filePath,
      broken: false,
      repaired: false,
      originalEntries: 0,
      activeEntries: 0,
      legacyOpenAICodexEntries: 0,
      reason: String(err),
    };
  }
}

async function listSessionTranscriptFiles(sessionDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const sessionsDir of sessionDirs) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(sessionsDir, entry.name));
      }
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

/** Scans session transcript files and reports or repairs legacy/broken transcript state. */
export async function noteSessionTranscriptHealth(params?: {
  shouldRepair?: boolean;
  sessionDirs?: string[];
}) {
  const shouldRepair = params?.shouldRepair === true;
  let sessionDirs = params?.sessionDirs;
  try {
    sessionDirs ??= await resolveAgentSessionDirs(resolveStateDir(process.env));
  } catch (err) {
    note(`- Failed to inspect session transcripts: ${String(err)}`, "Session transcripts");
    return;
  }

  const files = await listSessionTranscriptFiles(sessionDirs);
  if (files.length === 0) {
    return;
  }

  const results: TranscriptRepairResult[] = [];
  for (const filePath of files) {
    results.push(await repairBrokenSessionTranscriptFile({ filePath, shouldRepair }));
  }
  const broken = results.filter((result) => result.broken);
  if (broken.length === 0) {
    return;
  }

  const repairedCount = broken.filter((result) => result.repaired).length;
  const lines = [
    `- Found ${broken.length} transcript file${broken.length === 1 ? "" : "s"} with legacy state.`,
    ...broken.slice(0, 20).map((result) => {
      const backup = result.backupPath ? ` backup=${shortenHomePath(result.backupPath)}` : "";
      const status = result.repaired ? "repaired" : "needs repair";
      const metadata =
        result.legacyOpenAICodexEntries > 0
          ? ` openai-codex=${result.legacyOpenAICodexEntries}`
          : "";
      return `- ${shortenHomePath(result.filePath)} ${status} entries=${result.originalEntries}->${result.activeEntries + 1}${metadata}${backup}`;
    }),
  ];
  if (broken.length > 20) {
    lines.push(`- ...and ${broken.length - 20} more.`);
  }
  if (!shouldRepair) {
    lines.push('- Run "openclaw doctor --fix" to rewrite affected files to their active branch.');
  } else if (repairedCount > 0) {
    lines.push(`- Repaired ${repairedCount} transcript file${repairedCount === 1 ? "" : "s"}.`);
  }

  note(lines.join("\n"), "Session transcripts");
}
