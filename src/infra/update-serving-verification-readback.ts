import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "./kysely-sync.js";
import type { UpdateServingReceipt } from "./update-serving-verification-receipt.js";

type TranscriptProof = UpdateServingReceipt["transcript"];

/** A fresh read-only snapshot; never borrows the Gateway/writer's cached handle. */
export function readUpdateServingTranscript(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId: string;
  sessionKey: string;
  agentRunId: string;
  prompt: string;
  response: string;
}): { sessionId: string; transcript: TranscriptProof } | undefined {
  const scope = resolveSqliteScope({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: resolveSessionStorePathCore(params.config.session?.store, {
      agentId: params.agentId,
      env: params.env,
    }),
    env: params.env,
  });
  const opened = openOpenClawAgentDatabaseReadOnly(toDatabaseOptions(scope));
  if (!opened.found) {
    return undefined;
  }
  const { db, close } = opened.database;
  try {
    // SQLite primitive: all identity, rewrite and transcript reads share one committed snapshot.
    db.exec("BEGIN");
    const query = getSessionKysely(db);
    const owner = executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("session_nodes as node")
        .innerJoin("session_windows as window", "window.session_id", "node.current_session_id")
        .innerJoin(
          "transcript_rewrite_watermarks as rewrite",
          "rewrite.session_id",
          "window.session_id",
        )
        .select(["node.current_session_id", "rewrite.generation", "node.status"])
        .where("node.session_key", "=", scope.sessionKey)
        .where("window.session_key", "=", scope.sessionKey)
        .where("node.entry_valid", "=", 1)
        .where("node.archived_at", "is", null),
    );
    if (!owner || ["failed", "killed", "timeout"].includes(owner.status ?? "")) {
      return undefined;
    }
    // The verifier creates a new session for one tiny turn. Bound bytes in SQLite
    // before crossing into JS, and reject overflow instead of searching partial history.
    const rows = executeSqliteQuerySync(
      db,
      query
        .selectFrom("transcript_events")
        .select("seq")
        .select((eb) =>
          eb
            .case()
            .when(eb.fn<number>("octet_length", [eb.ref("event_json")]), "<=", 32_768)
            .then(eb.ref("event_json"))
            .else(null)
            .end()
            .as("event_json"),
        )
        .where("session_id", "=", owner.current_session_id)
        .orderBy("seq", "asc")
        .limit(33),
    ).rows;
    if (rows.length === 0 || rows.length > 32) {
      return undefined;
    }
    let user: TranscriptProof["user"] | undefined;
    let assistant: TranscriptProof["assistant"] | undefined;
    const parents = new Map<string, string | null>();
    for (const row of rows) {
      if (!row.event_json) {
        return undefined;
      }
      const event: unknown = JSON.parse(row.event_json);
      if (!isRecord(event) || typeof event.id !== "string") {
        return undefined;
      }
      if (event.type === "reset" || event.type === "compaction") {
        return undefined;
      }
      parents.set(event.id, typeof event.parentId === "string" ? event.parentId : null);
      if (event.type !== "message" || !isRecord(event.message)) {
        continue;
      }
      const message = event.message;
      if (message.role === "user") {
        const content = message.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter(isRecord)
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("")
              : undefined;
        // Exactly one newly persisted request, not a historical or concurrent turn.
        if (user || text !== params.prompt) {
          return undefined;
        }
        user = { entryId: event.id, seq: row.seq };
      }
      // A trailing tool result or other message is not a completed assistant turn.
      assistant = undefined;
      if (message.role === "assistant") {
        const metadata = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
        assistant =
          user &&
          metadata?.runId === params.agentRunId &&
          message.stopReason === "stop" &&
          typeof message.provider === "string" &&
          message.provider.length > 0 &&
          typeof message.model === "string" &&
          message.model.length > 0 &&
          !message.errorMessage &&
          extractAssistantPhaseText(message)?.trim() === params.response
            ? { entryId: event.id, seq: row.seq }
            : undefined;
      }
    }
    if (!user || !assistant || assistant.seq <= user.seq) {
      return undefined;
    }
    // Raw events are canonical. Prove the terminal assistant descends from the
    // exact request rather than accepting an unrelated abandoned transcript branch.
    let parent = parents.get(assistant.entryId);
    const visited = new Set<string>();
    while (parent && parent !== user.entryId && !visited.has(parent)) {
      visited.add(parent);
      parent = parents.get(parent);
    }
    if (parent !== user.entryId) {
      return undefined;
    }
    return {
      sessionId: owner.current_session_id,
      transcript: {
        generation: owner.generation,
        maxSeq: rows[rows.length - 1]!.seq,
        user,
        assistant,
      },
    };
  } finally {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    close();
  }
}
