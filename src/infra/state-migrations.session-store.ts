import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveAgentsDirFromSessionStorePath } from "../config/sessions/paths.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "../config/sessions/targets.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  listPluginDoctorSessionStoreAgentIds,
} from "../plugins/doctor-contract-registry.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isValidAgentId,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { expandHomePrefix } from "./home-dir.js";
import { isWithinDir } from "./path-safety.js";
import {
  existsDir,
  fileExists,
  parseSessionStoreJson5,
  readSessionStoreJson5,
  safeReadDir,
  type SessionEntryLike,
} from "./state-migrations.fs.js";
import { saveLegacySessionStore } from "./state-migrations.legacy-session-store.js";
import {
  getLegacySessionSurfaces,
  isLegacyGroupKey,
  isSurfaceGroupKey,
} from "./state-migrations.session-surfaces.js";
import type { SessionStoreAliasPlan } from "./state-migrations.types.js";

export function isLegacyDefaultMainAliasKey(key: string, mainKey: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(key.trim());
  const canonicalMainKey = normalizeMainKey(mainKey);
  return (
    lower === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` ||
    lower === `agent:${DEFAULT_AGENT_ID}:${canonicalMainKey}`
  );
}

function resolveCanonicalAgentSessionOwner(key: string): string | undefined {
  const parsed = parseAgentSessionKey(key);
  if (
    parsed === null ||
    !isValidAgentId(parsed.agentId) ||
    normalizeAgentId(parsed.agentId) !== parsed.agentId
  ) {
    return undefined;
  }
  return parsed.agentId;
}

function canonicalizeSessionKeyForAgent(params: {
  key: string;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
  preserveCanonicalAgentOwner?: boolean;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
}): string {
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  const legacyDefaultMainAlias = isLegacyDefaultMainAliasKey(rawLower, params.mainKey);
  const configuredAgentId = normalizeAgentId(params.agentId);
  const canonicalRowOwner = resolveCanonicalAgentSessionOwner(raw);
  // Shared stores may contain rows for several agents. Canonicalize a valid
  // wrapper within its declared owner so another agent pass cannot adopt it.
  // The default-agent main alias remains an orphan when a different single
  // owner is authoritative for this store.
  const candidateOwner = params.preserveCanonicalAgentOwner ? canonicalRowOwner : undefined;
  const parsedOwner =
    candidateOwner === DEFAULT_AGENT_ID &&
    configuredAgentId !== DEFAULT_AGENT_ID &&
    legacyDefaultMainAlias
      ? undefined
      : candidateOwner;
  const agentId = parsedOwner ?? configuredAgentId;
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }
  // Plugin-routed stores can contain either a core orphan or an opaque explicit
  // key with this shape. Without row provenance, never merge the two.
  if (params.preserveForeignMainAliases && legacyDefaultMainAlias) {
    return params.key;
  }
  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: normalized,
  });
  // Global scope has one owner, so recognized main aliases are never ambiguous.
  if (params.scope === "global" && canonicalMain === "global") {
    return canonicalMain;
  }
  // Unscoped and legacy default-main keys in a potentially shared store have no durable owner.
  // Keep it untouched instead of assigning another agent's history by iteration order.
  if (params.preserveAmbiguousKeys && (!canonicalRowOwner || legacyDefaultMainAlias)) {
    return params.key;
  }

  // When shared-store guard is active, do not remap keys that belong to a
  // different agent — they are legitimate records for that agent, not orphans.
  // Without this check, canonicalizeMainSessionAlias (which now recognises
  // legacy agent:main:* aliases) would rewrite them before the
  // skipCrossAgentRemap guard below has a chance to block it.
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
      return normalized;
    }
    if (
      agentId !== DEFAULT_AGENT_ID &&
      (rawLower === DEFAULT_MAIN_KEY || rawLower === params.mainKey)
    ) {
      return rawLower;
    }
  }

  if (canonicalMain !== normalized) {
    return normalizeLowercaseStringOrEmpty(canonicalMain);
  }

  // Handle cross-agent orphaned main-session keys: "agent:main:main" or
  // "agent:main:<mainKey>" in a store belonging to a different agent (e.g.
  // "ops"). Only remap provable orphan aliases — other agent:main:* keys
  // (hooks, subagents, cron, per-sender) may be intentional cross-agent
  // references and must not be touched (#29683).
  const defaultPrefix = `agent:${DEFAULT_AGENT_ID}:`;
  if (
    rawLower.startsWith(defaultPrefix) &&
    agentId !== DEFAULT_AGENT_ID &&
    !params.skipCrossAgentRemap
  ) {
    const rest = rawLower.slice(defaultPrefix.length);
    const isOrphanAlias = rest === DEFAULT_MAIN_KEY || rest === params.mainKey;
    if (isOrphanAlias) {
      const remapped = `agent:${agentId}:${rest}`;
      const canonicalized = canonicalizeMainSessionAlias({
        cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
        agentId,
        sessionKey: remapped,
      });
      return normalizeLowercaseStringOrEmpty(canonicalized);
    }
  }

  // A malformed agent-shaped key has no authoritative row owner. Once shared-store
  // preservation is ruled out, treat it as opaque input owned by the configured agent.
  if (rawLower.startsWith("agent:") && canonicalRowOwner) {
    return normalized;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
  }
  // Channel-owned legacy shapes must win before the generic group/channel
  // fallback so plugin-specific legacy group keys can canonicalize to their
  // owning channel instead of the generic `...:unknown:group:...` bucket.
  for (const surface of getLegacySessionSurfaces()) {
    const canonicalized = surface.canonicalizeLegacySessionKey?.({
      key: raw,
      agentId,
    });
    const normalizedCanonicalized = normalizeSessionKeyPreservingOpaquePeerIds(canonicalized);
    if (normalizedCanonicalized) {
      return normalizedCanonicalized;
    }
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
  }
  if (isSurfaceGroupKey(raw)) {
    return `agent:${agentId}:${normalized}`;
  }
  return normalizeSessionKeyPreservingOpaquePeerIds(`agent:${agentId}:${raw}`);
}

export function pickLatestLegacyDirectEntry(
  store: Record<string, SessionEntryLike>,
): SessionEntryLike | null {
  let best: SessionEntryLike | null = null;
  let bestUpdated = -1;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    const normalizedLower = normalizeLowercaseStringOrEmpty(normalized);
    if (normalizedLower === "global") {
      continue;
    }
    if (normalizedLower.startsWith("agent:")) {
      continue;
    }
    if (normalizedLower.startsWith("subagent:")) {
      continue;
    }
    if (isLegacyGroupKey(normalized) || isSurfaceGroupKey(normalized)) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (updatedAt > bestUpdated) {
      bestUpdated = updatedAt;
      best = entry;
    }
  }
  return best;
}

export function normalizeSessionEntry(entry: SessionEntryLike): SessionEntry | null {
  const shaped = normalizePersistedSessionEntryShape(entry);
  if (!shaped) {
    return null;
  }
  const normalized = { ...shaped };
  if (typeof normalized.sessionId === "string") {
    normalized.updatedAt =
      typeof normalized.updatedAt === "number" && Number.isFinite(normalized.updatedAt)
        ? normalized.updatedAt
        : Date.now();
  }
  const rec = normalized as unknown as Record<string, unknown>;
  if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
    rec.groupChannel = rec.room;
  }
  delete rec.room;
  return normalized;
}

function resolveUpdatedAt(entry: SessionEntryLike): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

export function mergeSessionEntry(params: {
  existing: SessionEntryLike | undefined;
  incoming: SessionEntryLike;
  preferIncomingOnTie?: boolean;
}): SessionEntryLike {
  if (!params.existing) {
    return params.incoming;
  }
  const existingUpdated = resolveUpdatedAt(params.existing);
  const incomingUpdated = resolveUpdatedAt(params.incoming);
  if (incomingUpdated > existingUpdated) {
    return params.incoming;
  }
  if (incomingUpdated < existingUpdated) {
    return params.existing;
  }
  return params.preferIncomingOnTie ? params.incoming : params.existing;
}

export function canonicalizeSessionStore(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
  preserveCanonicalAgentOwner?: boolean;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical = Object.create(null) as Record<string, SessionEntryLike>;
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.skipCrossAgentRemap,
      preserveCanonicalAgentOwner: params.preserveCanonicalAgentOwner,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existing = canonical[canonicalKey];
    if (!existing) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: resolveUpdatedAt(entry) });
      continue;
    }

    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = resolveUpdatedAt(entry);
    const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
    if (incomingUpdated > existingUpdated) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
    if (incomingUpdated < existingUpdated) {
      continue;
    }
    if (existingMeta?.isCanonical && !isCanonical) {
      continue;
    }
    if (!existingMeta?.isCanonical && isCanonical) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
  }

  return { store: canonical, legacyKeys };
}

export function isAmbiguousSharedStoreKey(
  key: string,
  mainKey: string,
  scope?: SessionScope,
): boolean {
  const raw = key.trim();
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (!raw || lower === "global" || lower === "unknown") {
    return false;
  }
  if (
    scope === "global" &&
    canonicalizeMainSessionAlias({
      cfg: { session: { scope, mainKey } },
      agentId: DEFAULT_AGENT_ID,
      sessionKey: lower,
    }) === "global"
  ) {
    return false;
  }
  return !resolveCanonicalAgentSessionOwner(raw) || isLegacyDefaultMainAliasKey(lower, mainKey);
}

export function aliasedSessionStoreMigrationWarning(params: {
  subject: "migration of" | "ACP metadata migration for";
  count: number;
  storePath: string;
}): string {
  return `Deferred ${params.subject} ${params.count} ambiguous session key(s) in aliased store ${params.storePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function unresolvedSessionStoreIdentityWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} for ${storePath}; filesystem identity could not be established for every configured store path. Restore path access or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function distinctSessionStoreAliasWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} in aliased store ${storePath}; atomic replacement cannot update distinct filesystem aliases as one operation. Remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function resolveStaleLegacySessionFile(params: {
  entry: unknown;
  legacyDir: string;
  targetDir: string;
}): string | undefined {
  if (!params.entry || typeof params.entry !== "object" || Array.isArray(params.entry)) {
    return undefined;
  }
  const entry = params.entry as SessionEntryLike;
  const rawSessionFile = entry.sessionFile;
  if (typeof rawSessionFile !== "string") {
    return undefined;
  }
  const legacySessionFile = path.isAbsolute(rawSessionFile)
    ? path.resolve(rawSessionFile)
    : path.resolve(params.legacyDir, rawSessionFile);
  const relative = path.relative(path.resolve(params.legacyDir), legacySessionFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || fileExists(legacySessionFile)) {
    return undefined;
  }
  const legacyBackupHasTranscript = safeReadDir(path.dirname(params.legacyDir)).some(
    (dirent) =>
      dirent.isDirectory() &&
      dirent.name.startsWith(`${path.basename(params.legacyDir)}.legacy-`) &&
      fileExists(
        path.join(path.dirname(params.legacyDir), dirent.name, path.basename(legacySessionFile)),
      ),
  );
  if (legacyBackupHasTranscript) {
    return undefined;
  }
  const parsed = path.parse(path.basename(legacySessionFile));
  const hasCollisionRename = safeReadDir(params.targetDir).some(
    (dirent) =>
      dirent.isFile() &&
      dirent.name.startsWith(`${parsed.name}.legacy-`) &&
      dirent.name.endsWith(parsed.ext),
  );
  if (hasCollisionRename) {
    return undefined;
  }
  const targetSessionFile = path.join(params.targetDir, path.basename(legacySessionFile));
  if (!fileExists(targetSessionFile) || typeof entry.sessionId !== "string") {
    return undefined;
  }
  const readFirstLine = () => {
    const fd = fs.openSync(targetSessionFile, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) {
        return undefined;
      }
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = chunk.indexOf("\n");
      return newline >= 0 ? chunk.slice(0, newline) : chunk;
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    const firstLine = readFirstLine();
    const header = firstLine ? (JSON.parse(firstLine) as unknown) : undefined;
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return undefined;
    }
    if ((header as { type?: unknown }).type === "session") {
      return (header as { id?: unknown }).id === entry.sessionId ? targetSessionFile : undefined;
    }
    const canonicalFileName =
      path.basename(entry.sessionId) === entry.sessionId ? `${entry.sessionId}.jsonl` : undefined;
    return canonicalFileName === path.basename(targetSessionFile) ? targetSessionFile : undefined;
  } catch {
    return undefined;
  }
}

function skipJson5Trivia(raw: string, index: number): number {
  let i = index;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      return i < raw.length ? i + 2 : i;
    }
    break;
  }
  return i;
}

function readJson5String(raw: string, index: number): { value: string; next: number } | null {
  const quote = raw[index];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let i = index + 1;
  let value = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === quote) {
      return { value, next: i + 1 };
    }
    if (ch === "\\") {
      return null;
    }
    value += ch;
    i++;
  }
  return null;
}

function readJson5BareKey(raw: string, index: number): { value: string; next: number } | null {
  let i = index;
  while (i < raw.length) {
    const ch = raw[i];
    if (
      ch === ":" ||
      ch === " " ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "\t" ||
      ch === "," ||
      ch === "}" ||
      ch === "{" ||
      ch === "[" ||
      ch === "]"
    ) {
      break;
    }
    i++;
  }
  if (i === index) {
    return null;
  }
  return { value: raw.slice(index, i), next: i };
}

function listTopLevelSessionStoreKeys(raw: string): string[] | null {
  let i = skipJson5Trivia(raw, 0);
  if (raw[i] !== "{") {
    return null;
  }
  i++;
  const keys: string[] = [];
  let depth = 1;
  let expectingKey = true;

  while (i < raw.length) {
    i = skipJson5Trivia(raw, i);
    const ch = raw[i];
    if (ch === undefined) {
      return null;
    }
    if (depth === 1 && ch === "}") {
      return keys;
    }
    if (depth === 1 && expectingKey) {
      const key = ch === '"' || ch === "'" ? readJson5String(raw, i) : readJson5BareKey(raw, i);
      if (!key) {
        return null;
      }
      i = skipJson5Trivia(raw, key.next);
      if (raw[i] !== ":") {
        return null;
      }
      keys.push(key.value);
      i++;
      expectingKey = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const str = readJson5String(raw, i);
      if (!str) {
        return null;
      }
      i = str.next;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      i++;
      if (depth < 1) {
        return keys;
      }
      continue;
    }
    if (depth === 1 && ch === ",") {
      expectingKey = true;
      i++;
      continue;
    }
    i++;
  }
  return null;
}

function sessionStoreTextMayNeedCanonicalization(params: {
  raw: string;
  storeAgentIds: Iterable<string>;
  mainKey: string;
  scope?: SessionScope;
  preserveForeignMainAliases?: boolean;
}): boolean {
  const keys = listTopLevelSessionStoreKeys(params.raw);
  if (!keys) {
    return true;
  }
  const storeAgentIds = new Set([...params.storeAgentIds].map((id) => normalizeAgentId(id)));
  const hasNonMainAgent = [...storeAgentIds].some((id) => id !== DEFAULT_AGENT_ID);
  for (const key of keys) {
    const rawKey = key.trim();
    if (rawKey !== key) {
      return true;
    }
    if (!rawKey) {
      continue;
    }
    const lowerKey = normalizeLowercaseStringOrEmpty(rawKey);
    if (lowerKey !== rawKey) {
      return true;
    }
    if (lowerKey === "global" || lowerKey === "unknown") {
      continue;
    }
    if (
      params.preserveForeignMainAliases &&
      isLegacyDefaultMainAliasKey(lowerKey, params.mainKey)
    ) {
      return true;
    }
    if (lowerKey === DEFAULT_MAIN_KEY || lowerKey === params.mainKey) {
      return true;
    }
    if (lowerKey.startsWith("subagent:")) {
      return true;
    }
    if (lowerKey.startsWith("group:") || lowerKey.startsWith("channel:")) {
      return true;
    }
    if (!lowerKey.startsWith("agent:")) {
      return true;
    }
    const rowOwner = resolveCanonicalAgentSessionOwner(rawKey);
    if (!rowOwner) {
      return true;
    }
    const agentMainAlias = `agent:${rowOwner}:${DEFAULT_MAIN_KEY}`;
    const agentMainKey = `agent:${rowOwner}:${params.mainKey}`;
    if (
      lowerKey === agentMainAlias &&
      (params.mainKey !== DEFAULT_MAIN_KEY || params.scope === "global")
    ) {
      return true;
    }
    if (lowerKey === agentMainKey && params.scope === "global") {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` &&
      (params.mainKey !== DEFAULT_MAIN_KEY || hasNonMainAgent || params.scope === "global")
    ) {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${params.mainKey}` &&
      hasNonMainAgent &&
      !storeAgentIds.has(DEFAULT_AGENT_ID)
    ) {
      return true;
    }
  }
  return false;
}

export function listLegacySessionKeys(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.preserveAmbiguousKeys,
      preserveCanonicalAgentOwner: params.preserveAmbiguousKeys,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
    });
    if (canonical !== key) {
      legacy.push(key);
    }
  }
  return legacy;
}

export function emptyDirOrMissing(dir: string): boolean {
  if (!existsDir(dir)) {
    return true;
  }
  return safeReadDir(dir).length === 0;
}

export function removeDirIfEmpty(dir: string) {
  if (!existsDir(dir)) {
    return;
  }
  if (!emptyDirOrMissing(dir)) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

export async function migrateOrphanedSessionKeys(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  additionalAgentIds?: readonly string[];
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeConfig = params.cfg.session?.store;
  const pluginAgentIds =
    params.additionalAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    });
  const pluginAgentIdSet = new Set(pluginAgentIds.map((id) => normalizeAgentId(id)));

  // Collect all known agent store paths with their owning agentIds.
  // A single path may be shared by multiple agents when session.store
  // does not contain {agentId}.
  const storeMap = new Map<string, Set<string>>();
  const storeAliasCandidates = new Map<string, Set<string>>();
  const addToStoreMap = (p: string, id: string) => {
    // Existing aliases are one ownership surface. Group them before any atomic
    // rewrite can replace one pathname and hide their original identity.
    const storePath =
      [...storeMap.keys()].find((candidate) => sessionStorePathsMatch(candidate, p)) ?? p;
    const aliasCandidates = storeAliasCandidates.get(storePath) ?? new Set([storePath]);
    aliasCandidates.add(p);
    storeAliasCandidates.set(storePath, aliasCandidates);
    const existing = storeMap.get(storePath);
    if (existing) {
      existing.add(id);
    } else {
      storeMap.set(storePath, new Set([id]));
    }
  };
  // Configured ownership includes normal agents plus ACP runtime/default hints.
  for (const configuredAgentId of listConfiguredSessionStoreAgentIds(params.cfg)) {
    const id = normalizeAgentId(configuredAgentId);
    const p = storeConfig
      ? resolveStorePathFromTemplate(storeConfig, id, env)
      : path.join(stateDir, "agents", id, "sessions", "sessions.json");
    addToStoreMap(p, id);
  }
  // Plugins can route core sessions to agents that are not declared in
  // agents.list. A templated path proves ownership for those stores too.
  for (const pluginAgentId of pluginAgentIds) {
    const id = normalizeAgentId(pluginAgentId);
    const p = storeConfig
      ? resolveStorePathFromTemplate(storeConfig, id, env)
      : path.join(stateDir, "agents", id, "sessions", "sessions.json");
    addToStoreMap(p, id);
  }
  // Agent directories present on disk.
  // This only covers the standard state-dir layout so we can still pick up
  // orphaned stores left behind by older configs. Active custom-template paths
  // are already covered by the configured-agents loop above.
  const agentsDir = path.join(stateDir, "agents");
  if (existsDir(agentsDir)) {
    for (const dirEntry of safeReadDir(agentsDir)) {
      if (dirEntry.isDirectory()) {
        const diskAgentId = normalizeAgentId(dirEntry.name);
        if (diskAgentId) {
          const diskPath = path.join(agentsDir, diskAgentId, "sessions", "sessions.json");
          addToStoreMap(diskPath, diskAgentId);
        }
      }
    }
  }

  for (const [mappedStorePath, storeAgentIds] of storeMap) {
    const storePaths = storeAliasCandidates.get(mappedStorePath) ?? new Set([mappedStorePath]);
    // An unknown relationship may have grouped a readable store behind an
    // inaccessible pathname. Read from a usable alias so the group still gets
    // the unresolved-identity warning before any rewrite is attempted.
    const storePath = [...storePaths].find((candidate) => fileExists(candidate));
    if (!storePath) {
      continue;
    }
    const pluginForeignMainAliasRisk = [...storeAgentIds].some(
      (id) => pluginAgentIdSet.has(id) && id !== DEFAULT_AGENT_ID,
    );
    let raw: string;
    try {
      raw = fs.readFileSync(storePath, "utf-8");
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (
      !sessionStoreTextMayNeedCanonicalization({
        raw,
        storeAgentIds,
        mainKey,
        scope,
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
      })
    ) {
      continue;
    }
    let parsed: ReturnType<typeof readSessionStoreJson5>;
    try {
      parsed = parseSessionStoreJson5(raw);
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (!parsed.ok) {
      continue;
    }

    // A physical store can have several owners. Canonicalize valid scoped rows
    // within their declared owner on every pass so iteration order cannot move
    // one agent's history into another namespace.
    let working = parsed.store;
    let totalLegacy = 0;
    const storeAliases = resolveSessionStoreAliasPlan(storePath, storePaths);
    const hasDistinctAliases = storeAliases.hasDistinctAliases;
    const preserveAmbiguousKeys = storeAgentIds.size > 1;
    const preservedAmbiguousKeyCount = Object.keys(working).filter(
      (key) =>
        (preserveAmbiguousKeys && isAmbiguousSharedStoreKey(key, mainKey, scope)) ||
        (pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(key, mainKey)),
    ).length;
    if (storeAliases.hasUnresolvedIdentity) {
      warnings.push(unresolvedSessionStoreIdentityWarning("session key migration", storePath));
      continue;
    }
    if (hasDistinctAliases && preservedAmbiguousKeyCount > 0) {
      warnings.push(
        aliasedSessionStoreMigrationWarning({
          subject: "migration of",
          count: preservedAmbiguousKeyCount,
          storePath,
        }),
      );
      continue;
    }
    if (storeAliases.hasFinalSymlink) {
      warnings.push(
        `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      );
      continue;
    }
    if (hasDistinctAliases) {
      warnings.push(distinctSessionStoreAliasWarning("session key migration", storePath));
      continue;
    }
    for (const storeAgentId of storeAgentIds) {
      const { store: canonicalized, legacyKeys } = canonicalizeSessionStore({
        store: working,
        agentId: storeAgentId,
        mainKey,
        scope,
        skipCrossAgentRemap: preserveAmbiguousKeys,
        preserveCanonicalAgentOwner: true,
        preserveAmbiguousKeys,
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
      });
      working = canonicalized;
      // Each pass only counts keys it changed from the current working store, so
      // once a key is canonicalized it is not counted again by later agent passes.
      totalLegacy += legacyKeys.length;
    }
    if (preservedAmbiguousKeyCount > 0) {
      warnings.push(
        `Preserved ${preservedAmbiguousKeyCount} ambiguous session key(s) in potentially shared store ${storePath}`,
      );
    }
    if (totalLegacy === 0) {
      continue;
    }
    const normalized = Object.create(null) as Record<string, SessionEntry>;
    for (const [key, entry] of Object.entries(working)) {
      const ne = normalizeSessionEntry(entry);
      if (ne) {
        normalized[key] = ne;
      }
    }
    try {
      await saveSessionStoreStrict(storePath, normalized);
      changes.push(`Canonicalized ${totalLegacy} orphaned session key(s) in ${storePath}`);
    } catch (err) {
      warnings.push(`Failed to write canonicalized store ${storePath}: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

export async function migrateLegacyAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  pluginSessionStoreAgentIds?: readonly string[];
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const now = params.now ?? (() => Date.now());
  const stateDir = resolveStateDir(env);
  const storeConfig = params.cfg.session?.store;
  const pluginAgentIds =
    params.pluginSessionStoreAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    });
  const normalizedPluginAgentIds = new Set(pluginAgentIds.map((id) => normalizeAgentId(id)));
  const declaredAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...normalizedPluginAgentIds,
  ]);
  const declaredTargets = [...declaredAgentIds].map((agentId) => ({
    agentId,
    storePath: storeConfig
      ? resolveStorePathFromTemplate(storeConfig, agentId, env)
      : path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
  }));
  const pluginTargets = declaredTargets.filter(
    ({ agentId }) => agentId !== DEFAULT_AGENT_ID && normalizedPluginAgentIds.has(agentId),
  );
  const configuredAgents = listAgentEntries(params.cfg);
  const configuredAgentIds = new Set(
    configuredAgents.flatMap((entry) => (entry?.id ? [normalizeAgentId(entry.id)] : [])),
  );
  const discoveryCfg = [...declaredAgentIds].some((agentId) => !configuredAgentIds.has(agentId))
    ? ({
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          list: [
            ...configuredAgents,
            ...[...declaredAgentIds]
              .filter((agentId) => !configuredAgentIds.has(agentId))
              .map((id) => ({ id })),
          ],
        },
      } as OpenClawConfig)
    : params.cfg;
  // Reuse the validated resolver for every declared owner. Owner multiplicity
  // is restored below as metadata without re-adding rejected raw paths.
  const targets = resolveLegacyAcpMetadataSessionStoreTargets(discoveryCfg, env);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeGroups: Array<{
    target: (typeof targets)[number];
    agentIds: Set<string>;
    aliasCandidates: Set<string>;
  }> = [];

  for (const target of targets) {
    if (!fileExists(target.storePath)) {
      continue;
    }
    const group = storeGroups.find(({ target: existing }) =>
      sessionStorePathsMatch(existing.storePath, target.storePath),
    );
    const matchingDeclaredTargets = declaredTargets.filter((declaredTarget) =>
      sessionStorePathsMatch(target.storePath, declaredTarget.storePath),
    );
    if (group) {
      group.agentIds.add(normalizeAgentId(target.agentId));
      group.aliasCandidates.add(target.storePath);
      for (const declaredTarget of matchingDeclaredTargets) {
        group.agentIds.add(declaredTarget.agentId);
        group.aliasCandidates.add(declaredTarget.storePath);
      }
      continue;
    }
    storeGroups.push({
      target,
      agentIds: new Set([
        normalizeAgentId(target.agentId),
        ...matchingDeclaredTargets.map((declaredTarget) => declaredTarget.agentId),
      ]),
      aliasCandidates: new Set([
        target.storePath,
        ...matchingDeclaredTargets.map((declaredTarget) => declaredTarget.storePath),
      ]),
    });
  }

  for (const { target, agentIds, aliasCandidates } of storeGroups) {
    const storePath = target.storePath;
    const storeAliases = resolveSessionStoreAliasPlan(storePath, aliasCandidates);
    const pluginForeignMainAliasRisk = pluginTargets.some((pluginTarget) =>
      sessionStorePathsMatch(storePath, pluginTarget.storePath),
    );
    let parsed: ReturnType<typeof readSessionStoreJson5>;
    try {
      parsed = readSessionStoreJson5(storePath);
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (!parsed.ok) {
      continue;
    }
    const ambiguousKeyCount = Object.keys(parsed.store).filter(
      (key) =>
        isAmbiguousSharedStoreKey(key, mainKey, scope) ||
        (pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(key, mainKey)),
    ).length;
    const hasLegacyAcpMetadata = Object.values(parsed.store).some(
      (entry) => normalizeSessionEntry(entry)?.acp !== undefined,
    );
    if (hasLegacyAcpMetadata && storeAliases.hasUnresolvedIdentity) {
      warnings.push(unresolvedSessionStoreIdentityWarning("ACP metadata migration", storePath));
      continue;
    }
    if (hasLegacyAcpMetadata && storeAliases.hasFinalSymlink) {
      warnings.push(
        `Deferred ACP metadata migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      );
      continue;
    }
    if (hasLegacyAcpMetadata && storeAliases.hasDistinctAliases) {
      // Removing ACP metadata rewrites the store and would split its aliases.
      warnings.push(
        ambiguousKeyCount > 0
          ? aliasedSessionStoreMigrationWarning({
              subject: "ACP metadata migration for",
              count: ambiguousKeyCount,
              storePath,
            })
          : distinctSessionStoreAliasWarning("ACP metadata migration", storePath),
      );
      continue;
    }

    const normalized = Object.create(null) as Record<string, SessionEntry>;
    let migrated = 0;
    let preserved = 0;
    for (const [sessionKey, entry] of Object.entries(parsed.store)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      if (normalizedEntry.acp) {
        const ambiguousSharedStoreKey = isAmbiguousSharedStoreKey(sessionKey, mainKey, scope);
        const ambiguousMultiOwnerKey = agentIds.size > 1 && ambiguousSharedStoreKey;
        const foreignMainAlias =
          pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(sessionKey, mainKey);
        if (ambiguousMultiOwnerKey || foreignMainAlias) {
          preserved++;
          normalized[sessionKey] = normalizedEntry;
          continue;
        }
        const rowAgentId = resolveCanonicalAgentSessionOwner(sessionKey) ?? target.agentId;
        const canonicalSessionKey = canonicalizeSessionKeyForAgent({
          key: sessionKey,
          agentId: rowAgentId,
          mainKey,
          scope,
          skipCrossAgentRemap: true,
        });
        writeAcpSessionMetaForMigration({
          sessionKey: canonicalSessionKey,
          sessionId: normalizedEntry.sessionId,
          lifecycleRevision: normalizedEntry.lifecycleRevision,
          meta: normalizedEntry.acp,
          env,
          now,
        });
        delete normalizedEntry.acp;
        migrated++;
      }
      normalized[sessionKey] = normalizedEntry;
    }
    if (preserved > 0) {
      warnings.push(
        `Preserved ACP metadata for ${preserved} ambiguous session key(s) in potentially shared store ${storePath}`,
      );
    }
    if (migrated === 0) {
      continue;
    }
    try {
      await saveSessionStoreStrict(storePath, normalized);
      changes.push(
        `Migrated ${migrated} ACP session metadata ${migrated === 1 ? "row" : "rows"} → shared SQLite state`,
      );
    } catch (err) {
      warnings.push(`Failed to write ACP metadata migration source ${storePath}: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

// Doctor migration must read legacy session stores even before a per-agent
// SQLite DB exists; active runtime discovery remains SQLite-validated.
function resolveLegacyAcpMetadataSessionStoreTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Array<{ agentId: string; storePath: string }> {
  const stateDir = resolveStateDir(env);
  const agentsDirs = new Set<string>([path.join(stateDir, "agents")]);
  const targets = new Map<string, { agentId: string; storePath: string }>();
  const addTarget = (agentId: string, storePath: string) => {
    if (!isManagedLegacySessionStorePathSafe(storePath)) {
      return;
    }
    const agentsDir = resolveAgentsDirFromSessionStorePath(storePath);
    if (agentsDir) {
      agentsDirs.add(agentsDir);
    }
    if (!targets.has(storePath)) {
      targets.set(storePath, { agentId, storePath });
    }
  };

  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    addTarget(target.agentId, target.storePath);
  }
  for (const target of resolveSessionStoreTargets(cfg, { allAgents: true }, { env })) {
    addTarget(target.agentId, target.storePath);
  }

  for (const agentsDir of agentsDirs) {
    if (!existsDir(agentsDir)) {
      continue;
    }
    for (const entry of safeReadDir(agentsDir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      const agentId = normalizeAgentId(entry.name);
      const normalizedDirName = normalizeLowercaseStringOrEmpty(entry.name);
      if (agentId === DEFAULT_AGENT_ID && normalizedDirName !== agentId) {
        continue;
      }
      addTarget(agentId, path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  return [...targets.values()];
}

function isManagedLegacySessionStorePathSafe(storePath: string): boolean {
  const resolvedStorePath = path.resolve(storePath);
  const agentsDir = resolveAgentsDirFromSessionStorePath(resolvedStorePath);
  if (!agentsDir) {
    return true;
  }
  if (!fileExists(resolvedStorePath)) {
    return true;
  }

  try {
    const stat = fs.lstatSync(resolvedStorePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }
    const resolvedAgentsDir = path.resolve(agentsDir);
    const realStorePath = fs.realpathSync.native(resolvedStorePath);
    const realAgentsDir = fs.realpathSync.native(resolvedAgentsDir);
    return isWithinDir(realAgentsDir, realStorePath);
  } catch {
    return false;
  }
}

function resolveStorePathFromTemplate(
  template: string,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  const expand = (s: string) =>
    s.startsWith("~") ? expandHomePrefix(s, { env: env ?? process.env, homedir: os.homedir }) : s;
  if (template.includes("{agentId}")) {
    return path.resolve(expand(template.replaceAll("{agentId}", agentId)));
  }
  return path.resolve(expand(template));
}

type SessionStorePathRelationship = "same" | "different" | "unknown";

function resolveSessionStorePathRelationship(
  left: string,
  right: string,
): SessionStorePathRelationship {
  if (left === right) {
    return "same";
  }
  try {
    return sameFileIdentity(
      fs.statSync(left, { bigint: true }),
      fs.statSync(right, { bigint: true }),
    )
      ? "same"
      : "different";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return "unknown";
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    if (resolvedLeft === undefined || resolvedRight === undefined) {
      return "unknown";
    }
    return resolvedLeft === resolvedRight ? "same" : "different";
  }
}

function sessionStorePathsMatch(left: string, right: string): boolean {
  // Ownership checks must fail closed: an inaccessible path may still alias the
  // readable store, so preserve shared-owner policy until identity is known.
  return resolveSessionStorePathRelationship(left, right) !== "different";
}

function resolvePathThroughExistingParents(filePath: string): string | undefined {
  const resolvedPath = path.resolve(filePath);
  const suffix = [path.basename(resolvedPath)];
  let parentPath = path.dirname(resolvedPath);
  while (true) {
    try {
      return path.join(fs.realpathSync.native(parentPath), ...suffix);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return undefined;
      }
      const nextParent = path.dirname(parentPath);
      if (nextParent === parentPath) {
        return undefined;
      }
      suffix.unshift(path.basename(parentPath));
      parentPath = nextParent;
    }
  }
}

function sessionStorePathIsFinalSymlink(storePath: string): boolean {
  try {
    return fs.lstatSync(storePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function sessionStorePathsHaveDistinctEntries(left: string, right: string): boolean {
  if (left === right) {
    return false;
  }
  try {
    // Replacing a final-component symlink splits it from its target. Parent
    // symlink spellings are safe because both names still address one entry.
    if (fs.lstatSync(left).isSymbolicLink() || fs.lstatSync(right).isSymbolicLink()) {
      return true;
    }
    // Hard links resolve to distinct pathnames and split on replacement.
    return fs.realpathSync.native(left) !== fs.realpathSync.native(right);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return true;
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    return resolvedLeft === undefined || resolvedLeft !== resolvedRight;
  }
}

function resolveSessionStoreAliasPlan(
  storePath: string,
  candidatePaths: Iterable<string>,
): SessionStoreAliasPlan {
  let hasDistinctEntries = false;
  let hasFinalSymlink = sessionStorePathIsFinalSymlink(storePath);
  let hasUnresolvedIdentity = false;
  for (const candidatePath of candidatePaths) {
    const relationship = resolveSessionStorePathRelationship(storePath, candidatePath);
    if (relationship === "different") {
      continue;
    }
    if (relationship === "unknown") {
      hasUnresolvedIdentity = true;
      continue;
    }
    hasFinalSymlink ||= sessionStorePathIsFinalSymlink(candidatePath);
    if (sessionStorePathsHaveDistinctEntries(storePath, candidatePath)) {
      hasDistinctEntries = true;
    }
  }
  return {
    hasDistinctAliases: hasFinalSymlink || hasDistinctEntries || hasUnresolvedIdentity,
    hasFinalSymlink,
    hasUnresolvedIdentity,
  };
}

export function mergeSessionStoreAliasPlans(
  left: SessionStoreAliasPlan | undefined,
  right: SessionStoreAliasPlan,
): SessionStoreAliasPlan {
  if (!left) {
    return right;
  }
  return {
    hasDistinctAliases: left.hasDistinctAliases || right.hasDistinctAliases,
    hasFinalSymlink: left.hasFinalSymlink || right.hasFinalSymlink,
    hasUnresolvedIdentity: left.hasUnresolvedIdentity || right.hasUnresolvedIdentity,
  };
}

export async function saveSessionStoreStrict(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await saveLegacySessionStore(storePath, store, {
    requireWriteSuccess: true,
    skipMaintenance: true,
  });
}

export type SessionStoreOwnership = {
  preserveAmbiguousKeys: boolean;
  preserveForeignMainAliases: boolean;
  targetStoreAliases: SessionStoreAliasPlan;
};

export function resolveSessionStoreOwnership(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  targetAgentId: string;
  pluginSessionStoreAgentIds: readonly string[];
}): SessionStoreOwnership {
  const targetStorePath = path.join(
    params.stateDir,
    "agents",
    params.targetAgentId,
    "sessions",
    "sessions.json",
  );
  const configuredStore = params.cfg.session?.store;
  const resolveAgentStorePath = (agentId: string) =>
    configuredStore
      ? resolveStorePathFromTemplate(configuredStore, agentId, params.env)
      : path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
  const preserveForeignMainAliases = params.pluginSessionStoreAgentIds.some((pluginAgentId) => {
    const id = normalizeAgentId(pluginAgentId);
    if (id === DEFAULT_AGENT_ID) {
      return false;
    }
    return sessionStorePathsMatch(resolveAgentStorePath(id), targetStorePath);
  });
  const candidateAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...params.pluginSessionStoreAgentIds.map((id) => normalizeAgentId(id)),
  ]);
  const configuredOwnerStorePaths = [...candidateAgentIds].map(resolveAgentStorePath);
  const targetStoreOwnerCount = configuredOwnerStorePaths.filter((storePath) =>
    sessionStorePathsMatch(storePath, targetStorePath),
  ).length;
  const preserveAmbiguousKeys = targetStoreOwnerCount > 1;
  const candidateStorePaths = [...configuredOwnerStorePaths];
  const agentsDir = path.join(params.stateDir, "agents");
  for (const entry of safeReadDir(agentsDir)) {
    if (entry.isDirectory()) {
      candidateStorePaths.push(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  const targetStoreAliases = resolveSessionStoreAliasPlan(targetStorePath, candidateStorePaths);
  return { preserveAmbiguousKeys, preserveForeignMainAliases, targetStoreAliases };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
