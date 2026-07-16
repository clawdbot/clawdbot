import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import pMap, { pMapSkip } from "p-map";
import type { Message, TextContent } from "../../llm/types.js";
import { logWarn } from "../../logger.js";
import { getSessionsDir } from "../config.js";
import type { AgentMessage } from "../runtime/index.js";
import type {
  FileEntry,
  SessionEntryBase,
  SessionHeader,
  SessionInfo,
  SessionListProgress,
} from "./session-manager-types.js";

const SESSION_HEADER_READ_CHUNK_BYTES = 4096;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

function readFirstSessionFileLine(filePath: string): string | undefined {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < MAX_SESSION_HEADER_BYTES) {
      const buffer = Buffer.alloc(
        Math.min(SESSION_HEADER_READ_CHUNK_BYTES, MAX_SESSION_HEADER_BYTES - totalBytes),
      );
      const bytesRead = readSync(fd, buffer, 0, buffer.length, totalBytes);
      if (bytesRead === 0) {
        break;
      }
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex >= 0 && newlineIndex < bytesRead) {
        chunks.push(buffer.subarray(0, newlineIndex));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
  } finally {
    closeSync(fd);
  }
}

function readSessionHeaderFromFile(filePath: string): SessionHeader | undefined {
  try {
    const firstLine = readFirstSessionFileLine(filePath);
    if (!firstLine) {
      return undefined;
    }
    const header = JSON.parse(firstLine);
    return header.type === "session" && typeof header.id === "string" ? header : undefined;
  } catch {
    return undefined;
  }
}

export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
  try {
    const files = readdirSync(sessionDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => join(sessionDir, file))
      .map((path) => ({ path, header: readSessionHeaderFromFile(path) }))
      .filter(
        (candidate): candidate is { path: string; header: SessionHeader } =>
          candidate.header !== undefined && (cwd === undefined || candidate.header.cwd === cwd),
      )
      .map((candidate) => ({ path: candidate.path, mtime: statSync(candidate.path).mtime }))
      .toSorted((left, right) => right.mtime.getTime() - left.mtime.getTime());
    return files[0]?.path || null;
  } catch {
    return null;
  }
}

function isMessageWithContent(message: AgentMessage): message is Message {
  return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

function getLastActivityTime(entries: FileEntry[]): number | undefined {
  let lastActivityTime: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (
      !isMessageWithContent(message) ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      continue;
    }
    const messageTimestamp = (message as { timestamp?: number }).timestamp;
    if (typeof messageTimestamp === "number") {
      lastActivityTime = Math.max(lastActivityTime ?? 0, messageTimestamp);
      continue;
    }
    const entryTimestamp = (entry as SessionEntryBase).timestamp;
    if (typeof entryTimestamp === "string") {
      const timestamp = new Date(entryTimestamp).getTime();
      if (!Number.isNaN(timestamp)) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, timestamp);
      }
    }
  }
  return lastActivityTime;
}

function getSessionModifiedDate(
  entries: FileEntry[],
  header: SessionHeader,
  statsMtime: Date,
): Date {
  const lastActivityTime = getLastActivityTime(entries);
  if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
    return new Date(lastActivityTime);
  }
  const headerTime =
    typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
  return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const entries: FileEntry[] = [];
    let skipped = 0;
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as FileEntry);
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      logWarn(
        `buildSessionInfo: skipped ${skipped} malformed JSONL line(s) in ${filePath} — ` +
          `${entries.length} valid entries were loaded`,
      );
    }
    const header = entries[0];
    if (!header || header.type !== "session") {
      return null;
    }

    const stats = await stat(filePath);
    let messageCount = 0;
    let firstMessage = "";
    const allMessages: string[] = [];
    let name: string | undefined;
    for (const entry of entries) {
      if (entry.type === "session_info") {
        name = entry.name?.trim() || undefined;
      }
      if (entry.type !== "message") {
        continue;
      }
      messageCount += 1;
      const message = entry.message;
      if (
        !isMessageWithContent(message) ||
        (message.role !== "user" && message.role !== "assistant")
      ) {
        continue;
      }
      const textContent = extractTextContent(message);
      if (!textContent) {
        continue;
      }
      allMessages.push(textContent);
      if (!firstMessage && message.role === "user") {
        firstMessage = textContent;
      }
    }
    return {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath: header.parentSession,
      created: new Date(header.timestamp),
      modified: getSessionModifiedDate(entries, header, stats.mtime),
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      allMessagesText: allMessages.join(" "),
    };
  } catch {
    return null;
  }
}

async function listSessionsFromDir(
  dir: string,
  onProgress?: SessionListProgress,
  progressOffset = 0,
  progressTotal?: number,
  cwd?: string,
): Promise<SessionInfo[]> {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    const files = (await readdir(dir))
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => join(dir, file));
    const total = progressTotal ?? files.length;
    let loaded = 0;
    const sessions = await pMap(
      files,
      async (file) => {
        try {
          return (await buildSessionInfo(file)) ?? pMapSkip;
        } catch {
          return pMapSkip;
        } finally {
          loaded += 1;
          onProgress?.(progressOffset + loaded, total);
        }
      },
      { concurrency: MAX_CONCURRENT_SESSION_INFO_LOADS, stopOnError: false },
    );
    return sessions.filter((info) => cwd === undefined || info.cwd === cwd);
  } catch {
    return [];
  }
}

export async function listSessions(
  cwd: string,
  sessionDir: string,
  onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
  const sessions = await listSessionsFromDir(sessionDir, onProgress, 0, undefined, cwd);
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
}

export async function listAllSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
  try {
    const sessionsDir = getSessionsDir();
    if (!existsSync(sessionsDir)) {
      return [];
    }
    const directories = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsDir, entry.name));
    const directoryFiles: string[][] = [];
    let totalFiles = 0;
    for (const directory of directories) {
      try {
        const files = (await readdir(directory))
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => join(directory, file));
        directoryFiles.push(files);
        totalFiles += files.length;
      } catch {
        directoryFiles.push([]);
      }
    }

    let loaded = 0;
    const sessions = await pMap(
      directoryFiles.flat(),
      async (file) => {
        try {
          return (await buildSessionInfo(file)) ?? pMapSkip;
        } catch {
          return pMapSkip;
        } finally {
          loaded += 1;
          onProgress?.(loaded, totalFiles);
        }
      },
      { concurrency: MAX_CONCURRENT_SESSION_INFO_LOADS, stopOnError: false },
    );
    sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
    return sessions;
  } catch {
    return [];
  }
}
