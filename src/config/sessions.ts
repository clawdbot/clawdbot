import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Skill } from "@mariozechner/pi-coding-agent";
import JSON5 from "json5";
import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeE164 } from "../utils.js";
import { resolveStateDir } from "./paths.js";

export type SessionScope = "per-sender" | "global";

const GROUP_SURFACES = new Set([
  "whatsapp",
  "telegram",
  "discord",
  "signal",
  "imessage",
  "webchat",
  "slack",
]);

export type SessionChatType = "direct" | "group" | "room";

export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  verboseLevel?: string;
  elevatedLevel?: string;
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  compactionCount?: number;
  displayName?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  lastChannel?:
    | "whatsapp"
    | "telegram"
    | "discord"
    | "slack"
    | "signal"
    | "imessage"
    | "webchat";
  lastTo?: string;
  skillsSnapshot?: SessionSkillSnapshot;
};

export type GroupKeyResolution = {
  key: string;
  legacyKey?: string;
  surface?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: Skill[];
};

export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return path.join(resolveStateDir(env, homedir), "sessions");
}

export function resolveDefaultSessionStorePath(): string {
  return path.join(resolveSessionTranscriptsDir(), "sessions.json");
}
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;

export function resolveSessionTranscriptPath(sessionId: string): string {
  return path.join(resolveSessionTranscriptsDir(), `${sessionId}.jsonl`);
}

export function resolveStorePath(store?: string) {
  if (!store) return resolveDefaultSessionStorePath();
  if (store.startsWith("~"))
    return path.resolve(store.replace("~", os.homedir()));
  return path.resolve(store);
}

export function resolveMainSessionKey(cfg?: {
  session?: { scope?: SessionScope; mainKey?: string };
}): string {
  if (cfg?.session?.scope === "global") return "global";
  return "main";
}

function normalizeGroupLabel(raw?: string) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return "";
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function shortenGroupId(value?: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function buildGroupDisplayName(params: {
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const surfaceKey = (params.surface?.trim().toLowerCase() || "group").trim();
  const room = params.room?.trim();
  const space = params.space?.trim();
  const subject = params.subject?.trim();
  const detail =
    (room && space
      ? `${space}${room.startsWith("#") ? "" : "#"}${room}`
      : room || subject || space || "") || "";
  const fallbackId = params.id?.trim() || params.key.replace(/^group:/, "");
  const rawLabel = detail || fallbackId;
  let token = normalizeGroupLabel(rawLabel);
  if (!token) {
    token = normalizeGroupLabel(shortenGroupId(rawLabel));
  }
  if (!params.room && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (
    token &&
    !/^[@#]/.test(token) &&
    !token.startsWith("g-") &&
    !token.includes("#")
  ) {
    token = `g-${token}`;
  }
  return token ? `${surfaceKey}:${token}` : surfaceKey;
}

export function resolveGroupSessionKey(
  ctx: MsgContext,
): GroupKeyResolution | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  if (!from) return null;
  const chatType = ctx.ChatType?.trim().toLowerCase();
  const isGroup =
    chatType === "group" ||
    from.startsWith("group:") ||
    from.includes("@g.us") ||
    from.includes(":group:") ||
    from.includes(":channel:");
  if (!isGroup) return null;

  const surfaceHint = ctx.Surface?.trim().toLowerCase();
  const hasLegacyGroupPrefix = from.startsWith("group:");
  const raw = (
    hasLegacyGroupPrefix ? from.slice("group:".length) : from
  ).trim();

  let surface: string | undefined;
  let kind: "group" | "channel" | undefined;
  let id = "";

  const parseKind = (value: string) => {
    if (value === "channel") return "channel";
    return "group";
  };

  const parseParts = (parts: string[]) => {
    if (parts.length >= 2 && GROUP_SURFACES.has(parts[0])) {
      surface = parts[0];
      if (parts.length >= 3) {
        const kindCandidate = parts[1];
        if (["group", "channel"].includes(kindCandidate)) {
          kind = parseKind(kindCandidate);
          id = parts.slice(2).join(":");
        } else {
          id = parts.slice(1).join(":");
        }
      } else {
        id = parts[1];
      }
      return;
    }
    if (parts.length >= 2 && ["group", "channel"].includes(parts[0])) {
      kind = parseKind(parts[0]);
      id = parts.slice(1).join(":");
    }
  };

  if (hasLegacyGroupPrefix) {
    const legacyParts = raw.split(":").filter(Boolean);
    if (legacyParts.length > 1) {
      parseParts(legacyParts);
    } else {
      id = raw;
    }
  } else if (from.includes("@g.us") && !from.includes(":")) {
    id = from;
  } else {
    parseParts(from.split(":").filter(Boolean));
    if (!id) {
      id = raw || from;
    }
  }

  const resolvedSurface = surface ?? surfaceHint;
  if (!resolvedSurface) {
    const legacy = hasLegacyGroupPrefix ? `group:${raw}` : `group:${from}`;
    return {
      key: legacy,
      id: raw || from,
      legacyKey: legacy,
      chatType: "group",
    };
  }

  const resolvedKind = kind === "channel" ? "channel" : "group";
  const key = `${resolvedSurface}:${resolvedKind}:${id || raw || from}`;
  let legacyKey: string | undefined;
  if (hasLegacyGroupPrefix || from.includes("@g.us")) {
    legacyKey = `group:${id || raw || from}`;
  }

  return {
    key,
    legacyKey,
    surface: resolvedSurface,
    id: id || raw || from,
    chatType: resolvedKind === "channel" ? "room" : "group",
  };
}

export function loadSessionStore(
  storePath: string,
): Record<string, SessionEntry> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, SessionEntry>;
    }
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }
  return {};
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, "utf-8");
    await fs.promises.rename(tmp, storePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, "utf-8");
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") return;
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel: SessionEntry["lastChannel"];
  to?: string;
}) {
  const { storePath, sessionKey, channel, to } = params;
  const store = loadSessionStore(storePath);
  const existing = store[sessionKey];
  const now = Date.now();
  const next: SessionEntry = {
    sessionId: existing?.sessionId ?? crypto.randomUUID(),
    updatedAt: Math.max(existing?.updatedAt ?? 0, now),
    systemSent: existing?.systemSent,
    abortedLastRun: existing?.abortedLastRun,
    thinkingLevel: existing?.thinkingLevel,
    verboseLevel: existing?.verboseLevel,
    providerOverride: existing?.providerOverride,
    modelOverride: existing?.modelOverride,
    sendPolicy: existing?.sendPolicy,
    queueMode: existing?.queueMode,
    inputTokens: existing?.inputTokens,
    outputTokens: existing?.outputTokens,
    totalTokens: existing?.totalTokens,
    modelProvider: existing?.modelProvider,
    model: existing?.model,
    contextTokens: existing?.contextTokens,
    displayName: existing?.displayName,
    chatType: existing?.chatType,
    surface: existing?.surface,
    subject: existing?.subject,
    room: existing?.room,
    space: existing?.space,
    skillsSnapshot: existing?.skillsSnapshot,
    lastChannel: channel,
    lastTo: to?.trim() ? to.trim() : undefined,
  };
  store[sessionKey] = next;
  await saveSessionStore(storePath, store);
  return next;
}

// Decide which session bucket to use (per-sender vs global).
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  if (scope === "global") return "global";
  const resolvedGroup = resolveGroupSessionKey(ctx);
  if (resolvedGroup) return resolvedGroup.key;
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  return from || "unknown";
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) return explicit;
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") return raw;
  // Default to a single shared direct-chat session called "main"; groups stay isolated.
  const canonical = (mainKey ?? "main").trim() || "main";
  const isGroup =
    raw.startsWith("group:") ||
    raw.includes(":group:") ||
    raw.includes(":channel:");
  if (!isGroup) return canonical;
  return raw;
}
