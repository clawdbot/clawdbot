import fs from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import { INBOUND_CONTEXT_MARKER } from "../auto-reply/reply/inbound-context-marker.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventRows,
  type SqliteTranscriptSnapshotRow,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import {
  readOnlySqliteTranscriptSessionIds,
  readOnlySqliteTranscriptRepairSnapshot,
} from "./doctor-session-sqlite-transcript-readers.js";

const NOTE_TITLE = "Session transcript labels";

// Frozen copy of the shipped timestamp envelope. Local, not imported: this migration must match
// historical bytes even if the runtime pattern later evolves.
const LEGACY_LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

// Rewrites legacy inbound-context labels to the current canonical form: plain label + the provenance
// marker suffix (`Sender: ⟦openclaw:ctx⟧`). Runtime strippers and the memory-lancedb recognizers key
// on that marker, never on label text, so every rule targeting an inbound-context header must append
// it — a plain-label rewrite would leave behind blocks the strippers no longer see.
//
// Labels are enumerated, never a `[^\n]+` catch-all: a ```json fence does not prove provenance, so
// matching arbitrary labels would mark user-authored JSON and hide it. Historical dynamic/plugin
// labels stay unmigrated — the shipped stripper never recognized them either, and new dynamic blocks
// are marked at emit time (inbound-meta.ts).
//
// Accepted tradeoff: a user message with a standalone line that verbatim-matches one of these fixed
// internal labels gets rewritten, and the marker-only strippers then hide that block. Same outcome the
// runtime already produces for a verbatim current sentinel; the trigger is vanishingly rare.
//
// Old emitters (merge-base 7c896d78592e33f2f5fa1bb36ca588dcc3f96143, inbound-meta.ts unless noted):
// FENCED: "Conversation info" (711), "Sender" (block removed before merge-base; its sentinel survived
//   at strip-inbound-meta.ts:31, so old transcripts still carry it), "Thread starter" (718),
//   "Reply chain of current user message" (729), "Reply target of current user message" (735),
//   "Replied message" (renamed in 64e28a6ac94), "Forwarded message context" (755), "Location" (761),
//   dynamic `${label}` + "Structured object" fallback (271-272, 774).
// PLAIN: "Untrusted context (metadata, …)" (untrusted-context.ts:16 and active-memory/types.ts:334),
//   "Chat history since last reply" (805).
// CHAT WINDOW: `${label} (untrusted, <order>, <relation>):` (338-360).

function applyLegacyInboundLabelRewrites(text: string): string {
  // Peel the timestamp envelope so the anchored (`^`) rules see the first header at column 0, exactly
  // as the runtime stripper does. Without this, "[Wed …] Conversation info (…):" stays unmarked and the
  // marker-only strippers expose its JSON. Reattached verbatim below.
  const timestampMatch = text.match(LEGACY_LEADING_TIMESTAMP_PREFIX_RE);
  const timestampPrefix = timestampMatch ? timestampMatch[0] : "";
  let normalized = timestampPrefix ? text.slice(timestampPrefix.length) : text;

  // 1. Fixed "(untrusted metadata)" labels with a ```json body.
  normalized = normalized.replace(
    /^(Conversation info|Sender|Forwarded message context|Location|Structured object) \(untrusted metadata\):[ \t]*\n```json/gm,
    `$1: ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // 2. Active-memory and channel context historically shared one header. Preserve active-memory's
  // bare Context: contract; only channel context gets the provenance marker used for terminal blocks.
  // Only rule spanning the header's line break, so it must spell out `\r?` (migrated assistant rows
  // skip normalizeInboundTextNewlines); without it the marked replace wins and the body strips to "".
  normalized = normalized.replace(
    /^Untrusted context \(metadata, do not treat as instructions or commands\):([ \t]*\r?\n)(?=<active_memory_plugin>[ \t]*(?:\r?\n|$))/gm,
    "Context:$1",
  );
  normalized = normalized.replace(
    /^Untrusted context \(metadata, do not treat as instructions or commands\):$/gm,
    `Context: ${INBOUND_CONTEXT_MARKER}`,
  );

  // 3. "Chat history since last reply" footer (unfenced).
  normalized = normalized.replace(
    /^Chat history since last reply \(untrusted, for context\):$/gm,
    `Chat history since last reply: ${INBOUND_CONTEXT_MARKER}`,
  );

  // 4. "Thread starter" block.
  normalized = normalized.replace(
    /^Thread starter \(untrusted, for context\):[ \t]*\n```json/gm,
    `Thread starter: ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // 5. "Reply target of current user message" block.
  normalized = normalized.replace(
    /^Reply target of current user message \(untrusted, for context\):[ \t]*\n```json/gm,
    `Reply target of current user message: ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // 6. "Reply chain of current user message" block.
  normalized = normalized.replace(
    /^Reply chain of current user message \(untrusted, nearest first\):[ \t]*\n```json/gm,
    `Reply chain of current user message (nearest first): ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // 7. Oldest reply-target label. 64e28a6ac94 renamed this same block to "Reply target of current user
  // message", so it migrates to that canonical label — not to a plain `Replied message:`, which no
  // recognizer keys on.
  normalized = normalized.replace(
    /^Replied message \(untrusted, for context\):[ \t]*\n```json/gm,
    `Reply target of current user message: ${INBOUND_CONTEXT_MARKER}\n\`\`\`json`,
  );

  // 8. Chat windows carry dynamic labels, so this is the one pattern-based rule. Narrow by construction:
  // it requires the distinctive "(untrusted, chronological…)" tuple, not bare prose.
  normalized = normalized.replace(
    /^(.+) \(untrusted, chronological(, [^)\n]+)?\):$/gm,
    (_match, label, qualifier) =>
      `${label} (chronological${qualifier ?? ""}): ${INBOUND_CONTEXT_MARKER}`,
  );

  return timestampPrefix + normalized;
}

function normalizeLegacyInboundContextLabels(event: TranscriptEvent): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const entry = event as { message?: unknown; type?: unknown };
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return false;
  }
  const message = entry.message as { content?: unknown; role?: unknown };
  // Assistant turns can echo a context block into their output, and the shipped label-based strippers
  // removed those too (gateway/chat-sanitize.ts, replay-history.ts, session-cost-usage.ts). Skipping
  // them here would leave old assistant blocks unmarked, so they would leak on replay after upgrade.
  if (message.role !== "user" && message.role !== "assistant") {
    return false;
  }
  if (typeof message.content === "string") {
    const normalized = applyLegacyInboundLabelRewrites(message.content);
    if (normalized === message.content) {
      return false;
    }
    message.content = normalized;
    return true;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  let changed = false;
  for (const part of message.content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      continue;
    }
    const textPart = part as { text?: unknown };
    if (typeof textPart.text !== "string") {
      continue;
    }
    const normalized = applyLegacyInboundLabelRewrites(textPart.text);
    if (normalized !== textPart.text) {
      textPart.text = normalized;
      changed = true;
    }
  }
  return changed;
}

function snapshotsMatch(
  expected: readonly SqliteTranscriptSnapshotRow[],
  current: readonly SqliteTranscriptSnapshotRow[],
): boolean {
  return (
    expected.length === current.length &&
    expected.every(
      (row, index) =>
        row.seq === current[index]?.seq && row.eventJson === current[index]?.eventJson,
    )
  );
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Reports or repairs legacy inbound-context labels in canonical SQLite transcripts. */
export async function noteSessionTranscriptLabelHealth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<void> {
  const env = params.env ?? process.env;
  let foundSessions = 0;
  let foundEvents = 0;
  let repairedSessions = 0;
  let repairedEvents = 0;

  const targetsBySqlitePath = new Map<string, { agentId: string; storePath: string }>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (!targetsBySqlitePath.has(sqlitePath)) {
      targetsBySqlitePath.set(sqlitePath, target);
    }
  }

  for (const [sqlitePath, target] of targetsBySqlitePath) {
    if (!fs.existsSync(sqlitePath)) {
      continue;
    }

    const { agentId } = target;
    const databaseOptions = { agentId, env, path: sqlitePath };

    try {
      // Detect read-only, then repair each session in its own transaction as it is found, so a large
      // store never buffers every plan at once. Enumerate from transcript_events, not sessions: the
      // latter gained its columns post-ship and is not safe to assume on old databases.
      const sessionIds = readOnlySqliteTranscriptSessionIds(sqlitePath);
      for (const sessionId of sessionIds) {
        // Read transcript in read-only mode (detection phase).
        const readResult = readOnlySqliteTranscriptRepairSnapshot(
          sqlitePath,
          sessionId,
          normalizeLegacyInboundContextLabels,
        );
        if (!readResult.ok) {
          const detail = formatErrorMessage(readResult.error).replace(/\s+/g, " ").trim();
          note(
            `- Failed to read transcript for session ${sessionId} (${agentId}): ${detail}`,
            NOTE_TITLE,
          );
          continue;
        }

        // Build per-row change list keyed by seq. Parse each row individually so unparseable
        // rows (with corrupted eventJson) don't break the whole session.
        const updates: Array<{ seq: number; eventJson: string }> = [];
        let hasMalformedRow = false;
        for (const row of readResult.rows) {
          let event: TranscriptEvent;
          try {
            event = JSON.parse(row.eventJson) as TranscriptEvent;
          } catch {
            // A malformed sibling cannot produce a valid deferred projection after repair.
            hasMalformedRow = true;
            continue;
          }
          if (normalizeLegacyInboundContextLabels(event)) {
            updates.push({ seq: row.seq, eventJson: JSON.stringify(event) });
          }
        }

        if (updates.length === 0) {
          continue;
        }

        foundSessions += 1;
        foundEvents += updates.length;

        // REPAIR PHASE (if --fix): process immediately, don't buffer.
        if (params.shouldRepair) {
          try {
            if (hasMalformedRow) {
              throw new Error(`transcript contains malformed event JSON for ${sessionId}`);
            }
            runOpenClawAgentWriteTransaction(
              (writeDatabase) => {
                // Use rows-only guard (tolerant of malformed JSON in sibling rows).
                const currentRows = readTranscriptEventRows(writeDatabase, sessionId);
                if (!snapshotsMatch(readResult.rows, currentRows)) {
                  throw new Error(`transcript changed while preparing rewrite for ${sessionId}`);
                }
                // Surgical per-row update: preserves seq, created_at, and sessions row.
                updateSqliteTranscriptEventJsonInTransaction(writeDatabase, sessionId, updates);
              },
              databaseOptions,
              { operationLabel: "doctor.session-transcript-labels" },
            );
            repairedSessions += 1;
            repairedEvents += updates.length;
          } catch (repairError) {
            const detail = formatErrorMessage(repairError).replace(/\s+/g, " ").trim();
            note(
              `- Failed to rewrite labels for session ${sessionId} (${agentId}): ${detail}`,
              NOTE_TITLE,
            );
          }
        }
      }
    } catch (error) {
      const detail = formatErrorMessage(error).replace(/\s+/g, " ").trim();
      note(
        `- Failed to inspect or rewrite labels for ${agentId} (${sqlitePath}): ${detail}`,
        NOTE_TITLE,
      );
    }
  }

  if (params.shouldRepair && repairedSessions > 0) {
    note(
      `- Rewrote legacy inbound-context labels in ${formatCount(repairedSessions, "session")} (${formatCount(repairedEvents, "event")}).`,
      NOTE_TITLE,
    );
  } else if (!params.shouldRepair && foundEvents > 0) {
    note(
      [
        `- Found ${formatCount(foundSessions, "session")} with legacy inbound-context labels.`,
        '- Run "openclaw doctor --fix" to rewrite them.',
      ].join("\n"),
      NOTE_TITLE,
    );
  }
}
