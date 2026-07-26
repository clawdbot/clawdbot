import {
  isExternalUserText,
  normalizeUserText,
  type SessionCatalogContinueProviderResult,
  type SessionUpstreamActivity,
  type SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENCODE_SESSION_ID_PATTERN } from "./session-catalog-shared.js";
import { exportOpenCodeSession, queryOpenCodeDatabase } from "./session-catalog.js";

type OpenCodeIndicator = {
  threadId: string;
  seq: number;
};
type OpenCodeExportPart = {
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  metadata?: Record<string, unknown>;
  mime?: string;
  filename?: string;
  sourceText?: {
    value: string;
    start: number;
    end: number;
  };
};
type OpenCodeExportMessage = {
  id: string;
  role: string;
  parts: OpenCodeExportPart[];
  createdAt?: number;
};
type OpenCodeMarker = {
  seq: number;
  lastHumanMessageId: string | null;
};

const OPENCODE_EXPORT_CONCURRENCY = 4;
const OPENCODE_REPLAY_LOOKBACK_USER_MESSAGES = 50;
const OPENCODE_SHELL_SENTINEL = "The following tool was executed by the user";

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function readProbeThreadId(probe: SessionUpstreamProbe): string | undefined {
  if (
    probe.hostId !== "gateway" ||
    probe.upstreamKind !== "opencode-cli" ||
    !isRecord(probe.upstreamRef) ||
    probe.upstreamRef.threadId !== probe.threadId ||
    !OPENCODE_SESSION_ID_PATTERN.test(probe.threadId)
  ) {
    return undefined;
  }
  return probe.threadId;
}

function readMarker(probe: SessionUpstreamProbe): OpenCodeMarker | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  return Number.isSafeInteger(probe.marker.seq) &&
    Number(probe.marker.seq) >= 0 &&
    (probe.marker.lastHumanMessageId === null ||
      typeof probe.marker.lastHumanMessageId === "string")
    ? {
        seq: Number(probe.marker.seq),
        lastHumanMessageId: probe.marker.lastHumanMessageId,
      }
    : undefined;
}

async function readIndicators(threadIds: string[]): Promise<Map<string, OpenCodeIndicator>> {
  if (threadIds.length === 0) {
    return new Map();
  }
  const query = [
    "SELECT s.id AS id, es.seq AS seq",
    "FROM session AS s",
    "LEFT JOIN event_sequence AS es ON es.aggregate_id = s.id",
    `WHERE s.id IN (${threadIds.map(sqlString).join(", ")})`,
  ].join(" ");
  const value = await queryOpenCodeDatabase(query);
  if (!Array.isArray(value)) {
    throw new Error("OpenCode returned invalid upstream indicators");
  }
  const indicators = new Map<string, OpenCodeIndicator>();
  for (const row of value) {
    const seq = isRecord(row) && row.seq === null ? 0 : isRecord(row) ? row.seq : undefined;
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !OPENCODE_SESSION_ID_PATTERN.test(row.id) ||
      !Number.isSafeInteger(seq) ||
      Number(seq) < 0
    ) {
      throw new Error("OpenCode returned invalid upstream indicators");
    }
    indicators.set(row.id, { threadId: row.id, seq: Number(seq) });
  }
  return indicators;
}

function readExportPart(value: unknown): OpenCodeExportPart | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  const sourceText =
    isRecord(value.source) &&
    isRecord(value.source.text) &&
    typeof value.source.text.value === "string" &&
    typeof value.source.text.start === "number" &&
    Number.isFinite(value.source.text.start) &&
    typeof value.source.text.end === "number" &&
    Number.isFinite(value.source.text.end)
      ? {
          value: value.source.text.value,
          start: value.source.text.start,
          end: value.source.text.end,
        }
      : undefined;
  return {
    type: value.type,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.synthetic === "boolean" ? { synthetic: value.synthetic } : {}),
    ...(typeof value.ignored === "boolean" ? { ignored: value.ignored } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    ...(typeof value.mime === "string" ? { mime: value.mime } : {}),
    ...(typeof value.filename === "string" ? { filename: value.filename } : {}),
    ...(sourceText ? { sourceText } : {}),
  };
}

function visibleTextPart(
  part: OpenCodeExportPart,
  sourceRanges: NonNullable<OpenCodeExportPart["sourceText"]>[],
): string | undefined {
  if (
    part.type !== "text" ||
    part.text === undefined ||
    part.synthetic === true ||
    part.ignored === true ||
    part.metadata?.compaction_continue === true
  ) {
    return undefined;
  }
  let text = part.text;
  for (const source of sourceRanges) {
    if (
      Number.isInteger(source.start) &&
      Number.isInteger(source.end) &&
      source.start >= 0 &&
      source.end >= source.start &&
      source.end <= text.length &&
      text.slice(source.start, source.end) === source.value
    ) {
      text = text.slice(0, source.start) + text.slice(source.end);
    }
  }
  return text;
}

function messageSourceRanges(
  message: OpenCodeExportMessage,
): NonNullable<OpenCodeExportPart["sourceText"]>[] {
  return message.parts
    .flatMap((part) => (part.sourceText ? [part.sourceText] : []))
    .toSorted((left, right) => right.start - left.start);
}

function visibleTextParts(message: OpenCodeExportMessage): string[] {
  const sourceRanges = messageSourceRanges(message);
  return message.parts.flatMap((part) => {
    const text = visibleTextPart(part, sourceRanges);
    return text === undefined ? [] : [text];
  });
}

function readExportMessages(value: unknown): OpenCodeExportMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("OpenCode returned an invalid session export");
  }
  return value.messages
    .flatMap((message): OpenCodeExportMessage[] => {
      if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) {
        return [];
      }
      const id = message.info.id;
      const role = message.info.role;
      if (typeof id !== "string" || typeof role !== "string") {
        return [];
      }
      const createdAt =
        isRecord(message.info.time) &&
        typeof message.info.time.created === "number" &&
        Number.isFinite(message.info.time.created)
          ? message.info.time.created
          : undefined;
      return [
        {
          id,
          role,
          parts: message.parts.flatMap((part) => {
            const parsed = readExportPart(part);
            return parsed ? [parsed] : [];
          }),
          ...(createdAt === undefined ? {} : { createdAt }),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        (left.createdAt ?? Number.NEGATIVE_INFINITY) -
          (right.createdAt ?? Number.NEGATIVE_INFINITY) || left.id.localeCompare(right.id),
    );
}

function normalizedMessageText(message: OpenCodeExportMessage): string | undefined {
  if (message.role !== "user") {
    return undefined;
  }
  const sourceRanges = messageSourceRanges(message);
  const texts = message.parts.flatMap((part) => {
    const visibleText = visibleTextPart(part, sourceRanges);
    if (visibleText !== undefined) {
      return [visibleText];
    }
    if (
      part.type === "file" &&
      part.mime !== undefined &&
      (part.mime.startsWith("image/") || part.mime === "application/pdf")
    ) {
      return [`[Attached ${part.mime}: ${part.filename ?? "file"}]`];
    }
    return [];
  });
  return texts.length > 0 ? normalizeUserText(texts.join("\n")) : undefined;
}

function directHumanText(message: OpenCodeExportMessage): string | undefined {
  if (
    message.role !== "user" ||
    message.parts.some((part) => part.type === "compaction") ||
    message.parts.some((part) => part.metadata?.compaction_continue === true)
  ) {
    return undefined;
  }
  const texts = visibleTextParts(message);
  if (texts.length === 0) {
    return undefined;
  }
  const text = normalizeUserText(texts.join("\n"));
  return !text || text === OPENCODE_SHELL_SENTINEL ? undefined : text;
}

function latestMessageId(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function latestBaselineHumanMessageId(messages: OpenCodeExportMessage[]): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    const text = directHumanText(message);
    if (text !== undefined) {
      latest = latestMessageId(latest, message.id);
    }
  }
  return latest;
}

function classifyExport(params: {
  probe: SessionUpstreamProbe;
  marker: OpenCodeMarker;
  seq: number;
  messages: OpenCodeExportMessage[];
}): SessionUpstreamActivity {
  let humanTurns = 0;
  let occurredAt: number | undefined;
  let lastHumanMessageId = params.marker.lastHumanMessageId;
  let latestExternalMessageId: string | undefined;
  const earlierUserTexts: Array<string | undefined> = [];
  for (const message of params.messages) {
    const text = directHumanText(message);
    const replay =
      text !== undefined &&
      earlierUserTexts.slice(-OPENCODE_REPLAY_LOOKBACK_USER_MESSAGES).includes(text);
    const newerThanMarker =
      params.marker.lastHumanMessageId === null || message.id > params.marker.lastHumanMessageId;
    if (text !== undefined && message.createdAt !== undefined && newerThanMarker) {
      // Consume complete user-shaped rows even when replay/self-echo filtering suppresses
      // them, so a later own-text window cannot turn an old row into new activity.
      lastHumanMessageId = latestMessageId(lastHumanMessageId, message.id);
    }
    if (
      text !== undefined &&
      !replay &&
      message.createdAt !== undefined &&
      newerThanMarker &&
      isExternalUserText(params.probe, text)
    ) {
      humanTurns += 1;
      occurredAt = Math.max(occurredAt ?? 0, message.createdAt);
      latestExternalMessageId = message.id;
    }
    if (message.role === "user") {
      earlierUserTexts.push(normalizedMessageText(message));
      if (earlierUserTexts.length > OPENCODE_REPLAY_LOOKBACK_USER_MESSAGES) {
        earlierUserTexts.shift();
      }
    }
  }
  const nextMarker = { seq: params.seq, lastHumanMessageId };
  return {
    kind: "activity",
    sessionKey: params.probe.sessionKey,
    humanTurns,
    nextMarker,
    ...(humanTurns > 0
      ? {
          occurredAt: occurredAt ?? Date.now(),
          dedupeId: latestExternalMessageId ?? String(params.seq),
        }
      : {}),
  };
}

export async function linkContinuedOpenCodeSession(
  sessionKey: string,
  threadId: string,
): Promise<SessionCatalogContinueProviderResult> {
  try {
    const indicator = (await readIndicators([threadId])).get(threadId);
    if (!indicator) {
      return { sessionKey };
    }
    const messages = readExportMessages(await exportOpenCodeSession(threadId));
    return {
      sessionKey,
      upstream: {
        kind: "opencode-cli",
        ref: { threadId },
        marker: {
          seq: indicator.seq,
          lastHumanMessageId: latestBaselineHumanMessageId(messages),
        },
      },
    };
  } catch {
    // Liveness metadata is optional; continuation success must survive baseline failure.
    return { sessionKey };
  }
}

async function classifyChangedProbe(
  probe: SessionUpstreamProbe,
  indicator: OpenCodeIndicator,
): Promise<SessionUpstreamActivity | undefined> {
  const marker = readMarker(probe);
  if (!marker || indicator.seq === marker.seq) {
    return undefined;
  }
  if (indicator.seq < marker.seq) {
    // OpenCode migrations may reset event_sequence while preserving the session.
    return {
      kind: "activity",
      sessionKey: probe.sessionKey,
      humanTurns: 0,
      nextMarker: { seq: indicator.seq, lastHumanMessageId: marker.lastHumanMessageId },
    };
  }
  return classifyExport({
    probe,
    marker,
    seq: indicator.seq,
    messages: readExportMessages(await exportOpenCodeSession(probe.threadId)),
  });
}

export async function checkOpenCodeUpstreamActivity(
  probes: SessionUpstreamProbe[],
): Promise<SessionUpstreamActivity[]> {
  const eligible = probes.flatMap((probe) => (readProbeThreadId(probe) ? [probe] : []));
  let indicators: Map<string, OpenCodeIndicator>;
  try {
    indicators = await readIndicators([...new Set(eligible.map((probe) => probe.threadId))]);
  } catch {
    // A failed batch read confirms nothing about whether any thread still exists.
    return [];
  }
  const outcomes = await mapConcurrent(
    eligible,
    OPENCODE_EXPORT_CONCURRENCY,
    async (probe): Promise<SessionUpstreamActivity | undefined> => {
      const indicator = indicators.get(probe.threadId);
      if (!indicator) {
        return { kind: "missing", sessionKey: probe.sessionKey };
      }
      try {
        return await classifyChangedProbe(probe, indicator);
      } catch {
        // Export failures are transient reads, not evidence that a thread was deleted.
        return undefined;
      }
    },
  );
  return outcomes.filter((outcome): outcome is SessionUpstreamActivity => outcome !== undefined);
}
