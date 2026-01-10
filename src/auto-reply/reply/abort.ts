import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import {
  normalizeCommandBody,
  shouldHandleTextCommands,
} from "../commands-registry.js";
import type { MsgContext } from "../templating.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

const ABORT_TRIGGERS = new Set(["stop", "esc", "abort", "wait", "exit"]);
const ABORT_MEMORY = new Map<string, boolean>();

export function isAbortTrigger(text?: string): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  return ABORT_TRIGGERS.has(normalized);
}

export function getAbortMemory(key: string): boolean | undefined {
  return ABORT_MEMORY.get(key);
}

export function setAbortMemory(key: string, value: boolean): void {
  ABORT_MEMORY.set(key, value);
}

function resolveSessionEntryForKey(
  store: Record<string, SessionEntry> | undefined,
  sessionKey: string | undefined,
) {
  if (!store || !sessionKey) return {};
  const direct = store[sessionKey];
  if (direct) return { entry: direct, key: sessionKey };
  const parsed = parseAgentSessionKey(sessionKey);
  const legacyKey = parsed?.rest;
  if (legacyKey && store[legacyKey]) {
    return { entry: store[legacyKey], key: legacyKey };
  }
  return {};
}

function resolveAbortTargetKey(ctx: MsgContext): string | undefined {
  const target = ctx.CommandTargetSessionKey?.trim();
  if (target) return target;
  const sessionKey = ctx.SessionKey?.trim();
  return sessionKey || undefined;
}

export async function tryFastAbortFromMessage(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
}): Promise<{ handled: boolean; aborted: boolean }> {
  const { ctx, cfg } = params;
  const surface = (ctx.Surface ?? ctx.Provider ?? "").trim().toLowerCase();
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface,
    commandSource: ctx.CommandSource,
  });
  if (!allowTextCommands) return { handled: false, aborted: false };

  const commandAuthorized = ctx.CommandAuthorized ?? true;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  if (!auth.isAuthorizedSender) return { handled: false, aborted: false };

  const targetKey = resolveAbortTargetKey(ctx);
  const agentId = resolveSessionAgentId({
    sessionKey: targetKey ?? ctx.SessionKey ?? "",
    config: cfg,
  });
  // Use RawBody/CommandBody for abort detection (clean message without structural context).
  const raw = stripStructuralPrefixes(
    ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "",
  );
  const isGroup = ctx.ChatType?.trim().toLowerCase() === "group";
  const stripped = isGroup ? stripMentions(raw, ctx, cfg, agentId) : raw;
  const normalized = normalizeCommandBody(stripped);
  const abortRequested = normalized === "/stop" || isAbortTrigger(stripped);
  if (!abortRequested) return { handled: false, aborted: false };

  const abortKey = targetKey ?? auth.from ?? auth.to;

  if (targetKey) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const { entry, key } = resolveSessionEntryForKey(store, targetKey);
    const sessionId = entry?.sessionId;
    const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;
    if (entry && key) {
      entry.abortedLastRun = true;
      entry.updatedAt = Date.now();
      store[key] = entry;
      await saveSessionStore(storePath, store);
    } else if (abortKey) {
      setAbortMemory(abortKey, true);
    }
    return { handled: true, aborted };
  }

  if (abortKey) {
    setAbortMemory(abortKey, true);
  }
  return { handled: true, aborted: false };
}
