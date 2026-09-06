import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  assertCurrentSessionTranscriptHeader,
  classifySessionFileEntry,
  findSessionTranscriptHeader,
} from "./session-entry-codec.js";
import { SessionEntryNavigation, type SessionNavigationEntry } from "./session-entry-navigation.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

type CustomMessageReport = { customType: string; content: unknown; details?: unknown };
type CustomMessageReportAppend = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
type TranscriptReport =
  | { kind: "assistant"; message: AssistantMessage & { responseId: string } }
  | {
      kind: "custom";
      customTypes: readonly string[];
      selectReport: (
        latest: CustomMessageReport | undefined,
      ) => CustomMessageReportAppend | undefined;
    };

type ReportNavigationEntry = SessionNavigationEntry & {
  seq: number;
  customType?: string;
  assistantResponseId?: string;
};

class TranscriptReportNavigation extends SessionEntryNavigation<ReportNavigationEntry> {
  constructor(rows: Iterable<{ seq: number; entry: unknown }>, sourceVersion: number) {
    super();
    for (const { seq, entry: raw } of rows) {
      const { entry, recognized } = classifySessionFileEntry(raw, sourceVersion);
      if (!recognized || entry.type === "session") {
        this.appendOpaqueNavigationRecord(raw);
        continue;
      }
      // Classification consumes the original row. Retain only navigation/report
      // facts so large message and provider bodies die with this iteration.
      const common = {
        id: entry.id,
        parentId: entry.parentId,
        timestamp: entry.timestamp,
        appendMode: entry.appendMode,
        seq,
        ...(entry.type === "custom_message" ? { customType: entry.customType } : {}),
        ...(entry.type === "message" &&
        entry.message.role === "assistant" &&
        typeof entry.message.responseId === "string"
          ? { assistantResponseId: entry.message.responseId }
          : {}),
      };
      const navigation: ReportNavigationEntry =
        entry.type === "label"
          ? { ...common, type: entry.type, targetId: entry.targetId, label: entry.label }
          : { ...common, type: entry.type };
      this.appendCanonicalNavigationEntry(navigation, Object.hasOwn(entry, "parentId"));
    }
    this.finishNavigation();
  }

  facts() {
    return { appendParentId: this.appendParentId, path: this.getBranch() };
  }
}

function readReportBranch(database: OpenClawAgentDatabase, sessionId: string) {
  function* rows() {
    for (const row of iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", "event_json"])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    )) {
      yield { seq: row.seq, entry: JSON.parse(row.event_json) as unknown };
    }
  }
  let hasRows = false;
  const header = findSessionTranscriptHeader(
    (function* () {
      for (const row of rows()) {
        hasRows = true;
        yield row.entry;
      }
    })(),
  );
  if (hasRows) {
    assertCurrentSessionTranscriptHeader(header);
  }
  return new TranscriptReportNavigation(rows(), header?.version ?? 1).facts();
}

function latestCustomReport(
  database: OpenClawAgentDatabase,
  sessionId: string,
  branch: ReturnType<typeof readReportBranch>,
  customTypes: readonly string[],
): CustomMessageReport | undefined {
  for (const entry of branch.path.toReversed()) {
    if (
      entry.type !== "custom_message" ||
      entry.customType === undefined ||
      !customTypes.includes(entry.customType)
    ) {
      continue;
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select("event_json")
        .where("session_id", "=", sessionId)
        .where("seq", "=", entry.seq),
    );
    const record: unknown = row ? JSON.parse(row.event_json) : undefined;
    if (isRecord(record)) {
      return { customType: entry.customType, content: record.content, details: record.details };
    }
  }
  return undefined;
}

async function withCurrentTranscript<T>(
  scope: SessionTranscriptWriteScope,
  run: (database: OpenClawAgentDatabase, resolved: ResolvedTranscriptScope) => T,
): Promise<Result<T, TranscriptAppendRefusal>> {
  // Capture the logical store identity before SQLite resolves a physical path,
  // or inherited writer fences would stop matching after the queue wait.
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fenced);
  return runExclusiveSqliteSessionWrite(resolved, async () =>
    runOpenClawAgentWriteTransaction(
      (database) => {
        assertOwnedTranscriptWriteCommit(fenced);
        const refusal = resolveTranscriptAppendRefusal(
          readSessionEntryRow(database, resolved.sessionKey)?.entry,
          resolved,
          fenced,
        );
        if (refusal) {
          if (fenced.expectedWriterRunId !== undefined) {
            throw new SessionTranscriptWriterClaimReboundError(refusal);
          }
          return err(refusal);
        }
        const result = run(database, resolved);
        assertOwnedTranscriptWriteCommit(fenced);
        const rebound = resolveTranscriptAppendRefusal(
          readSessionEntryRow(database, resolved.sessionKey)?.entry,
          resolved,
          fenced,
        );
        if (rebound) {
          throw new SessionTranscriptWriterClaimReboundError(rebound);
        }
        return ok(result);
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.transcript.report" },
    ),
  );
}

/** Reads the latest matching custom report from the active branch in one snapshot. */
export async function readLatestSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  customTypes: readonly string[],
): Promise<Result<CustomMessageReport | undefined, TranscriptAppendRefusal>> {
  return withCurrentTranscript(scope, (database, resolved) =>
    latestCustomReport(
      database,
      resolved.sessionId,
      readReportBranch(database, resolved.sessionId),
      customTypes,
    ),
  );
}

/** Selects and appends one report atomically; Gateway policy only sees report facts. */
export async function appendSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  report: TranscriptReport,
): Promise<Result<void, TranscriptAppendRefusal>> {
  return withCurrentTranscript(scope, (database, resolved) => {
    const branch = readReportBranch(database, resolved.sessionId);
    if (report.kind === "assistant") {
      const exists = branch.path.some(
        (entry) => entry.assistantResponseId === report.message.responseId,
      );
      if (exists) {
        return;
      }
      appendTranscriptMessageInTransaction(database, resolved, {
        message: applyAssistantDeliveryDirectives(report.message),
        parentId: branch.appendParentId,
      });
      return;
    }
    const selected = report.selectReport(
      latestCustomReport(database, resolved.sessionId, branch, report.customTypes),
    );
    if (!selected) {
      return;
    }
    // Query and append share the committed cursor. Existing rows are never
    // retained as a full history or rewritten when a report is appended.
    ensureTranscriptHeader(database, resolved, undefined);
    const appended = appendTranscriptEventInTransaction(database, resolved, {
      type: "custom_message",
      ...selected,
      id: randomUUID(),
      parentId: branch.appendParentId,
      timestamp: new Date().toISOString(),
    });
    if (!appended) {
      throw new Error("Session transcript report was not appended");
    }
  });
}
