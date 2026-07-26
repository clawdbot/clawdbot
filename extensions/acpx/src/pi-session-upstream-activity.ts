import fs from "node:fs/promises";
import process from "node:process";
import {
  isExternalUserText,
  type SessionCatalogContinueProviderResult,
  type SessionUpstreamActivity,
  type SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readPiSessionFileBaseline } from "./pi-session-store.js";

const MAX_PI_UPSTREAM_SCAN_BYTES = 1024 * 1024;

function parseCompletePiRows(tail: Buffer): {
  entries: Record<string, unknown>[];
  classifiedBytes: number;
} {
  const entries: Record<string, unknown>[] = [];
  let lineStart = 0;
  let classifiedBytes = 0;
  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index] !== 0x0a) {
      continue;
    }
    const line = tail.subarray(lineStart, index).toString("utf8").trim();
    if (line) {
      try {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value)) {
          break;
        }
        entries.push(value);
      } catch {
        break;
      }
    }
    classifiedBytes = index + 1;
    lineStart = index + 1;
  }
  return { entries, classifiedBytes };
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
  return text || undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function readFilePath(probe: SessionUpstreamProbe): string | undefined {
  return isRecord(probe.upstreamRef) && typeof probe.upstreamRef.filePath === "string"
    ? probe.upstreamRef.filePath
    : undefined;
}

function readMarkerOffset(probe: SessionUpstreamProbe): number | undefined {
  return isRecord(probe.marker) &&
    Number.isSafeInteger(probe.marker.offset) &&
    Number(probe.marker.offset) >= 0
    ? Number(probe.marker.offset)
    : undefined;
}

export async function linkContinuedPiSession(
  sessionKey: string,
  threadId: string,
): Promise<SessionCatalogContinueProviderResult> {
  try {
    const baseline = await readPiSessionFileBaseline(threadId, process.env);
    // Legacy Pi versions rewrite during first resume, so the store helper declines
    // those links. Current v3 sessions persist by appending to this exact file.
    return baseline
      ? {
          sessionKey,
          upstream: {
            kind: "pi-cli",
            ref: { filePath: baseline.filePath },
            marker: { offset: baseline.offset },
          },
        }
      : { sessionKey };
  } catch {
    // Liveness metadata is optional; continuation success must survive baseline failure.
    return { sessionKey };
  }
}

async function checkPiSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
): Promise<SessionUpstreamActivity | undefined> {
  if (probe.hostId !== "gateway" || probe.upstreamKind !== "pi-cli") {
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
    const readLength = Math.min(stat.size - markerOffset, MAX_PI_UPSTREAM_SCAN_BYTES);
    const buffer = Buffer.allocUnsafe(readLength);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, markerOffset);
    const tail = buffer.subarray(0, bytesRead);
    const { entries, classifiedBytes } = parseCompletePiRows(tail);
    if (classifiedBytes === 0) {
      // Never advance past an invalid, partial, or over-cap JSONL row.
      return undefined;
    }
    let humanTurns = 0;
    let occurredAt: number | undefined;
    for (const entry of entries) {
      if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") {
        continue;
      }
      const text = textFromContent(entry.message.content);
      if (!isExternalUserText(probe, text)) {
        continue;
      }
      humanTurns += 1;
      occurredAt = Math.max(
        occurredAt ?? 0,
        timestampMs(entry.message.timestamp) ?? timestampMs(entry.timestamp) ?? stat.mtimeMs,
      );
    }
    const nextOffset = markerOffset + classifiedBytes;
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

export async function checkPiUpstreamActivity(
  probes: SessionUpstreamProbe[],
): Promise<SessionUpstreamActivity[]> {
  const outcomes: SessionUpstreamActivity[] = [];
  for (const probe of probes) {
    try {
      const outcome = await checkPiSessionUpstreamActivity(probe);
      if (outcome) {
        outcomes.push(outcome);
      }
    } catch {
      // One transient file read must not suppress healthy sessions in the batch.
    }
  }
  return outcomes;
}
