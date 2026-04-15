import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listBundledChannelSetupPluginsByFeature } from "../channels/plugins/bundled.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import {
  resolveLegacyStateDirs,
  resolveNewStateDir,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { saveSessionStore } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { expandHomePrefix } from "./home-dir.js";
import { isWithinDir } from "./path-safety.js";
import {
  ensureDir,
  existsDir,
  fileExists,
  readSessionStoreJson5,
  type SessionEntryLike,
  safeReadDir,
} from "./state-migrations.fs.js";

export type LegacyStateDetection = {
  targetAgentId: string;
  targetMainKey: string;
  targetScope?: SessionScope;
  stateDir: string;
  oauthDir: string;
  sessions: {
    legacyDir: string;
    legacyStorePath: string;
    targetDir: string;
    targetStorePath: string;
    hasLegacy: boolean;
    legacyKeys: string[];
  };
  agentDir: {
    legacyDir: string;
    targetDir: string;
    hasLegacy: boolean;
  };
  channelPlans: {
    hasLegacy: boolean;
    plans: ChannelLegacyStateMigrationPlan[];
  };
  preview: string[];
};

type MigrationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

let autoMigrateChecked = false;
let autoMigrateStateDirChecked = false;
let cachedLegacySessionSurfaces: LegacySessionSurface[] | null = null;

type LegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

function getLegacySessionSurfaces(): LegacySessionSurface[] {
  // Legacy migrations run on cold doctor/startup paths. Prefer the narrower
  // setup plugin surface here so session-key cleanup does not materialize full
  // bundled channel runtimes.
  cachedLegacySessionSurfaces ??= listBundledChannelSetupPluginsByFeature(
    "legacySessionSurfaces",
  ).flatMap((plugin) => {
    const surface = plugin.messaging;
    return surface && typeof surface === "object" ? [surface] : [];
  });
  return cachedLegacySessionSurfaces;
}

function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

function isLegacyGroupKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of getLegacySessionSurfaces()) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
}

function buildLegacyMigrationPreview(plan: ChannelLegacyStateMigrationPlan): string {
  return `- ${plan.label}: ${plan.sourcePath} → ${plan.targetPath}`;
}

async function runLegacyMigrationPlans(
  plans: ChannelLegacyStateMigrationPlan[],
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const plan of plans) {
    if (fileExists(plan.targetPath)) {
      continue;
    }
    try {
      ensureDir(path.dirname(plan.targetPath));
      if (plan.kind === "move") {
        fs.renameSync(plan.sourcePath, plan.targetPath);
        changes.push(`Moved ${plan.label} → ${plan.targetPath}`);
      } else {
        fs.copyFileSync(plan.sourcePath, plan.targetPath);
        changes.push(`Copied ${plan.label} → ${plan.targetPath}`);
      }
    } catch (err) {
      warnings.push(`Failed migrating ${plan.label} (${plan.sourcePath}): ${String(err)}`);
    }
  }
  return { changes, warnings };
}

function canonicalizeSessionKeyForAgent(params: {
  key: string;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  // When shared-store guard is active, do not remap keys that belong to a
  // different agent — they are legitimate records for that agent, not orphans.
  // Without this check, canonicalizeMainSessionAlias (which now recognises
  // legacy agent:main:* aliases) would rewrite them before the
  // skipCrossAgentRemap guard below has a chance to block it.
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
      return rawLower;
    }
    if (
      agentId !== DEFAULT_AGENT_ID &&
      (rawLower === DEFAULT_MAIN_KEY || rawLower === params.mainKey)
    ) {
      return rawLower;
    }
  }

  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: raw,
  });
  if (canonicalMain !== raw) {
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

  if (rawLower.startsWith("agent:")) {
    return rawLower;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
  }
  // Channel-owned legacy shapes must win before the generic group/channel
  // fallback. WhatsApp shipped channel-qualified group sessions, so
  // `group:123@g.us` must canonicalize to `...:whatsapp:group:...`, not the
  // generic `...:unknown:group:...` bucket.
  for (const surface of getLegacySessionSurfaces()) {
    const canonicalized = surface.canonicalizeLegacySessionKey?.({
      key: raw,
      agentId,
    });
    const normalizedCanonicalized = normalizeOptionalLowercaseString(canonicalized);
    if (normalizedCanonicalized) {
      return normalizedCanonicalized;
    }
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
  }
  if (isSurfaceGroupKey(raw)) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
  }
  return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
}

function pickLatestLegacyDirectEntry(
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
    if (normalized === "global") {
      continue;
    }
    if (normalized.startsWith("agent:")) {
      continue;
    }
    if (normalizeLowercaseStringOrEmpty(normalized).startsWith("subagent:")) {
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

function normalizeSessionEntry(entry: SessionEntryLike): SessionEntry | null {
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
  if (!sessionId) {
    return null;
  }
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : Date.now();
  const normalized = { ...(entry as unknown as SessionEntry), sessionId, updatedAt };
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

function mergeSessionEntry(params: {
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

function canonicalizeSessionStore(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical: Record<string, SessionEntryLike> = {};
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

function listLegacySessionKeys(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
    });
    if (canonical !== key) {
      legacy.push(key);
    }
  }
  return legacy;
}

function emptyDirOrMissing(dir: string): boolean {
  if (!existsDir(dir)) {
    return true;
  }
  return safeReadDir(dir).length === 0;
}

function removeDirIfEmpty(dir: string) {
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

export function resetAutoMigrateLegacyStateForTest() {
  autoMigrateChecked = false;
  cachedLegacySessionSurfaces = null;
}

export function resetAutoMigrateLegacyAgentDirForTest() {
  resetAutoMigrateLegacyStateForTest();
}

export function resetAutoMigrateLegacyStateDirForTest() {
  autoMigrateStateDirChecked = false;
}

type StateDirMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
};

function resolveSymlinkTarget(linkPath: string): string | null {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

function formatStateDirMigration(legacyDir: string, targetDir: string): string {
  return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}

function isDirPath(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isLegacyTreeSymlinkMirror(currentDir: string, realTargetDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      const resolvedTarget = resolveSymlinkTarget(entryPath);
      if (!resolvedTarget) {
        return false;
      }
      let resolvedRealTarget: string;
      try {
        resolvedRealTarget = fs.realpathSync(resolvedTarget);
      } catch {
        return false;
      }
      if (!isWithinDir(realTargetDir, resolvedRealTarget)) {
        return false;
      }
      continue;
    }
    if (stat.isDirectory()) {
      if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) {
        return false;
      }
      continue;
    }
    return false;
  }

  return true;
}

function isLegacyDirSymlinkMirror(legacyDir: string, targetDir: string): boolean {
  let realTargetDir: string;
  try {
    realTargetDir = fs.realpathSync(targetDir);
  } catch {
    return false;
  }
  return isLegacyTreeSymlinkMirror(legacyDir, realTargetDir);
}

export async function autoMigrateLegacyStateDir(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
}): Promise<StateDirMigrationResult> {
  if (autoMigrateStateDirChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateStateDirChecked = true;

  const env = params.env ?? process.env;
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }

  const homedir = params.homedir ?? os.homedir;
  const targetDir = resolveNewStateDir(homedir);
  const legacyDirs = resolveLegacyStateDirs(homedir);
  let legacyDir = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  const warnings: string[] = [];
  const changes: string[] = [];

  let legacyStat: fs.Stats | null = null;
  try {
    legacyStat = legacyDir ? fs.lstatSync(legacyDir) : null;
  } catch {
    legacyStat = null;
  }
  if (!legacyStat) {
    return { migrated: false, skipped: false, changes, warnings };
  }
  if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
    warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
    return { migrated: false, skipped: false, changes, warnings };
  }

  let symlinkDepth = 0;
  while (legacyStat.isSymbolicLink()) {
    const legacyTarget = legacyDir ? resolveSymlinkTarget(legacyDir) : null;
    if (!legacyTarget) {
      warnings.push(
        `Legacy state dir is a symlink (${legacyDir ?? "unknown"}); could not resolve target.`,
      );
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (path.resolve(legacyTarget) === path.resolve(targetDir)) {
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (legacyDirs.some((dir) => path.resolve(dir) === path.resolve(legacyTarget))) {
      legacyDir = legacyTarget;
      try {
        legacyStat = fs.lstatSync(legacyDir);
      } catch {
        legacyStat = null;
      }
      if (!legacyStat) {
        warnings.push(`Legacy state dir missing after symlink resolution: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
        warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      symlinkDepth += 1;
      if (symlinkDepth > 2) {
        warnings.push(`Legacy state dir symlink chain too deep: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      continue;
    }
    warnings.push(
      `Legacy state dir is a symlink (${legacyDir ?? "unknown"} → ${legacyTarget}); skipping auto-migration.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  if (isDirPath(targetDir)) {
    if (legacyDir && isLegacyDirSymlinkMirror(legacyDir, targetDir)) {
      return { migrated: false, skipped: false, changes, warnings };
    }
    warnings.push(
      `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.renameSync(legacyDir, targetDir);
  } catch (err) {
    warnings.push(
      `Failed to move legacy state dir (${legacyDir ?? "unknown"} → ${targetDir}): ${String(err)}`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.symlinkSync(targetDir, legacyDir, "dir");
    changes.push(formatStateDirMigration(legacyDir, targetDir));
  } catch (err) {
    try {
      if (process.platform === "win32") {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: err });
        }
        fs.symlinkSync(targetDir, legacyDir, "junction");
        changes.push(formatStateDirMigration(legacyDir, targetDir));
      } else {
        throw err;
      }
    } catch (fallbackErr) {
      try {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: fallbackErr });
        }
        fs.renameSync(targetDir, legacyDir);
        warnings.push(
          `State dir migration rolled back (failed to link legacy path): ${String(fallbackErr)}`,
        );
        return { migrated: false, skipped: false, changes: [], warnings };
      } catch (rollbackErr) {
        warnings.push(
          `State dir moved but failed to link legacy path (${legacyDir ?? "unknown"} → ${targetDir}): ${String(fallbackErr)}`,
        );
        warnings.push(
          `Rollback failed; set OPENCLAW_STATE_DIR=${targetDir} to avoid split state: ${String(rollbackErr)}`,
        );
        changes.push(`State dir: ${legacyDir ?? "unknown"} → ${targetDir}`);
      }
    }
  }

  return { migrated: changes.length > 0, skipped: false, changes, warnings };
}

async function collectChannelLegacyStateMigrationPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  // Legacy state detection belongs on the lightweight setup surface so doctor
  // does not cold-load unrelated runtime channel code.
  for (const plugin of listBundledChannelSetupPluginsByFeature("legacyStateMigrations")) {
    const detected = await plugin.lifecycle?.detectLegacyStateMigrations?.({
      cfg: params.cfg,
      env: params.env,
      stateDir: params.stateDir,
      oauthDir: params.oauthDir,
    });
    if (detected?.length) {
      plans.push(...detected);
    }
  }
  return plans;
}

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);

  const targetAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const rawMainKey = params.cfg.session?.mainKey;
  const targetMainKey =
    typeof rawMainKey === "string" && rawMainKey.trim().length > 0
      ? rawMainKey.trim()
      : DEFAULT_MAIN_KEY;
  const targetScope = params.cfg.session?.scope;

  const sessionsLegacyDir = path.join(stateDir, "sessions");
  const sessionsLegacyStorePath = path.join(sessionsLegacyDir, "sessions.json");
  const sessionsTargetDir = path.join(stateDir, "agents", targetAgentId, "sessions");
  const sessionsTargetStorePath = path.join(sessionsTargetDir, "sessions.json");
  const legacySessionEntries = safeReadDir(sessionsLegacyDir);
  const hasLegacySessions =
    fileExists(sessionsLegacyStorePath) ||
    legacySessionEntries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));

  const targetSessionParsed = fileExists(sessionsTargetStorePath)
    ? readSessionStoreJson5(sessionsTargetStorePath)
    : { store: {}, ok: true };
  const legacyKeys = targetSessionParsed.ok
    ? listLegacySessionKeys({
        store: targetSessionParsed.store,
        agentId: targetAgentId,
        mainKey: targetMainKey,
        scope: targetScope,
      })
    : [];

  const legacyAgentDir = path.join(stateDir, "agent");
  const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
  const hasLegacyAgentDir = existsDir(legacyAgentDir);
  const channelPlans = await collectChannelLegacyStateMigrationPlans({
    cfg: params.cfg,
    env,
    stateDir,
    oauthDir,
  });

  const preview: string[] = [];
  if (hasLegacySessions) {
    preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
  }
  if (legacyKeys.length > 0) {
    preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
  }
  if (hasLegacyAgentDir) {
    preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
  }
  if (channelPlans.length > 0) {
    preview.push(...channelPlans.map(buildLegacyMigrationPreview));
  }

  return {
    targetAgentId,
    targetMainKey,
    targetScope,
    stateDir,
    oauthDir,
    sessions: {
      legacyDir: sessionsLegacyDir,
      legacyStorePath: sessionsLegacyStorePath,
      targetDir: sessionsTargetDir,
      targetStorePath: sessionsTargetStorePath,
      hasLegacy: hasLegacySessions || legacyKeys.length > 0,
      legacyKeys,
    },
    agentDir: {
      legacyDir: legacyAgentDir,
      targetDir: targetAgentDir,
      hasLegacy: hasLegacyAgentDir,
    },
    channelPlans: {
      hasLegacy: channelPlans.length > 0,
      plans: channelPlans,
    },
    preview,
  };
}

async function migrateLegacySessions(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.sessions.hasLegacy) {
    return { changes, warnings };
  }

  ensureDir(detected.sessions.targetDir);

  const legacyParsed = fileExists(detected.sessions.legacyStorePath)
    ? readSessionStoreJson5(detected.sessions.legacyStorePath)
    : { store: {}, ok: true };
  const targetParsed = fileExists(detected.sessions.targetStorePath)
    ? readSessionStoreJson5(detected.sessions.targetStorePath)
    : { store: {}, ok: true };
  const legacyStore = legacyParsed.store;
  const targetStore = targetParsed.store;

  const canonicalizedTarget = canonicalizeSessionStore({
    store: targetStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
  });
  const canonicalizedLegacy = canonicalizeSessionStore({
    store: legacyStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
  });

  const merged: Record<string, SessionEntryLike> = { ...canonicalizedTarget.store };
  for (const [key, entry] of Object.entries(canonicalizedLegacy.store)) {
    merged[key] = mergeSessionEntry({
      existing: merged[key],
      incoming: entry,
      preferIncomingOnTie: false,
    });
  }

  const mainKey = buildAgentMainSessionKey({
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
  });
  if (!merged[mainKey]) {
    const latest = pickLatestLegacyDirectEntry(legacyStore);
    if (latest?.sessionId) {
      merged[mainKey] = latest;
      changes.push(`Migrated latest direct-chat session → ${mainKey}`);
    }
  }

  if (!legacyParsed.ok) {
    warnings.push(
      `Legacy sessions store unreadable; left in place at ${detected.sessions.legacyStorePath}`,
    );
  }

  if (
    (legacyParsed.ok || targetParsed.ok) &&
    (Object.keys(legacyStore).length > 0 || Object.keys(targetStore).length > 0)
  ) {
    const normalized: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(merged)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      normalized[key] = normalizedEntry;
    }
    await saveSessionStore(detected.sessions.targetStorePath, normalized, {
      skipMaintenance: true,
    });
    changes.push(`Merged sessions store → ${detected.sessions.targetStorePath}`);
    if (canonicalizedTarget.legacyKeys.length > 0) {
      changes.push(`Canonicalized ${canonicalizedTarget.legacyKeys.length} legacy session key(s)`);
    }
  }

  const entries = safeReadDir(detected.sessions.legacyDir);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === "sessions.json") {
      continue;
    }
    const from = path.join(detected.sessions.legacyDir, entry.name);
    const to = path.join(detected.sessions.targetDir, entry.name);
    if (fileExists(to)) {
      continue;
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved ${entry.name} → agents/${detected.targetAgentId}/sessions`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  if (legacyParsed.ok) {
    try {
      if (fileExists(detected.sessions.legacyStorePath)) {
        fs.rmSync(detected.sessions.legacyStorePath, { force: true });
      }
    } catch {
      // ignore
    }
  }

  removeDirIfEmpty(detected.sessions.legacyDir);
  const legacyLeft = safeReadDir(detected.sessions.legacyDir).filter((e) => e.isFile());
  if (legacyLeft.length > 0) {
    const backupDir = `${detected.sessions.legacyDir}.legacy-${now()}`;
    try {
      fs.renameSync(detected.sessions.legacyDir, backupDir);
      warnings.push(`Left legacy sessions at ${backupDir}`);
    } catch {
      // ignore
    }
  }

  return { changes, warnings };
}

export async function migrateLegacyAgentDir(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.agentDir.hasLegacy) {
    return { changes, warnings };
  }

  ensureDir(detected.agentDir.targetDir);

  const entries = safeReadDir(detected.agentDir.legacyDir);
  for (const entry of entries) {
    const from = path.join(detected.agentDir.legacyDir, entry.name);
    const to = path.join(detected.agentDir.targetDir, entry.name);
    if (fs.existsSync(to)) {
      continue;
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved agent file ${entry.name} → agents/${detected.targetAgentId}/agent`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  removeDirIfEmpty(detected.agentDir.legacyDir);
  if (!emptyDirOrMissing(detected.agentDir.legacyDir)) {
    const backupDir = path.join(
      detected.stateDir,
      "agents",
      detected.targetAgentId,
      `agent.legacy-${now()}`,
    );
    try {
      fs.renameSync(detected.agentDir.legacyDir, backupDir);
      warnings.push(`Left legacy agent dir at ${backupDir}`);
    } catch (err) {
      warnings.push(`Failed relocating legacy agent dir: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

async function migrateChannelLegacyStatePlans(
  detected: LegacyStateDetection,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.channelPlans.hasLegacy) {
    return { changes, warnings };
  }
  return await runLegacyMigrationPlans(detected.channelPlans.plans);
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  now?: () => number;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const now = params.now ?? (() => Date.now());
  const detected = params.detected;
  const sessions = await migrateLegacySessions(detected, now);
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const channelPlans = await migrateChannelLegacyStatePlans(detected);
  return {
    changes: [...sessions.changes, ...agentDir.changes, ...channelPlans.changes],
    warnings: [...sessions.warnings, ...agentDir.warnings, ...channelPlans.warnings],
  };
}

export async function autoMigrateLegacyAgentDir(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
}> {
  return await autoMigrateLegacyState(params);
}

/**
 * Canonicalize orphaned raw session keys in all known agent session stores.
 *
 * Keys written by resolveSessionKey() used DEFAULT_AGENT_ID="main" regardless
 * of the configured default agent; reads always use resolveSessionStoreKey()
 * which canonicalizes via canonicalizeMainSessionAlias. This migration renames
 * any orphaned raw keys to their canonical form in-place, merging with any
 * existing canonical entry by preferring the most recently updated.
 *
 * Safe to run multiple times (idempotent). See #29683.
 */
export async function migrateOrphanedSessionKeys(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const agentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeConfig = params.cfg.session?.store;

  // Collect all known agent store paths with their owning agentIds.
  // A single path may be shared by multiple agents when session.store
  // does not contain {agentId}.
  const storeMap = new Map<string, Set<string>>();
  const addToStoreMap = (p: string, id: string) => {
    const existing = storeMap.get(p);
    if (existing) {
      existing.add(id);
    } else {
      storeMap.set(p, new Set([id]));
    }
  };
  // Default agent store.
  const defaultStorePath = storeConfig
    ? resolveStorePathFromTemplate(storeConfig, agentId, env)
    : path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  addToStoreMap(defaultStorePath, agentId);
  // Configured agents.
  for (const entry of params.cfg.agents?.list ?? []) {
    if (entry?.id) {
      const id = normalizeAgentId(entry.id);
      const p = storeConfig
        ? resolveStorePathFromTemplate(storeConfig, id, env)
        : path.join(stateDir, "agents", id, "sessions", "sessions.json");
      addToStoreMap(p, id);
    }
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

  for (const [storePath, storeAgentIds] of storeMap) {
    if (!fileExists(storePath)) {
      continue;
    }
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

    // When multiple agents share a single store file (session.store without
    // {agentId}), run canonicalization once per agent so each agent's keys are
    // handled correctly. Skip cross-agent "agent:main:*" remapping when "main"
    // is a legitimate configured agent to avoid merging its data into another
    // agent's namespace.
    let working = parsed.store;
    let totalLegacy = 0;
    for (const storeAgentId of storeAgentIds) {
      const { store: canonicalized, legacyKeys } = canonicalizeSessionStore({
        store: working,
        agentId: storeAgentId,
        mainKey,
        scope,
        // When multiple agents share the store and "main" is one of them,
        // agent:main:* keys are legitimate — don't cross-agent remap them.
        skipCrossAgentRemap: storeAgentIds.size > 1 && storeAgentIds.has(DEFAULT_AGENT_ID),
      });
      working = canonicalized;
      // Each pass only counts keys it changed from the current working store, so
      // once a key is canonicalized it is not counted again by later agent passes.
      totalLegacy += legacyKeys.length;
    }
    if (totalLegacy === 0) {
      continue;
    }

    const normalized: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(working)) {
      const ne = normalizeSessionEntry(entry);
      if (ne) {
        normalized[key] = ne;
      }
    }
    try {
      await saveSessionStore(storePath, normalized, { skipMaintenance: true });
      changes.push(`Canonicalized ${totalLegacy} orphaned session key(s) in ${storePath}`);
    } catch (err) {
      warnings.push(`Failed to write canonicalized store ${storePath}: ${String(err)}`);
    }
  }

  return { changes, warnings };
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

export async function autoMigrateLegacyState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
}> {
  if (autoMigrateChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateChecked = true;

  const env = params.env ?? process.env;
  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir: params.homedir,
    log: params.log,
  });

  // Canonicalize orphaned session keys regardless of whether legacy migration
  // is needed — the orphan-key bug (#29683) affects all installs with
  // non-default agent IDs or mainKey configuration.
  const orphanKeys = await migrateOrphanedSessionKeys({
    cfg: params.cfg,
    env,
  });

  const logMigrationResults = (changes: string[], warnings: string[]) => {
    const logger = params.log ?? createSubsystemLogger("state-migrations");
    if (changes.length > 0) {
      logger.info(
        `Auto-migrated legacy state:\n${changes.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    if (warnings.length > 0) {
      logger.warn(
        `Legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
  };

  if (env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim()) {
    const changes = [...stateDirResult.changes, ...orphanKeys.changes];
    const warnings = [...stateDirResult.warnings, ...orphanKeys.warnings];
    logMigrationResults(changes, warnings);
    return {
      migrated: stateDirResult.migrated || orphanKeys.changes.length > 0,
      skipped: true,
      changes,
      warnings,
    };
  }

  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env,
    homedir: params.homedir,
  });
  if (!detected.sessions.hasLegacy && !detected.agentDir.hasLegacy) {
    const changes = [...stateDirResult.changes, ...orphanKeys.changes];
    const warnings = [...stateDirResult.warnings, ...orphanKeys.warnings];
    logMigrationResults(changes, warnings);
    return {
      migrated: stateDirResult.migrated || orphanKeys.changes.length > 0,
      skipped: false,
      changes,
      warnings,
    };
  }

  const now = params.now ?? (() => Date.now());
  const sessions = await migrateLegacySessions(detected, now);
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const changes = [
    ...stateDirResult.changes,
    ...orphanKeys.changes,
    ...sessions.changes,
    ...agentDir.changes,
  ];
  const warnings = [
    ...stateDirResult.warnings,
    ...orphanKeys.warnings,
    ...sessions.warnings,
    ...agentDir.warnings,
  ];

  logMigrationResults(changes, warnings);

  return {
    migrated: changes.length > 0,
    skipped: false,
    changes,
    warnings,
  };
}
