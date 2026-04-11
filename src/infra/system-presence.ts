import { spawnSync } from "node:child_process";
import os from "node:os";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { pickBestEffortPrimaryLanIPv4 } from "./network-discovery-display.js";

export type SystemPresence = {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  lastInputSeconds?: number;
  mode?: string;
  reason?: string;
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  instanceId?: string;
  text: string;
  ts: number;
};

export type SystemPresenceUpdate = {
  key: string;
  previous?: SystemPresence;
  next: SystemPresence;
  changes: Partial<SystemPresence>;
  changedKeys: (keyof SystemPresence)[];
};

const entries = new Map<string, SystemPresence>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 200;

function normalizePresenceKey(key: string | undefined): string | undefined {
  return normalizeOptionalLowercaseString(key);
}

function resolvePrimaryIPv4(): string | undefined {
  return pickBestEffortPrimaryLanIPv4() ?? os.hostname();
}

function initSelfPresence() {
  const host = os.hostname();
  const ip = resolvePrimaryIPv4() ?? undefined;
  const version = resolveRuntimeServiceVersion(process.env);
  const modelIdentifier = (() => {
    const p = os.platform();
    if (p === "darwin") {
      const res = spawnSync("sysctl", ["-n", "hw.model"], {
        encoding: "utf-8",
      });
      const out = normalizeOptionalString(res.stdout) ?? "";
      return out.length > 0 ? out : undefined;
    }
    return os.arch();
  })();
  const macOSVersion = () => {
    const res = spawnSync("sw_vers", ["-productVersion"], {
      encoding: "utf-8",
    });
    const out = normalizeOptionalString(res.stdout) ?? "";
    return out.length > 0 ? out : os.release();
  };
  const platform = (() => {
    const p = os.platform();
    const rel = os.release();
    if (p === "darwin") {
      return `macos ${macOSVersion()}`;
    }
    if (p === "win32") {
      return `windows ${rel}`;
    }
    return `${p} ${rel}`;
  })();
  const deviceFamily = (() => {
    const p = os.platform();
    if (p === "darwin") {
      return "Mac";
    }
    if (p === "win32") {
      return "Windows";
    }
    if (p === "linux") {
      return "Linux";
    }
    return p;
  })();
  const text = `Gateway: ${host}${ip ? ` (${ip})` : ""} · app ${version} · mode gateway · reason self`;
  const selfEntry: SystemPresence = {
    host,
    ip,
    version,
    platform,
    deviceFamily,
    modelIdentifier,
    mode: "gateway",
    reason: "self",
    text,
    ts: Date.now(),
  };
  const key = normalizeLowercaseStringOrEmpty(host);
  entries.set(key, selfEntry);
}

function ensureSelfPresence() {
  // If the map was somehow cleared (e.g., hot reload or a new worker spawn that
  // skipped module evaluation), re-seed with a local entry so UIs always show
  // at least the current gateway.
  if (entries.size === 0) {
    initSelfPresence();
  }
}

function touchSelfPresence() {
  const host = os.hostname();
  const key = normalizeLowercaseStringOrEmpty(host);
  const existing = entries.get(key);
  if (existing) {
    entries.set(key, { ...existing, ts: Date.now() });
  } else {
    initSelfPresence();
  }
}

initSelfPresence();

function parsePresence(text: string): SystemPresence {
  const trimmed = text.trim();
  const pattern =
    /Node:\s*([^ (]+)\s*\(([^)]+)\)\s*·\s*app\s*([^·]+?)\s*·\s*last input\s*([0-9]+)s ago\s*·\s*mode\s*([^·]+?)\s*·\s*reason\s*(.+)$/i;
  const match = trimmed.match(pattern);
  if (!match) {
    return { text: trimmed, ts: Date.now() };
  }
  const [, host, ip, version, lastInputStr, mode, reasonRaw] = match;
  const lastInputSeconds = Number.parseInt(lastInputStr, 10);
  const reason = reasonRaw.trim();
  return {
    host: host.trim(),
    ip: ip.trim(),
    version: version.trim(),
    lastInputSeconds: Number.isFinite(lastInputSeconds) ? lastInputSeconds : undefined,
    mode: mode.trim(),
    reason,
    text: trimmed,
    ts: Date.now(),
  };
}

type SystemPresencePayload = {
  text: string;
  deviceId?: string;
  instanceId?: string;
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  lastInputSeconds?: number;
  mode?: string;
  reason?: string;
  roles?: string[];
  scopes?: string[];
  tags?: string[];
};

function mergeStringList(...values: Array<string[] | undefined>): string[] | undefined {
  const out = new Set<string>();
  for (const list of values) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const trimmed = normalizeOptionalString(item) ?? "";
      if (trimmed) {
        out.add(trimmed);
      }
    }
  }
  return out.size > 0 ? [...out] : undefined;
}

export function updateSystemPresence(payload: SystemPresencePayload): SystemPresenceUpdate {
  ensureSelfPresence();
  const parsed = parsePresence(payload.text);
  const key =
    normalizePresenceKey(payload.deviceId) ||
    normalizePresenceKey(payload.instanceId) ||
    normalizePresenceKey(parsed.instanceId) ||
    normalizePresenceKey(parsed.host) ||
    parsed.ip ||
    parsed.text.slice(0, 64) ||
    normalizeLowercaseStringOrEmpty(os.hostname());
  const hadExisting = entries.has(key);
  const existing = entries.get(key) ?? ({} as SystemPresence);
  const merged: SystemPresence = {
    ...existing,
    ...parsed,
    host: payload.host ?? parsed.host ?? existing.host,
    ip: payload.ip ?? parsed.ip ?? existing.ip,
    version: payload.version ?? parsed.version ?? existing.version,
    platform: payload.platform ?? existing.platform,
    deviceFamily: payload.deviceFamily ?? existing.deviceFamily,
    modelIdentifier: payload.modelIdentifier ?? existing.modelIdentifier,
    mode: payload.mode ?? parsed.mode ?? existing.mode,
    lastInputSeconds:
      payload.lastInputSeconds ?? parsed.lastInputSeconds ?? existing.lastInputSeconds,
    reason: payload.reason ?? parsed.reason ?? existing.reason,
    deviceId: payload.deviceId ?? existing.deviceId,
    roles: mergeStringList(existing.roles, payload.roles),
    scopes: mergeStringList(existing.scopes, payload.scopes),
    instanceId: payload.instanceId ?? parsed.instanceId ?? existing.instanceId,
    text: payload.text || parsed.text || existing.text,
    ts: Date.now(),
  };
  entries.set(key, merged);
  const trackKeys = ["host", "ip", "version", "mode", "reason"] as const;
  type TrackKey = (typeof trackKeys)[number];
  const changes: Partial<Pick<SystemPresence, TrackKey>> = {};
  const changedKeys: TrackKey[] = [];
  for (const k of trackKeys) {
    const prev = existing[k];
    const next = merged[k];
    if (prev !== next) {
      changes[k] = next;
      changedKeys.push(k);
    }
  }
  return {
    key,
    previous: hadExisting ? existing : undefined,
    next: merged,
    changes,
    changedKeys,
  } satisfies SystemPresenceUpdate;
}

export function upsertPresence(key: string, presence: Partial<SystemPresence>) {
  ensureSelfPresence();
  const normalizedKey = normalizePresenceKey(key) ?? normalizeLowercaseStringOrEmpty(os.hostname());
  const existing = entries.get(normalizedKey) ?? ({} as SystemPresence);
  const roles = mergeStringList(existing.roles, presence.roles);
  const scopes = mergeStringList(existing.scopes, presence.scopes);
  const merged: SystemPresence = {
    ...existing,
    ...presence,
    roles,
    scopes,
    ts: Date.now(),
    text:
      presence.text ||
      existing.text ||
      `Node: ${presence.host ?? existing.host ?? "unknown"} · mode ${
        presence.mode ?? existing.mode ?? "unknown"
      }`,
  };
  entries.set(normalizedKey, merged);
}

export function listSystemPresence(): SystemPresence[] {
  ensureSelfPresence();
  // prune expired
  const now = Date.now();
  for (const [k, v] of entries) {
    if (now - v.ts > TTL_MS) {
      entries.delete(k);
    }
  }
  // enforce max size (LRU by ts)
  if (entries.size > MAX_ENTRIES) {
    const sorted = [...entries.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
    const toDrop = entries.size - MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) {
      entries.delete(sorted[i][0]);
    }
  }
  touchSelfPresence();
  return [...entries.values()].toSorted((a, b) => b.ts - a.ts);
}
