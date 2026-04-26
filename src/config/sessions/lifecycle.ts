import fs from "node:fs";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionFilePathOptions,
} from "./paths.js";
import type { SessionEntry } from "./types.js";

type SessionLifecycleEntry = Pick<
  SessionEntry,
  "sessionId" | "sessionFile" | "sessionStartedAt" | "lastInteractionAt" | "updatedAt"
>;

function resolveTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return resolveTimestamp(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readFirstLine(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) {
        return undefined;
      }
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = chunk.indexOf("\n");
      return newline >= 0 ? chunk.slice(0, newline) : chunk;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function readSessionHeaderStartedAtMs(params: {
  entry: SessionLifecycleEntry | undefined;
  agentId?: string;
  storePath?: string;
  pathOptions?: SessionFilePathOptions;
}): number | undefined {
  const sessionId = params.entry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const pathOptions =
    params.pathOptions ??
    resolveSessionFilePathOptions({
      agentId: params.agentId,
      storePath: params.storePath,
    });
  let sessionFile: string;
  try {
    sessionFile = resolveSessionFilePath(sessionId, params.entry, pathOptions);
  } catch {
    return undefined;
  }
  const firstLine = readFirstLine(sessionFile);
  if (!firstLine) {
    return undefined;
  }
  try {
    const header = JSON.parse(firstLine) as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
    };
    if (header.type !== "session") {
      return undefined;
    }
    if (typeof header.id === "string" && header.id.trim() && header.id !== sessionId) {
      return undefined;
    }
    return parseTimestampMs(header.timestamp);
  } catch {
    return undefined;
  }
}

export function resolveSessionLifecycleTimestamps(params: {
  entry: SessionLifecycleEntry | undefined;
  agentId?: string;
  storePath?: string;
  pathOptions?: SessionFilePathOptions;
}): { sessionStartedAt?: number; lastInteractionAt?: number } {
  const entry = params.entry;
  if (!entry) {
    return {};
  }
  return {
    sessionStartedAt:
      resolveTimestamp(entry.sessionStartedAt) ??
      readSessionHeaderStartedAtMs({
        entry,
        agentId: params.agentId,
        storePath: params.storePath,
        pathOptions: params.pathOptions,
      }),
    lastInteractionAt: resolveTimestamp(entry.lastInteractionAt),
  };
}
