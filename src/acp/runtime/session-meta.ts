import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { resolveAllAgentSessionStoreTargets } from "../../config/sessions/targets.js";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

let sessionStoreRuntimePromise:
  | Promise<typeof import("../../config/sessions/store.runtime.js")>
  | undefined;

function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return sessionStoreRuntimePromise;
}

export type AcpSessionStoreEntry = {
  cfg: OpenClawConfig;
  storePath: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  storeReadFailed?: boolean;
};

function resolveStoreSessionKey(store: Record<string, SessionEntry>, sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return "";
  }
  if (store[normalized]) {
    return normalized;
  }
  const lower = normalizeLowercaseStringOrEmpty(normalized);
  if (store[lower]) {
    return lower;
  }
  for (const key of Object.keys(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === lower) {
      return key;
    }
  }
  return lower;
}

export function resolveSessionStorePathForAcp(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
}): { cfg: OpenClawConfig; storePath: string } {
  const cfg = params.cfg ?? getRuntimeConfig();
  const parsed = parseAgentSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  return { cfg, storePath };
}

export function readAcpSessionEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
}): AcpSessionStoreEntry | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const { cfg, storePath } = resolveSessionStorePathForAcp({
    sessionKey,
    cfg: params.cfg,
  });
  let store: Record<string, SessionEntry>;
  let storeReadFailed = false;
  try {
    store = loadSessionStore(storePath);
  } catch {
    storeReadFailed = true;
    store = {};
  }
  const storeSessionKey = resolveStoreSessionKey(store, sessionKey);
  const entry = store[storeSessionKey];
  return {
    cfg,
    storePath,
    sessionKey,
    storeSessionKey,
    entry,
    acp: entry?.acp,
    storeReadFailed,
  };
}

export async function listAcpSessionEntries(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<AcpSessionStoreEntry[]> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const storeTargets = await resolveAllAgentSessionStoreTargets(
    cfg,
    params.env ? { env: params.env } : undefined,
  );
  const entries: AcpSessionStoreEntry[] = [];

  for (const target of storeTargets) {
    const storePath = target.storePath;
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(storePath);
    } catch {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry?.acp) {
        continue;
      }
      entries.push({
        cfg,
        storePath,
        sessionKey,
        storeSessionKey: sessionKey,
        entry,
        acp: entry.acp,
      });
    }
  }

  return entries;
}

export async function upsertAcpSessionMeta(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const { storePath } = resolveSessionStorePathForAcp({
    sessionKey,
    cfg: params.cfg,
  });
  const { updateSessionStore } = await loadSessionStoreRuntime();
  return await updateSessionStore(
    storePath,
    (store) => {
      const storeSessionKey = resolveStoreSessionKey(store, sessionKey);
      const currentEntry = store[storeSessionKey];
      const nextMeta = params.mutate(currentEntry?.acp, currentEntry);
      if (nextMeta === undefined) {
        return currentEntry ?? null;
      }
      if (nextMeta === null && !currentEntry) {
        return null;
      }

      const nextEntry = mergeSessionEntry(currentEntry, {
        acp: nextMeta ?? undefined,
      });
      if (nextMeta === null) {
        delete nextEntry.acp;
      }
      store[storeSessionKey] = nextEntry;
      return nextEntry;
    },
    {
      activeSessionKey: normalizeLowercaseStringOrEmpty(sessionKey),
      allowDropAcpMetaSessionKeys: [sessionKey],
    },
  );
}
