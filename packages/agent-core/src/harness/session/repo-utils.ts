// Agent Core helper module supports repo utils behavior.
import {
  type FileError,
  type Result,
  SessionError,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "../types.js";
import { Session } from "./session.js";
import { uuidv7 } from "./uuid.js";

/** Create a time-sortable session id. */
export function createSessionId(): string {
  return uuidv7();
}

/** Create a canonical session timestamp string. */
export function createTimestamp(): string {
  return new Date().toISOString();
}

/** Wrap a storage implementation in the Session facade. */
export function toSession<TMetadata extends SessionMetadata>(
  storage: SessionStorage<TMetadata>,
): Session<TMetadata> {
  return new Session(storage);
}

/** Unwrap filesystem results into session errors with caller context. */
export function getFileSystemResultOrThrow<TValue>(
  result: Result<TValue, FileError>,
  message: string,
): TValue {
  if (!result.ok) {
    const code = result.error.code === "not_found" ? "not_found" : "storage";
    throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
  }
  return result.value;
}

/** Select the entries copied into a forked session. */
export async function getEntriesToFork(
  storage: SessionStorage,
  options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
  if (!options.entryId) {
    return storage.getEntries();
  }
  const target = await storage.getEntry(options.entryId);
  if (!target) {
    throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
  }
  let effectiveLeafId: string | null;
  if ((options.position ?? "before") === "at") {
    effectiveLeafId = target.id;
  } else {
    // Fork-before only targets user turns so the fork starts where a new prompt
    // can replace that turn without carrying its response.
    if (target.type !== "message" || target.message.role !== "user") {
      throw new SessionError(
        "invalid_fork_target",
        `Entry ${options.entryId} is not a user message`,
      );
    }
    effectiveLeafId = target.parentId;
  }
  return storage.getPathToRoot(effectiveLeafId);
}
