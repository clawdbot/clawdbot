import fs from "node:fs/promises";
import {
  classifyClaudeCliHistoryMessage,
  classifyClaudeCliHistoryLine,
  type SessionCatalogContinueProviderResult,
  type SessionUpstreamActivity,
  type SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

export const MAX_CLAUDE_UPSTREAM_SCAN_BYTES = 1024 * 1024;
export const continueOperations = new Map<string, Promise<{ sessionKey: string }>>();

export async function link(
  sessionKey: string,
  hostId: string,
  threadId: string,
  listSessions: () => Promise<Array<{ threadId: string; filePath: string }>>,
): Promise<SessionCatalogContinueProviderResult> {
  if (hostId !== "gateway:local") {
    return { sessionKey };
  }
  try {
    const record = (await listSessions()).find((candidate) => candidate.threadId === threadId);
    const stat = record ? await fs.stat(record.filePath).catch(() => undefined) : undefined;
    return record && stat?.isFile()
      ? {
          sessionKey,
          upstream: {
            kind: "claude-cli",
            ref: { filePath: record.filePath },
            marker: { offset: stat.size },
          },
        }
      : { sessionKey };
  } catch {
    // Liveness metadata is optional; continuation success must survive baseline failure.
    return { sessionKey };
  }
}

export function linkRemote(
  sessionKey: string,
  nodeId: string,
  threadId: string,
  markerUuid: string | null,
): SessionCatalogContinueProviderResult {
  return {
    sessionKey,
    upstream: {
      kind: "claude-cli",
      ref: { nodeId, threadId },
      marker: { uuid: markerUuid },
    },
  };
}

export async function linkContinued(params: {
  sessionKey: string;
  hostId: string;
  threadId: string;
  history?: ClaudeTranscriptItem[];
  listLocalSessions: () => Promise<Array<{ threadId: string; filePath: string }>>;
  readRemote: () => Promise<ClaudeTranscriptItem[]>;
}): Promise<SessionCatalogContinueProviderResult> {
  if (params.hostId === "gateway:local") {
    return await link(params.sessionKey, params.hostId, params.threadId, params.listLocalSessions);
  }
  if (!params.hostId.startsWith("node:")) {
    return { sessionKey: params.sessionKey };
  }
  try {
    const items = params.history ?? (await params.readRemote());
    const newest = items[0];
    // A UUID-less newest item cannot anchor a baseline distinguishable from an empty
    // thread, which would later replay pre-adoption history as new activity. Decline
    // the link; empty history (no newest) still baselines safely as null.
    if (newest && !newest.uuid) {
      return { sessionKey: params.sessionKey };
    }
    return linkRemote(
      params.sessionKey,
      params.hostId.slice("node:".length),
      params.threadId,
      newest?.uuid ?? null,
    );
  } catch {
    return { sessionKey: params.sessionKey };
  }
}

function readFilePath(probe: SessionUpstreamProbe): string | undefined {
  return isRecord(probe.upstreamRef) && typeof probe.upstreamRef.filePath === "string"
    ? probe.upstreamRef.filePath
    : undefined;
}

function readMarkerOffset(probe: SessionUpstreamProbe): number | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  const offset = probe.marker.offset ?? probe.marker.size;
  return Number.isSafeInteger(offset) && (offset as number) >= 0 ? (offset as number) : undefined;
}

function normalizeUserText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isExternalUserText(probe: SessionUpstreamProbe, text: string | undefined): boolean {
  const normalized = text === undefined ? "" : normalizeUserText(text);
  return !probe.ownRecentUserTexts.includes(normalized);
}

export async function checkClaudeSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
): Promise<SessionUpstreamActivity | undefined> {
  if (probe.upstreamKind !== "claude-cli") {
    return undefined;
  }
  const filePath = readFilePath(probe);
  const markerOffset = readMarkerOffset(probe);
  if (!filePath || markerOffset === undefined) {
    return undefined;
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT"
      ? { kind: "missing", sessionKey: probe.sessionKey }
      : undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { kind: "missing", sessionKey: probe.sessionKey };
    }
    if (stat.size <= markerOffset) {
      return undefined;
    }
    const readLength = Math.min(stat.size - markerOffset, MAX_CLAUDE_UPSTREAM_SCAN_BYTES);
    const buffer = Buffer.allocUnsafe(readLength);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, markerOffset);
    const tail = buffer.subarray(0, bytesRead);
    const lastNewline = tail.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // Cursor movement requires a complete classified row. A row beyond the
      // fixed per-tick cap stays deferred rather than skipping unknown bytes.
      return undefined;
    }
    const completeTail = tail.subarray(0, lastNewline + 1);
    let humanTurns = 0;
    let occurredAt: number | undefined;
    for (const [lineIndex, line] of completeTail.toString("utf8").split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }
      const classification = classifyClaudeCliHistoryLine({
        line,
        cliSessionId: probe.threadId,
        sourceLineNumber: lineIndex + 1,
      });
      if (!classification.humanTurn || !isExternalUserText(probe, classification.userText)) {
        continue;
      }
      humanTurns += 1;
      occurredAt = Math.max(occurredAt ?? 0, classification.occurredAt ?? stat.mtimeMs);
    }
    const nextOffset = markerOffset + lastNewline + 1;
    return {
      kind: "activity",
      sessionKey: probe.sessionKey,
      humanTurns,
      nextMarker: { offset: nextOffset },
      ...(humanTurns > 0
        ? { occurredAt: occurredAt ?? stat.mtimeMs, dedupeId: String(nextOffset) }
        : {}),
    };
  } finally {
    await handle.close();
  }
}

function readMarkerUuid(probe: SessionUpstreamProbe): string | null | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  return probe.marker.uuid === null || typeof probe.marker.uuid === "string"
    ? probe.marker.uuid
    : undefined;
}

async function checkRemoteClaudeSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
  readRemote: (probe: SessionUpstreamProbe) => Promise<ClaudeTranscriptItem[]>,
): Promise<SessionUpstreamActivity | undefined> {
  if (
    !isRecord(probe.upstreamRef) ||
    typeof probe.upstreamRef.nodeId !== "string" ||
    probe.hostId !== `node:${probe.upstreamRef.nodeId}`
  ) {
    return undefined;
  }
  const markerUuid = readMarkerUuid(probe);
  if (markerUuid === undefined) {
    return undefined;
  }
  const items = await readRemote(probe);
  const markerIndex =
    markerUuid === null ? -1 : items.findIndex((item) => item.uuid === markerUuid);
  const newItems = markerIndex < 0 ? items : items.slice(0, markerIndex);
  const newest = newItems[0];
  if (!newest?.uuid) {
    return undefined;
  }
  let humanTurns = 0;
  let occurredAt: number | undefined;
  for (const [itemIndex, item] of newItems.entries()) {
    if (item.type !== "userMessage") {
      continue;
    }
    const classification = classifyClaudeCliHistoryMessage({
      content: item.content ?? item.text,
      timestamp: item.timestamp,
      cliSessionId: probe.threadId,
      sourceLineNumber: itemIndex + 1,
    });
    if (!classification.humanTurn || !isExternalUserText(probe, classification.userText)) {
      continue;
    }
    humanTurns += 1;
    occurredAt = Math.max(occurredAt ?? 0, classification.occurredAt ?? Date.now());
  }
  const activityId = newest.uuid;
  return {
    kind: "activity",
    sessionKey: probe.sessionKey,
    humanTurns,
    nextMarker: { uuid: activityId },
    ...(humanTurns > 0 ? { occurredAt: occurredAt ?? Date.now(), dedupeId: activityId } : {}),
  };
}

export async function checkClaudeUpstreamActivity(
  probes: SessionUpstreamProbe[],
  readRemote?: (probe: SessionUpstreamProbe) => Promise<ClaudeTranscriptItem[]>,
): Promise<SessionUpstreamActivity[]> {
  const activities: SessionUpstreamActivity[] = [];
  for (const probe of probes) {
    try {
      const activity = readFilePath(probe)
        ? await checkClaudeSessionUpstreamActivity(probe)
        : readRemote
          ? await checkRemoteClaudeSessionUpstreamActivity(probe, readRemote)
          : undefined;
      if (activity) {
        activities.push(activity);
      }
    } catch {
      // One missing transcript must not suppress healthy sessions in the provider batch.
    }
  }
  return activities;
}
