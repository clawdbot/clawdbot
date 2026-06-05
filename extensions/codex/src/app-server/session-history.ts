/**
 * Reads OpenClaw session history for Codex transcript mirroring and sanitizes
 * image payloads before replaying messages into the app-server projector.
 */
import fs from "node:fs/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "openclaw/plugin-sdk/agent-sessions";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

/** Returns sanitized session-context messages for a Codex mirrored session file. */
export async function readCodexMirroredSessionHistoryMessages(
  sessionFile: string,
): Promise<AgentMessage[] | undefined> {
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const entries = parseSessionEntries(raw);
    const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
      return undefined;
    }
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter(
      (entry): entry is SessionEntry => entry.type !== "session",
    );
    return sanitizeCodexHistoryImagePayloads(
      buildSessionContext(sessionEntries).messages,
      "codex mirrored history",
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    return undefined;
  }
}
