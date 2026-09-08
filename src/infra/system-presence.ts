// Detects system command availability for setup and diagnostics.
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { resolveMachineModelIdentifier } from "./machine-model.js";
import { pickBestEffortPrimaryLanIPv4 } from "./network-discovery-display.js";
import { resolveDarwinProductVersion } from "./os-summary.js";

export type SystemPresence = {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  timeZone?: string;
  lastInputSeconds?: number;
  mode?: string;
  reason?: string;
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  instanceId?: string;
  user?: PresenceEntry["user"];
  watchedSessions?: string[];
  /** Server-owned timing for the person's current continuous live interval. */
  onlineSince?: number;
  lastActivityAt?: number;
  text: string;
  /** Heartbeat freshness, independent of person activity and online duration. */
  ts: number;
};

type StoredPresence = {
  presence: SystemPresence;
  freshness: number;
};

// The gateway owns a private key; caller-supplied string identities remain peers.
const SELF_KEY = Symbol("system-presence-self");
const entries = new Map<string | symbol, StoredPresence>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 200;
const SELF_INSTANCE_ID = randomUUID();
const uptimeOrigin = os.uptime() * 1000 - performance.now();
let freshnessTime = Date.now();
let freshnessSample = continuousTimeNow();

function continuousTimeNow(): number {
  // Uptime covers suspend on platforms where the high-resolution clock pauses.
  return Math.max(performance.now(), os.uptime() * 1000 - uptimeOrigin);
}

function freshnessNow(): number {
  const sample = continuousTimeNow();
  const elapsed = Math.max(0, sample - freshnessSample);
  freshnessSample = sample;
  // Preserve forward-clock expiry while continuous elapsed keeps rollback and suspend moving.
  freshnessTime = Math.max(Date.now(), freshnessTime + elapsed);
  return freshnessTime;
}

function setPresence(key: string | symbol, presence: SystemPresence) {
  entries.set(key, { presence, freshness: freshnessNow() });
}

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
  const modelIdentifier = resolveMachineModelIdentifier();
  const platform = (() => {
    const p = os.platform();
    const rel = os.release();
    if (p === "darwin") {
      return `macos ${resolveDarwinProductVersion()}`;
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
    instanceId: SELF_INSTANCE_ID,
    text,
    ts: Date.now(),
  };
  setPresence(SELF_KEY, selfEntry);
}

function touchSelfPresence() {
  const existing = entries.get(SELF_KEY)?.presence;
  if (existing) {
    setPresence(SELF_KEY, { ...existing, ts: Date.now() });
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
  if (
    host === undefined ||
    ip === undefined ||
    version === undefined ||
    lastInputStr === undefined ||
    mode === undefined ||
    reasonRaw === undefined
  ) {
    return { text: trimmed, ts: Date.now() };
  }
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
  lastInputSeconds?: number | null;
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

export function updateSystemPresence(payload: SystemPresencePayload) {
  const parsed = parsePresence(payload.text);
  const key =
    normalizePresenceKey(payload.deviceId) ||
    normalizePresenceKey(payload.instanceId) ||
    normalizePresenceKey(parsed.instanceId) ||
    normalizePresenceKey(parsed.host) ||
    parsed.ip ||
    truncateUtf16Safe(parsed.text, 64) ||
    normalizeLowercaseStringOrEmpty(os.hostname());
  const existing = entries.get(key)?.presence ?? ({} as SystemPresence);
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
      payload.lastInputSeconds === null
        ? undefined
        : (payload.lastInputSeconds ?? parsed.lastInputSeconds ?? existing.lastInputSeconds),
    reason: payload.reason ?? parsed.reason ?? existing.reason,
    deviceId: payload.deviceId ?? existing.deviceId,
    roles: mergeStringList(existing.roles, payload.roles),
    scopes: mergeStringList(existing.scopes, payload.scopes),
    instanceId: payload.instanceId ?? parsed.instanceId ?? existing.instanceId,
    text: payload.text || parsed.text || existing.text,
    ts: Date.now(),
  };
  setPresence(key, merged);
  const trackKeys = ["host", "ip", "version", "mode", "reason"] as const;
  const changedKeys = trackKeys.filter((field) => existing[field] !== merged[field]);
  return {
    key,
    next: merged,
    changedKeys,
  };
}

export function upsertPresence(key: string, presence: Partial<SystemPresence>) {
  const normalizedKey = normalizePresenceKey(key) ?? normalizeLowercaseStringOrEmpty(os.hostname());
  const existing = entries.get(normalizedKey)?.presence ?? ({} as SystemPresence);
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
  setPresence(normalizedKey, merged);
}

/** Renews an existing connection-owned presence row without recreating expired metadata. */
export function touchPresence(key: string): boolean {
  const normalizedKey = normalizePresenceKey(key);
  if (!normalizedKey) {
    return false;
  }
  const existing = entries.get(normalizedKey)?.presence;
  if (!existing) {
    return false;
  }
  setPresence(normalizedKey, { ...existing, ts: Date.now() });
  return true;
}

export function listSystemPresence(): SystemPresence[] {
  touchSelfPresence();
  const now = freshnessNow();
  for (const [key, entry] of entries) {
    if (key !== SELF_KEY && now - entry.freshness > TTL_MS) {
      entries.delete(key);
    }
  }
  // Expiry and capacity share one freshness order even when public timestamps roll back.
  if (entries.size > MAX_ENTRIES) {
    const sorted = [...entries.entries()]
      .filter(([key]) => key !== SELF_KEY)
      .toSorted((a, b) => a[1].freshness - b[1].freshness);
    const toDrop = entries.size - MAX_ENTRIES;
    for (const [key] of sorted.slice(0, toDrop)) {
      entries.delete(key);
    }
  }
  return [...entries.values()].map((entry) => entry.presence).toSorted((a, b) => b.ts - a.ts);
}
