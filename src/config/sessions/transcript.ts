import fs from "node:fs";
import path from "node:path";

import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";

import type { SessionEntry } from "./types.js";
import { loadSessionStore, updateSessionStore } from "./store.js";
import { resolveDefaultSessionStorePath, resolveSessionTranscriptPath } from "./paths.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

function stripQuery(value: string): string {
  const noHash = value.split("#")[0] ?? value;
  return noHash.split("?")[0] ?? noHash;
}

function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cleaned = stripQuery(trimmed);
  try {
    const parsed = new URL(cleaned);
    const base = path.basename(parsed.pathname);
    if (!base) return null;
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    const base = path.basename(cleaned);
    if (!base || base === "/" || base === ".") return null;
    return base;
  }
}

export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) return names.join(", ");
    return "media";
  }

  const text = params.text ?? "";
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) return;
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) return { ok: false, reason: "missing sessionKey" };

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) return { ok: false, reason: "empty text" };

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };

  const sessionFile =
    entry.sessionFile?.trim() || resolveSessionTranscriptPath(entry.sessionId, params.agentId);

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: mirrorText }],
    api: "openai-responses",
    provider: "moltbot",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  if (!entry.sessionFile || entry.sessionFile !== sessionFile) {
    await updateSessionStore(storePath, (current) => {
      current[sessionKey] = {
        ...entry,
        sessionFile,
      };
    });
  }

  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}
