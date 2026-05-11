import fs from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

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
    return buildSessionContext(sessionEntries).messages;
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    return undefined;
  }
}
