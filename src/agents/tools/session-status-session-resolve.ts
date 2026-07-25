// Status-tool session resolution helpers keep storage lookup out of the tool body.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveSessionEntryCandidateTarget, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveInternalSessionKey } from "./sessions-helpers.js";

type ResolvedStatusSessionEntry = {
  entry: SessionEntry;
  key: string;
  persisted: boolean;
};

/** Resolves one status lookup against ordered tool-local session key candidates. */
export function resolveSessionStatusEntry(params: {
  agentId: string;
  alias: string;
  cfg: OpenClawConfig;
  includeAliasFallback?: boolean;
  keyRaw: string;
  mainKey: string;
  requesterInternalKey?: string;
}): ResolvedStatusSessionEntry | null {
  const keyRaw = params.keyRaw.trim();
  if (!keyRaw) {
    return null;
  }
  const includeAliasFallback = params.includeAliasFallback ?? true;
  const internal = resolveInternalSessionKey({
    key: keyRaw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });

  const candidates: string[] = [keyRaw];
  if (!keyRaw.startsWith("agent:")) {
    candidates.push(`agent:${DEFAULT_AGENT_ID}:${keyRaw}`);
  }
  if (includeAliasFallback && internal !== keyRaw) {
    candidates.push(internal);
  }
  if (includeAliasFallback && !keyRaw.startsWith("agent:")) {
    const agentInternal = `agent:${DEFAULT_AGENT_ID}:${internal}`;
    const agentRaw = `agent:${DEFAULT_AGENT_ID}:${keyRaw}`;
    if (agentInternal !== agentRaw) {
      candidates.push(agentInternal);
    }
  }
  if (includeAliasFallback && (keyRaw === "main" || keyRaw === "current")) {
    const defaultMainKey = buildAgentMainSessionKey({
      agentId: DEFAULT_AGENT_ID,
      mainKey: params.mainKey,
    });
    if (!candidates.includes(defaultMainKey)) {
      candidates.push(defaultMainKey);
    }
  }

  const resolved = resolveSessionEntryCandidateTarget({
    agentId: params.agentId,
    candidateKeys: candidates,
    cfg: params.cfg,
  });
  return resolved
    ? {
        entry: resolved.entry,
        key: resolved.sessionKey,
        persisted: resolved.persisted,
      }
    : null;
}

/** Maps requester keys into the currently selected agent store's legacy main key shape. */
export function resolveStoreScopedRequesterKey(params: {
  agentId: string;
  mainKey: string;
  requesterKey: string;
}) {
  const parsed = parseAgentSessionKey(params.requesterKey);
  if (!parsed || parsed.agentId !== params.agentId) {
    return params.requesterKey;
  }
  return parsed.rest === params.mainKey ? params.mainKey : params.requesterKey;
}

function synthesizeImplicitCurrentSessionEntry(): SessionEntry {
  return {
    sessionId: "",
    updatedAt: Date.now(),
  };
}

/** Returns a synthesized current-session entry without writing it to storage. */
export function resolveImplicitCurrentSessionFallback(params: {
  agentId: string;
  allowFallback: boolean;
  cfg: OpenClawConfig;
  fallbackKey: string;
}): ResolvedStatusSessionEntry | null {
  const fallbackKey = params.fallbackKey.trim();
  if (!params.allowFallback || !fallbackKey) {
    return null;
  }
  const resolved = resolveSessionEntryCandidateTarget({
    agentId: params.agentId,
    candidateKeys: [],
    cfg: params.cfg,
    fallback: {
      sessionKey: fallbackKey,
      entry: synthesizeImplicitCurrentSessionEntry(),
    },
  });
  return resolved
    ? {
        entry: resolved.entry,
        key: resolved.sessionKey,
        persisted: resolved.persisted,
      }
    : null;
}

/** Lists policy-key fallbacks for implicit default-account direct status lookups. */
export function listImplicitDefaultDirectFallbackKeys(params: {
  keyRaw: string;
  mainKey: string;
}): string[] {
  const parsed = parseAgentSessionKey(params.keyRaw.trim());
  if (!parsed) {
    return [];
  }
  const parts = parsed.rest.split(":");
  if (parts.length < 4 || parts[1] !== "default" || parts[2] !== "direct") {
    return [];
  }
  const channel = parts[0];
  const peerParts = parts.slice(3);
  if (!channel || peerParts.length === 0) {
    return [];
  }
  const candidates = [
    `agent:${parsed.agentId}:${channel}:direct:${peerParts.join(":")}`,
    buildAgentMainSessionKey({
      agentId: parsed.agentId,
      mainKey: params.mainKey,
    }),
    params.mainKey,
  ];
  return uniqueStrings(candidates);
}
