import fs from "node:fs";
import path from "node:path";

import type { SessionEntry } from "./types.js";
import { loadSessionStore, saveSessionStore } from "./store.js";
import { resolveDefaultSessionStorePath, resolveSessionTranscriptPath } from "./paths.js";

export type MirrorDeliveryMode = "full" | "summary";

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  const text = params.text;
  if (!sessionKey) return { ok: false, reason: "missing sessionKey" };
  if (!text.trim()) return { ok: false, reason: "empty text" };

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };

  const sessionFile =
    entry.sessionFile?.trim() || resolveSessionTranscriptPath(entry.sessionId, params.agentId);

  await fs.promises.mkdir(path.dirname(sessionFile), { recursive: true });

  // If transcript doesn't exist, we still want to create it so the message is persisted.
  // Use the minimal line format supported by Clawdbot transcript readers.
  if (!fs.existsSync(sessionFile)) {
    const header = {
      type: "session",
      version: 3,
      id: entry.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    await fs.promises.writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
  }

  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };

  await fs.promises.appendFile(sessionFile, `${JSON.stringify({ message })}\n`, "utf-8");

  // Ensure the session store points at the file we just wrote.
  if (!entry.sessionFile || entry.sessionFile !== sessionFile) {
    await saveSessionStore(storePath, {
      ...store,
      [sessionKey]: {
        ...entry,
        sessionFile,
      },
    });
  }

  return { ok: true, sessionFile };
}
