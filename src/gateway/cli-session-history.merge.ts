// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { CLAUDE_CLI_PROVIDER } from "./cli-session-history.claude.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
// Synthetic single-text assistant aggregates persisted for CLI backends carry
// this idempotency key prefix (see cli-run-transcript.ts). They duplicate the
// per-block native transcript imported from the CLI session.
const CLI_ASSISTANT_IDEMPOTENCY_PREFIX = "cli-assistant:";

function extractComparableText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { role?: unknown; text?: unknown; content?: unknown };
  const role = readStringValue(record.role);
  const parts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    parts.push(text);
  }
  const content = readStringValue(record.content);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (block && typeof block === "object" && "text" in block) {
        const blockText = readStringValue(block.text);
        if (blockText !== undefined) {
          parts.push(blockText);
        }
      }
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return undefined;
  }
  const visible = role === "user" ? stripInboundMetadata(joined) : joined;
  const normalized = visible.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function resolveComparableTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return asFiniteNumber((message as { timestamp?: unknown }).timestamp);
}

function resolveComparableRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return readStringValue((message as { role?: unknown }).role);
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
type ImportedExternalIdentity = {
  externalId: string;
  importedFrom?: string;
  cliSessionId?: string;
};

function resolveImportedExternalIdentity(message: unknown): ImportedExternalIdentity | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const meta =
    "__openclaw" in message &&
    (message as { __openclaw?: unknown })["__openclaw"] &&
    typeof (message as { __openclaw?: unknown })["__openclaw"] === "object"
      ? ((message as { __openclaw?: Record<string, unknown> })["__openclaw"] ?? {})
      : undefined;
  const externalId = normalizeOptionalString(meta?.externalId);
  return externalId
    ? {
        externalId,
        importedFrom: normalizeOptionalString(meta?.importedFrom),
        cliSessionId: normalizeOptionalString(meta?.cliSessionId),
      }
    : undefined;
}

function hasSameExternalIdentity(existing: unknown, imported: unknown): boolean | undefined {
  const importedIdentity = resolveImportedExternalIdentity(imported);
  const existingIdentity = resolveImportedExternalIdentity(existing);
  if (!importedIdentity || !existingIdentity) {
    return undefined;
  }
  return (
    importedIdentity.externalId === existingIdentity.externalId &&
    importedIdentity.importedFrom === existingIdentity.importedFrom &&
    importedIdentity.cliSessionId === existingIdentity.cliSessionId
  );
}

function resolveCliAssistantAggregateText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as {
    role?: unknown;
    idempotencyKey?: unknown;
    provider?: unknown;
  };
  if (readStringValue(record.role) !== "assistant") {
    return undefined;
  }
  // The cli-assistant idempotency prefix is shared by every CLI backend, but
  // this merger imports only Claude CLI history. Require the aggregate's
  // provider to match the imported source so a same-text aggregate from
  // another CLI backend is never deleted as if it were the imported turn.
  if (readStringValue(record.provider) !== CLAUDE_CLI_PROVIDER) {
    return undefined;
  }
  const idempotencyKey = normalizeOptionalString(record.idempotencyKey);
  if (!idempotencyKey?.startsWith(CLI_ASSISTANT_IDEMPOTENCY_PREFIX)) {
    return undefined;
  }
  return extractComparableText(message);
}

type ImportedAssistantTurn = {
  text: string;
  firstTimestamp?: number;
  lastTimestamp?: number;
  consumed: boolean;
};

// Groups imported native assistant blocks into turns (contiguous assistant
// runs between user messages) so an aggregate can be matched only against the
// exact native block sequence of its own CLI turn.
function buildImportedAssistantTurns(messages: unknown[]): ImportedAssistantTurn[] {
  const turns: ImportedAssistantTurn[] = [];
  let current: { parts: string[]; firstTimestamp?: number; lastTimestamp?: number } | undefined;
  const flush = () => {
    if (current && current.parts.length > 0) {
      turns.push({
        text: current.parts.join(" "),
        firstTimestamp: current.firstTimestamp,
        lastTimestamp: current.lastTimestamp,
        consumed: false,
      });
    }
    current = undefined;
  };
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = readStringValue((message as { role?: unknown }).role);
    if (role === "user") {
      flush();
      continue;
    }
    if (role !== "assistant" || !resolveImportedExternalIdentity(message)) {
      continue;
    }
    const text = extractComparableText(message);
    if (!text) {
      continue;
    }
    const timestamp = resolveComparableTimestamp(message);
    if (!current) {
      current = { parts: [], firstTimestamp: timestamp, lastTimestamp: timestamp };
    }
    current.parts.push(text);
    if (timestamp !== undefined) {
      current.firstTimestamp =
        current.firstTimestamp === undefined
          ? timestamp
          : Math.min(current.firstTimestamp, timestamp);
      current.lastTimestamp =
        current.lastTimestamp === undefined
          ? timestamp
          : Math.max(current.lastTimestamp, timestamp);
    }
  }
  flush();
  return turns;
}

// A synthetic aggregate covers one CLI turn: its normalized text must equal
// the concatenation of that turn's native blocks, and its write time must sit
// near the turn's block timestamps. Exact turn-local matching keeps unrelated
// imported turns (e.g. a later "not OK" reply) from consuming an "OK" fallback.
function findMatchingImportedTurn(
  turns: ImportedAssistantTurn[],
  aggregateText: string,
  aggregateTimestamp: number | undefined,
): ImportedAssistantTurn | undefined {
  for (const turn of turns) {
    if (turn.consumed || turn.text !== aggregateText) {
      continue;
    }
    if (
      aggregateTimestamp !== undefined &&
      turn.firstTimestamp !== undefined &&
      turn.lastTimestamp !== undefined &&
      (aggregateTimestamp < turn.firstTimestamp - DEDUPE_TIMESTAMP_WINDOW_MS ||
        aggregateTimestamp > turn.lastTimestamp + DEDUPE_TIMESTAMP_WINDOW_MS)
    ) {
      continue;
    }
    return turn;
  }
  return undefined;
}

function isEquivalentImportedMessage(existing: unknown, imported: unknown): boolean {
  // Text is a fallback only when either message lacks authoritative source identity.
  const sameExternalIdentity = hasSameExternalIdentity(existing, imported);
  if (sameExternalIdentity !== undefined) {
    return sameExternalIdentity;
  }

  const existingRole = resolveComparableRole(existing);
  const importedRole = resolveComparableRole(imported);
  if (!existingRole || existingRole !== importedRole) {
    return false;
  }

  const existingText = extractComparableText(existing);
  const importedText = extractComparableText(imported);
  if (!existingText || !importedText || existingText !== importedText) {
    return false;
  }

  const existingTimestamp = resolveComparableTimestamp(existing);
  const importedTimestamp = resolveComparableTimestamp(imported);
  if (existingTimestamp === undefined || importedTimestamp === undefined) {
    return true;
  }

  return Math.abs(existingTimestamp - importedTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS;
}

function compareHistoryMessages(
  a: { message: unknown; order: number },
  b: { message: unknown; order: number },
): number {
  const aTimestamp = resolveComparableTimestamp(a.message);
  const bTimestamp = resolveComparableTimestamp(b.message);
  if (aTimestamp !== undefined && bTimestamp !== undefined && aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
  }
  return a.order - b.order;
}

/** Merges imported CLI transcript messages into local history without duplicating overlaps. */
export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  const importedAssistantTurns = buildImportedAssistantTurns(params.importedMessages);
  const merged: { message: unknown; order: number }[] = [];
  params.localMessages.forEach((message, index) => {
    const aggregateText = resolveCliAssistantAggregateText(message);
    if (aggregateText) {
      // A cli-assistant aggregate is a synthetic single-text copy of one CLI
      // assistant turn. Prefer the proven overlapping imported native blocks:
      // drop the aggregate only when its own imported turn covers it exactly,
      // and retain it as fallback history otherwise.
      const match = findMatchingImportedTurn(
        importedAssistantTurns,
        aggregateText,
        resolveComparableTimestamp(message),
      );
      if (match) {
        match.consumed = true;
        return;
      }
    }
    merged.push({ message, order: index });
  });
  let nextOrder = merged.length;
  for (const imported of params.importedMessages) {
    if (merged.some((existing) => isEquivalentImportedMessage(existing.message, imported))) {
      continue;
    }
    merged.push({ message: imported, order: nextOrder });
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
