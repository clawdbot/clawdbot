import fs from "node:fs/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import {
  readCodexSessionContext,
  type SessionTranscriptContextVersion,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import type {
  SessionTranscriptTargetParams,
  TranscriptTurnAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

export type ResolvedCodexHistoryTarget =
  | { kind: "empty" }
  | { kind: "file"; sessionFile: string }
  | {
      kind: "sqlite";
      target: Required<
        Pick<SessionTranscriptTargetParams, "agentId" | "sessionId" | "sessionKey" | "storePath">
      >;
    };

export function consumeCodexHistory<T>(
  messages: Iterable<AgentMessage>,
  header: unknown,
  sessionId: string,
  read: (messages: Iterable<AgentMessage>) => T,
  imageLabel = "codex mirrored history",
): T | undefined {
  // Foreign or absent headers are empty history; malformed session headers are read failures.
  if (!isRecord(header) || header.type !== "session") {
    return read([]);
  }
  if (typeof header.id !== "string") {
    return undefined;
  }
  if (header.id !== sessionId) {
    return read([]);
  }
  return read(
    (function* () {
      for (const message of messages) {
        yield sanitizeCodexHistoryImagePayloads(message, imageLabel);
      }
    })(),
  );
}

/** Keeps native evidence and its synchronous consumer inside the same readonly snapshot. */
export async function readCodexNativeHistory<T>(
  target: ResolvedCodexHistoryTarget,
  sessionId: string,
  read: (messages: Iterable<AgentMessage>) => T,
  admission?: TranscriptTurnAdmission,
  onSnapshot?: (version: SessionTranscriptContextVersion | undefined) => void,
): Promise<T | undefined> {
  const consume = (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => {
    onSnapshot?.(version);
    return consumeCodexHistory(messages, header, sessionId, read);
  };
  try {
    if (target.kind === "empty") {
      return read([]);
    }
    if (target.kind === "sqlite") {
      return readCodexSessionContext(target.target, consume, admission);
    }
    // The legacy file codec is needed only for explicit file imports, never native SQLite reads.
    const { buildSessionContext, migrateSessionEntries, parseSessionEntries } =
      await import("openclaw/plugin-sdk/agent-sessions");
    const entries = parseSessionEntries(await fs.readFile(target.sessionFile, "utf-8"));
    return consume(
      (function* () {
        migrateSessionEntries(entries);
        const sessionEntries = entries.filter(
          (entry): entry is SessionEntry => isRecord(entry) && entry.type !== "session",
        );
        yield* buildSessionContext(sessionEntries).messages;
      })(),
      entries[0],
    );
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return read([]);
    }
    return undefined;
  }
}
