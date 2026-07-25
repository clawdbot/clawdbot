import {
  isExternalUserText,
  type SessionCatalogContinueProviderResult,
  type SessionUpstreamActivity,
  type SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENCODE_SESSION_ID_PATTERN } from "./session-catalog-shared.js";
import { exportOpenCodeSession, queryOpenCodeDatabase } from "./session-catalog.js";

type OpenCodeIndicator = {
  threadId: string;
  lastMessageId: string | null;
  lastMessageCreatedAt: number | null;
  lastMessageRole: string | null;
  sessionUpdatedAt: number;
};
type OpenCodeExportMessage = {
  id: string;
  role: string;
  hasParts: boolean;
  userText?: string;
  replayFingerprint?: string;
  createdAt?: number;
  systemGenerated: boolean;
  overflowCompaction: boolean;
};
type OpenCodeMarker = {
  messageId: string | null;
  createdAt: number | null;
  sessionUpdatedAt: number;
};

const OPENCODE_EMPTY_USER_ROW_GRACE_MS = 2 * 60_000;
const OPENCODE_EXPORT_CONCURRENCY = 4;

function markerFromMessage(
  message: OpenCodeExportMessage | undefined,
  sessionUpdatedAt: number,
): OpenCodeMarker {
  if (!message || message.createdAt === undefined) {
    return { messageId: null, createdAt: null, sessionUpdatedAt };
  }
  return {
    messageId: message.id,
    createdAt: message.createdAt,
    sessionUpdatedAt,
  };
}

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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function replayPartFingerprint(part: Record<string, unknown>): string {
  const normalized =
    part.type === "file" &&
    typeof part.mime === "string" &&
    (part.mime.startsWith("image/") || part.mime === "application/pdf")
      ? {
          type: "text",
          text: `[Attached ${part.mime}: ${typeof part.filename === "string" ? part.filename : "file"}]`,
        }
      : Object.fromEntries(
          Object.entries(part).filter(
            ([key]) => key !== "id" && key !== "messageID" && key !== "sessionID",
          ),
        );
  return stableJson(normalized);
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
  if (
    probe.marker.messageId === null &&
    probe.marker.createdAt === null &&
    typeof probe.marker.sessionUpdatedAt === "number" &&
    Number.isFinite(probe.marker.sessionUpdatedAt)
  ) {
    return {
      messageId: null,
      createdAt: null,
      sessionUpdatedAt: probe.marker.sessionUpdatedAt,
    };
  }
  return typeof probe.marker.messageId === "string" &&
    typeof probe.marker.createdAt === "number" &&
    Number.isFinite(probe.marker.createdAt) &&
    typeof probe.marker.sessionUpdatedAt === "number" &&
    Number.isFinite(probe.marker.sessionUpdatedAt)
    ? {
        messageId: probe.marker.messageId,
        createdAt: probe.marker.createdAt,
        sessionUpdatedAt: probe.marker.sessionUpdatedAt,
      }
    : undefined;
}

async function readIndicators(threadIds: string[]): Promise<Map<string, OpenCodeIndicator>> {
  if (threadIds.length === 0) {
    return new Map();
  }
  const query = [
    "SELECT s.id AS id, s.time_updated AS sessionUpdatedAt,",
    "m.id AS lastMessageId, m.time_created AS lastMessageCreatedAt,",
    "json_extract(m.data, '$.role') AS lastMessageRole",
    "FROM session AS s",
    "LEFT JOIN message AS m ON m.id = (SELECT latest.id FROM message AS latest",
    "WHERE latest.session_id = s.id",
    "ORDER BY latest.time_created DESC, latest.id DESC LIMIT 1)",
    `WHERE s.id IN (${threadIds.map(sqlString).join(", ")})`,
  ].join(" ");
  const value = await queryOpenCodeDatabase(query);
  if (!Array.isArray(value)) {
    throw new Error("OpenCode returned invalid upstream indicators");
  }
  const indicators = new Map<string, OpenCodeIndicator>();
  for (const row of value) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !OPENCODE_SESSION_ID_PATTERN.test(row.id) ||
      (row.lastMessageId !== null && typeof row.lastMessageId !== "string") ||
      (row.lastMessageCreatedAt !== null &&
        (typeof row.lastMessageCreatedAt !== "number" ||
          !Number.isFinite(row.lastMessageCreatedAt))) ||
      (row.lastMessageId === null) !== (row.lastMessageCreatedAt === null) ||
      (row.lastMessageRole !== null && typeof row.lastMessageRole !== "string") ||
      typeof row.sessionUpdatedAt !== "number" ||
      !Number.isFinite(row.sessionUpdatedAt)
    ) {
      throw new Error("OpenCode returned invalid upstream indicators");
    }
    indicators.set(row.id, {
      threadId: row.id,
      lastMessageId: row.lastMessageId,
      lastMessageCreatedAt: row.lastMessageCreatedAt,
      lastMessageRole: row.lastMessageRole,
      sessionUpdatedAt: row.sessionUpdatedAt,
    });
  }
  return indicators;
}

function readExportMessages(value: unknown): OpenCodeExportMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("OpenCode returned an invalid session export");
  }
  const messages = value.messages.flatMap((message): OpenCodeExportMessage[] => {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) {
      return [];
    }
    const id = message.info.id;
    const role = message.info.role;
    if (typeof id !== "string" || typeof role !== "string") {
      return [];
    }
    const meaningfulParts = message.parts.filter(
      (part) =>
        isRecord(part) &&
        part.type !== "compaction" &&
        part.synthetic !== true &&
        !(part.type === "text" && part.ignored === true) &&
        !(isRecord(part.metadata) && part.metadata.compaction_continue === true),
    );
    const userText = meaningfulParts
      .flatMap((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n");
    const replayFingerprint = meaningfulParts.map(replayPartFingerprint).join("\n");
    const createdAt =
      isRecord(message.info.time) &&
      typeof message.info.time.created === "number" &&
      Number.isFinite(message.info.time.created)
        ? message.info.time.created
        : undefined;
    const compactionPart = message.parts.find(
      (part) => isRecord(part) && part.type === "compaction",
    );
    const compactionContinuation = message.parts.some(
      (part) =>
        isRecord(part) && isRecord(part.metadata) && part.metadata.compaction_continue === true,
    );
    // OpenCode exports no provenance field that separates internal synthetic-only
    // injections from resolved resource prompts. They are classifiable but not human.
    const systemGenerated =
      role === "user" &&
      (compactionPart !== undefined || compactionContinuation || meaningfulParts.length === 0);
    return [
      {
        id,
        role,
        hasParts: message.parts.length > 0,
        ...(userText ? { userText } : {}),
        ...(replayFingerprint ? { replayFingerprint } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        systemGenerated,
        overflowCompaction:
          isRecord(compactionPart) &&
          compactionPart.auto === true &&
          compactionPart.overflow === true,
      },
    ];
  });
  let lastUserFingerprint: string | undefined;
  let overflowReplayFingerprint: string | undefined;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (message.overflowCompaction) {
      overflowReplayFingerprint = lastUserFingerprint;
      continue;
    }
    if (message.systemGenerated) {
      overflowReplayFingerprint = undefined;
      continue;
    }
    if (overflowReplayFingerprint && message.replayFingerprint === overflowReplayFingerprint) {
      message.systemGenerated = true;
    }
    overflowReplayFingerprint = undefined;
    if (!message.systemGenerated && message.replayFingerprint) {
      lastUserFingerprint = message.replayFingerprint;
    }
  }
  return messages;
}

function messagesAfterMarker(
  messages: OpenCodeExportMessage[],
  marker: OpenCodeMarker,
): OpenCodeExportMessage[] | undefined {
  if (marker.messageId === null) {
    return messages;
  }
  const markerIndex = messages.findIndex((message) => message.id === marker.messageId);
  if (markerIndex >= 0) {
    return messages.slice(markerIndex + 1);
  }
  if (marker.createdAt === null) {
    return undefined;
  }
  // Revert cleanup can delete the marker. OpenCode orders messages by
  // (time_created, id), so the same tuple safely separates replacement turns.
  return messages.filter(
    (message) =>
      message.createdAt !== undefined &&
      (message.createdAt > marker.createdAt ||
        (message.createdAt === marker.createdAt && message.id > marker.messageId)),
  );
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
    let marker: OpenCodeMarker = {
      messageId: indicator.lastMessageId,
      createdAt: indicator.lastMessageCreatedAt,
      sessionUpdatedAt: indicator.sessionUpdatedAt,
    };
    if (indicator.lastMessageRole === "user" && indicator.lastMessageId !== null) {
      const messages = readExportMessages(await exportOpenCodeSession(threadId));
      const indicatorIndex = messages.findIndex(
        (message) => message.id === indicator.lastMessageId,
      );
      if (indicatorIndex < 0) {
        return { sessionKey };
      }
      const indicatorMessage = messages[indicatorIndex];
      if (
        indicatorMessage?.role === "user" &&
        !indicatorMessage.hasParts &&
        indicator.lastMessageCreatedAt !== null &&
        Date.now() - indicator.lastMessageCreatedAt < OPENCODE_EMPTY_USER_ROW_GRACE_MS
      ) {
        marker = markerFromMessage(messages[indicatorIndex - 1], indicator.sessionUpdatedAt);
      }
    }
    return {
      sessionKey,
      upstream: {
        kind: "opencode-cli",
        ref: { threadId },
        marker,
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
  if (
    !marker ||
    (indicator.lastMessageId === marker.messageId &&
      indicator.sessionUpdatedAt === marker.sessionUpdatedAt)
  ) {
    return undefined;
  }
  const nextMarker = {
    messageId: indicator.lastMessageId,
    createdAt: indicator.lastMessageCreatedAt,
    sessionUpdatedAt: indicator.sessionUpdatedAt,
  };
  if (indicator.lastMessageId === null) {
    return {
      kind: "activity",
      sessionKey: probe.sessionKey,
      humanTurns: 0,
      nextMarker,
    };
  }
  if (indicator.lastMessageId === marker.messageId) {
    return {
      kind: "activity",
      sessionKey: probe.sessionKey,
      humanTurns: 0,
      nextMarker,
    };
  }
  const messages = readExportMessages(await exportOpenCodeSession(probe.threadId));
  const indicatorIndex = messages.findIndex((message) => message.id === indicator.lastMessageId);
  if (indicatorIndex < 0) {
    return undefined;
  }
  const indicatorMessage = messages[indicatorIndex];
  if (
    indicator.lastMessageRole === "user" &&
    indicatorMessage?.role === "user" &&
    !indicatorMessage.hasParts &&
    indicator.lastMessageCreatedAt !== null &&
    Date.now() - indicator.lastMessageCreatedAt < OPENCODE_EMPTY_USER_ROW_GRACE_MS
  ) {
    // OpenCode v1.18 projects the user message and each part as separate durable events.
    // Wait two monitor cadences for normal projection, then advance an orphaned empty row.
    return undefined;
  }
  const newMessages = messagesAfterMarker(messages.slice(0, indicatorIndex + 1), marker);
  if (!newMessages) {
    return undefined;
  }
  if (newMessages.length === 0) {
    return {
      kind: "activity",
      sessionKey: probe.sessionKey,
      humanTurns: 0,
      nextMarker,
    };
  }
  const nextMessage = newMessages.at(-1);
  if (nextMessage?.createdAt === undefined) {
    return undefined;
  }
  let humanTurns = 0;
  let occurredAt: number | undefined;
  for (const message of newMessages) {
    if (
      message.role !== "user" ||
      !message.hasParts ||
      message.systemGenerated ||
      !isExternalUserText(probe, message.userText)
    ) {
      continue;
    }
    humanTurns += 1;
    occurredAt = Math.max(occurredAt ?? 0, message.createdAt ?? Date.now());
  }
  return {
    kind: "activity",
    sessionKey: probe.sessionKey,
    humanTurns,
    nextMarker,
    ...(humanTurns > 0 ? { occurredAt: occurredAt ?? Date.now(), dedupeId: nextMessage.id } : {}),
  };
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
