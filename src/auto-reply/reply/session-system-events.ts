import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.ts";
import { isExecCompletionEvent } from "../../infra/heartbeat-events-filter.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  type SystemEvent,
} from "../../infra/system-events.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

const selectGenericSystemEvents = (events: readonly SystemEvent[]): SystemEvent[] => {
  const selected: SystemEvent[] = [];
  for (const event of events) {
    if (!isExecCompletionEvent(event.text)) {
      selected.push(event);
    }
  }
  return selected;
};

/** Drain queued system events, format as `System:` lines, return the block (or undefined). */
export async function drainFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
}): Promise<string | undefined> {
  const compactSystemEvent = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    const lower = normalizeLowercaseStringOrEmpty(trimmed);
    if (lower.includes("reason periodic")) {
      return null;
    }
    // Filter out the actual heartbeat prompt, but not cron jobs that mention "heartbeat".
    // The heartbeat prompt starts with "Read HEARTBEAT.md" - cron payloads won't match this.
    if (lower.startsWith("read heartbeat.md")) {
      return null;
    }
    if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
      return null;
    }
    if (trimmed.startsWith("Node:")) {
      return trimmed.replace(/ · last input [^·]+/i, "").trim();
    }
    return trimmed;
  };

  const resolveSystemEventTimezone = (cfg: OpenClawConfig) => {
    const raw = normalizeOptionalString(cfg.agents?.defaults?.envelopeTimezone);
    if (!raw) {
      return { mode: "local" as const };
    }
    const lowered = normalizeLowercaseStringOrEmpty(raw);
    if (lowered === "utc" || lowered === "gmt") {
      return { mode: "utc" as const };
    }
    if (lowered === "local" || lowered === "host") {
      return { mode: "local" as const };
    }
    if (lowered === "user") {
      return {
        mode: "iana" as const,
        timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
      };
    }
    const explicit = resolveTimezone(raw);
    return explicit ? { mode: "iana" as const, timeZone: explicit } : { mode: "local" as const };
  };

  const formatSystemEventTimestamp = (ts: number, cfg: OpenClawConfig) => {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return "unknown-time";
    }
    const zone = resolveSystemEventTimezone(cfg);
    if (zone.mode === "utc") {
      return formatUtcTimestamp(date, { displaySeconds: true });
    }
    if (zone.mode === "local") {
      return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
    }
    return (
      formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ??
      "unknown-time"
    );
  };

  const summaryLines: string[] = [];
  const systemLines: string[] = [];
  // Exec completions have a dedicated heartbeat prompt; leave those entries queued
  // so the heartbeat path can consume and deliver them.
  const queued = consumeSelectedSystemEventEntries(
    params.sessionKey,
    selectGenericSystemEvents(peekSystemEventEntries(params.sessionKey)),
  );
  for (const event of queued) {
    const compacted = compactSystemEvent(event.text);
    if (!compacted) {
      continue;
    }
    const prefix = event.trusted === false ? "System (untrusted)" : "System";
    const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
    let index = 0;
    for (const subline of compacted.split("\n")) {
      systemLines.push(`${prefix}: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
      index += 1;
    }
  }
  if (params.isMainSession && params.isNewSession) {
    const summary = await buildChannelSummary(params.cfg);
    if (summary.length > 0) {
      for (const line of summary) {
        for (const subline of line.split("\n")) {
          summaryLines.push(`System: ${subline}`);
        }
      }
    }
  }
  if (summaryLines.length === 0 && systemLines.length === 0) {
    return undefined;
  }

  // Each sub-line gets its own prefix so continuation lines can't be mistaken
  // for regular user content.
  return summaryLines.length > 0
    ? [...summaryLines, ...systemLines].join("\n")
    : systemLines.join("\n");
}
