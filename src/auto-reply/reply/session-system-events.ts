// Records system-level session events for restarts, forks, and resets.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
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
import { acknowledgeSessionStateNotices } from "../../sessions/session-state-events.js";
import { decodeSessionStateNoticeContextKey } from "../../sessions/session-state-notices.js";

function isCronContextSystemEvent(event: SystemEvent): boolean {
  return event.contextKey?.startsWith("cron:") ?? false;
}

function selectGenericSystemEvents(
  events: readonly SystemEvent[],
  options?: { suppressHeartbeatOwnedEvents?: boolean },
): SystemEvent[] {
  // Exec completions and tagged cron events own dedicated heartbeat prompts
  // (buildExecEventPrompt / buildCronEventPrompt). During heartbeat runs, leave
  // cron entries queued for that owner; ordinary turns still drain them as the
  // fallback when a heartbeat was skipped before it could consume the event.
  return events.filter(
    (event) =>
      !isExecCompletionEvent(event.text) &&
      !(options?.suppressHeartbeatOwnedEvents === true && isCronContextSystemEvent(event)),
  );
}

function compactSystemEvent(line: string): string | null {
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
}

function resolveSystemEventTimezone(cfg: OpenClawConfig) {
  const raw = normalizeOptionalString(cfg.agents?.defaults?.userTimezone);
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
}

function formatSystemEventTimestamp(ts: number, cfg: OpenClawConfig) {
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
    formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ?? "unknown-time"
  );
}

/** Drain queued system events, format as `System:` lines, return the block text (or undefined). */
export async function drainFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
  suppressHeartbeatOwnedEvents?: boolean;
}): Promise<string | undefined> {
  const summaryLines: string[] = [];
  const systemLines: string[] = [];
  // Exec completions have a dedicated heartbeat prompt; leave those entries queued
  // so the heartbeat path can consume and deliver them.
  const queued = consumeSelectedSystemEventEntries(
    params.sessionKey,
    selectGenericSystemEvents(peekSystemEventEntries(params.sessionKey), {
      suppressHeartbeatOwnedEvents: params.suppressHeartbeatOwnedEvents,
    }),
  );
  const sessionStateTargets = queued
    .map((event) =>
      event.contextKey ? decodeSessionStateNoticeContextKey(event.contextKey) : undefined,
    )
    .filter((target): target is string => target !== undefined);
  if (sessionStateTargets.length > 0) {
    acknowledgeSessionStateNotices(params.sessionKey, sessionStateTargets);
  }
  for (const event of queued) {
    const compacted = compactSystemEvent(event.text);
    if (!compacted) {
      continue;
    }
    const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
    let index = 0;
    for (const subline of compacted.split("\n")) {
      systemLines.push(`System: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
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
