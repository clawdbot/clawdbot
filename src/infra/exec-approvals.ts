// Manages exec approval policy, allowlist entries, and host targeting.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { isNamedProfile } from "../config/paths.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import { sha256Hex, sha256HexPrefix } from "./crypto-digest.js";
import {
  canonicalizeExecApprovalPolicyRules,
  type ExecApprovalPolicySnapshot,
} from "./exec-approval-policy-snapshot.js";
import {
  type AllowAlwaysPattern,
  resolveAllowAlwaysPatternEntries,
} from "./exec-approvals-allowlist.js";
import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import type { ExecAuthorizationPlan } from "./exec-authorization-plan.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperInvocation,
} from "./exec-wrapper-resolution.js";
import { withFileLock } from "./file-lock.js";
import { assertNoSymlinkParentsSync } from "./fs-safe-advanced.js";
import { expandHomePrefix, resolveHomeRelativePath, resolveRequiredHomeDir } from "./home-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";
import { isPlainObject } from "./plain-object.js";
import {
  hasPosixInteractiveStartupBeforeInlineCommand,
  hasPosixLoginStartupBeforeInlineCommand,
  POSIX_INLINE_COMMAND_FLAGS,
} from "./shell-inline-command.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";
export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
export type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecTarget = "auto" | ExecHost;
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";
export type ExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";

export const EXEC_TARGET_VALUES: readonly ExecTarget[] = ["auto", "sandbox", "gateway", "node"];

export function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

export function normalizeExecTarget(value?: string | null): ExecTarget | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "auto") {
    return normalized;
  }
  return normalizeExecHost(normalized);
}

export function requireValidExecTarget(value?: unknown): ExecTarget | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Invalid exec host value type ${typeof value}. Allowed values: ${EXEC_TARGET_VALUES.join(
        ", ",
      )}.`,
    );
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return null;
  }
  const target = normalizeExecTarget(normalized);
  if (target) {
    return target;
  }
  throw new Error(
    `Invalid exec host "${value}". Allowed values: ${EXEC_TARGET_VALUES.join(", ")}.`,
  );
}

/** Coerce a raw JSON field to string, returning undefined for non-string types. */
const toStringOrUndefined = readStringValue;

export function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

export function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

export function normalizeExecMode(value?: string | null): ExecMode | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (
    normalized === "deny" ||
    normalized === "allowlist" ||
    normalized === "ask" ||
    normalized === "auto" ||
    normalized === "full"
  ) {
    return normalized;
  }
  return null;
}

export function resolveExecModeFromPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
}): ExecMode {
  if (params.security === "deny") {
    return "deny";
  }
  if (params.security === "allowlist" && params.ask === "off") {
    return "allowlist";
  }
  if (params.security === "full" && params.ask !== "always") {
    return "full";
  }
  return "ask";
}

export function resolveExecPolicyForMode(mode: ExecMode): {
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
} {
  switch (mode) {
    case "deny":
      return { security: "deny", ask: "off", autoReview: false };
    case "allowlist":
      return { security: "allowlist", ask: "off", autoReview: false };
    case "ask":
      return { security: "allowlist", ask: "on-miss", autoReview: false };
    case "auto":
      return { security: "allowlist", ask: "on-miss", autoReview: true };
    case "full":
      return { security: "full", ask: "off", autoReview: false };
  }
  const exhaustiveMode: never = mode;
  throw new Error(`Unsupported exec mode: ${String(exhaustiveMode)}`);
}

export function resolveExecModePolicy(params: {
  mode?: ExecMode | null;
  security: ExecSecurity;
  ask: ExecAsk;
}): {
  mode: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
} {
  if (!params.mode) {
    return {
      mode: resolveExecModeFromPolicy({ security: params.security, ask: params.ask }),
      security: params.security,
      ask: params.ask,
      autoReview: false,
    };
  }
  return {
    mode: params.mode,
    ...resolveExecPolicyForMode(params.mode),
  };
}

export type SystemRunApprovalBinding = {
  argv: string[];
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
  envHash: string | null;
};

export type SystemRunApprovalFileOperand = {
  argvIndex: number;
  path: string;
  sha256: string;
};

export type SystemRunApprovalPlan = {
  argv: string[];
  cwd: string | null;
  commandText: string;
  commandPreview?: string | null;
  agentId: string | null;
  sessionKey: string | null;
  policySnapshot?: ExecApprovalPolicySnapshot;
  mutableFileOperand?: SystemRunApprovalFileOperand | null;
};

export type ExecApprovalCommandSpan = {
  startIndex: number;
  endIndex: number;
};

export type ExecApprovalRequestPayload = {
  command: string;
  commandPreview?: string | null;
  commandArgv?: string[];
  // Optional UI-safe env key preview for approval prompts.
  envKeys?: string[];
  systemRunBinding?: SystemRunApprovalBinding | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  warningText?: string | null;
  commandAnalysis?: CommandExplanationSummary | null;
  commandSpans?: ExecApprovalCommandSpan[];
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[];
  allowedDecisions?: readonly ExecApprovalDecision[];
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type ExecApprovalRequest = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: ExecApprovalRequest["request"];
};

export type ExecApprovalsDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};

export type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecAllowlistEntry[];
};

export type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

export type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  file: ExecApprovalsFile;
  hash: string;
};

export type ExecApprovalsResolved = {
  path: string;
  socketPath: string;
  token: string;
  defaults: Required<ExecApprovalsDefaults>;
  agent: Required<ExecApprovalsDefaults>;
  agentSources: {
    security: string | null;
    ask: string | null;
    askFallback: string | null;
  };
  allowlist: ExecAllowlistEntry[];
  file: ExecApprovalsFile;
};

// Keep CLI + gateway defaults in sync.
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1_800_000;

const DEFAULT_SECURITY: ExecSecurity = "full";
const DEFAULT_ASK: ExecAsk = "off";
export const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK: ExecSecurity = "deny";
const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_EXEC_APPROVALS_STATE_DIR = "~/.openclaw";
const EXEC_APPROVALS_FILE = "exec-approvals.json";
const EXEC_APPROVALS_SOCKET = "exec-approvals.sock";
const EXEC_APPROVALS_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 30_000,
  // Approval policy is an authorization boundary. A pathname recheck followed
  // by stale-lock unlink cannot prove that a fresh owner was not substituted.
  staleRecovery: "fail-closed",
} as const;
const EXEC_APPROVALS_LOCK_QUEUE = resolveGlobalMap<string, Promise<unknown>>(
  Symbol.for("openclaw.execApprovalsLockQueue"),
);
let execApprovalsProcessStartTime: number | null | undefined;

function getExecApprovalsProcessStartTime(): number | null {
  if (execApprovalsProcessStartTime === undefined) {
    execApprovalsProcessStartTime = getFileLockProcessStartTime(process.pid);
  }
  return execApprovalsProcessStartTime;
}
const EXEC_APPROVALS_SYNC_LOCK_RETRIES = 10;
const EXEC_APPROVALS_SYNC_LOCK_RETRY_MS = 20;

function hashExecApprovalsRaw(raw: string | null): string {
  // Preserve existing hashes for present files so mixed-version native/CLI
  // clients can still compare snapshots; only missing needs its own domain.
  return raw === null ? `missing:${sha256Hex("")}` : sha256Hex(raw);
}

function hashExecApprovalsFile(file: ExecApprovalsFile): string {
  return hashExecApprovalsRaw(`${JSON.stringify(file, null, 2)}\n`);
}

function isExecApprovalsTargetMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

function isExecApprovalsLockMissing(filePath: string): boolean {
  try {
    const dir = fs.realpathSync(path.dirname(filePath));
    return isExecApprovalsTargetMissing(`${path.join(dir, path.basename(filePath))}.lock`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

function resolveExecApprovalsStateDir(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  displayPath: string;
} {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    const resolved = resolveHomeRelativePath(override, { env });
    return {
      path: resolved,
      displayPath: resolved,
    };
  }
  return {
    path: expandHomePrefix(DEFAULT_EXEC_APPROVALS_STATE_DIR, { env }),
    displayPath: DEFAULT_EXEC_APPROVALS_STATE_DIR,
  };
}

export function resolveExecApprovalsPath(): string {
  return path.join(resolveExecApprovalsStateDir().path, EXEC_APPROVALS_FILE);
}

export function resolveExecApprovalsSocketPath(): string {
  return path.join(resolveExecApprovalsStateDir().path, EXEC_APPROVALS_SOCKET);
}

export function resolveExecApprovalsDisplayPath(): string {
  const stateDir = resolveExecApprovalsStateDir().displayPath;
  return stateDir === DEFAULT_EXEC_APPROVALS_STATE_DIR
    ? `${stateDir}/${EXEC_APPROVALS_FILE}`
    : path.join(stateDir, EXEC_APPROVALS_FILE);
}

export function resolveExecApprovalsTranscriptPath(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    ? `$OPENCLAW_STATE_DIR/${EXEC_APPROVALS_FILE}`
    : `${DEFAULT_EXEC_APPROVALS_STATE_DIR}/${EXEC_APPROVALS_FILE}`;
}

function resolveLegacyExecApprovalsPath(): string {
  return path.join(expandHomePrefix(DEFAULT_EXEC_APPROVALS_STATE_DIR), EXEC_APPROVALS_FILE);
}

function hasUnmigratedLegacyExecApprovals(filePath: string): boolean {
  if (!process.env.OPENCLAW_STATE_DIR?.trim() || isNamedProfile()) {
    return false;
  }
  const legacyPath = resolveLegacyExecApprovalsPath();
  return (
    path.resolve(legacyPath) !== path.resolve(filePath) &&
    !fs.existsSync(filePath) &&
    fs.existsSync(legacyPath)
  );
}

function createUnmigratedLegacyExecApprovalsFallback(): ExecApprovalsFile {
  return normalizeExecApprovals({
    version: 1,
    defaults: {
      security: "deny",
      ask: "always",
      askFallback: "deny",
    },
    agents: {},
  });
}

function createFailClosedExecApprovalsFallback(): ExecApprovalsFile {
  return normalizeExecApprovals({
    version: 1,
    defaults: {
      security: "deny",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agents: {},
  });
}

function hasValidExecApprovalPolicyFields(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    (value.security === undefined || isExecSecurity(value.security)) &&
    (value.ask === undefined || isExecAsk(value.ask)) &&
    (value.askFallback === undefined || isExecSecurity(value.askFallback)) &&
    (value.autoAllowSkills === undefined || typeof value.autoAllowSkills === "boolean")
  );
}

function isValidPersistedExecAllowlistEntry(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!isPlainObject(value) || typeof value.pattern !== "string" || !value.pattern.trim()) {
    return false;
  }
  return (
    (value.id === undefined || typeof value.id === "string") &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.commandText === undefined || typeof value.commandText === "string") &&
    (value.argPattern === undefined || typeof value.argPattern === "string") &&
    (value.lastUsedAt === undefined ||
      (typeof value.lastUsedAt === "number" && Number.isFinite(value.lastUsedAt))) &&
    (value.lastUsedCommand === undefined || typeof value.lastUsedCommand === "string") &&
    (value.lastResolvedPath === undefined || typeof value.lastResolvedPath === "string")
  );
}

function isValidPersistedExecApprovals(value: unknown): value is ExecApprovalsFile {
  if (!isPlainObject(value) || value.version !== 1) {
    return false;
  }
  if (value.socket !== undefined) {
    if (
      !isPlainObject(value.socket) ||
      (value.socket.path !== undefined && typeof value.socket.path !== "string") ||
      (value.socket.token !== undefined && typeof value.socket.token !== "string")
    ) {
      return false;
    }
  }
  if (value.defaults !== undefined && !hasValidExecApprovalPolicyFields(value.defaults)) {
    return false;
  }
  if (value.agents !== undefined) {
    if (!isPlainObject(value.agents)) {
      return false;
    }
    for (const agent of Object.values(value.agents)) {
      if (
        !hasValidExecApprovalPolicyFields(agent) ||
        (agent.allowlist !== undefined &&
          (!Array.isArray(agent.allowlist) ||
            !agent.allowlist.every(isValidPersistedExecAllowlistEntry)))
      ) {
        return false;
      }
    }
  }
  return true;
}

function parsePersistedExecApprovals(raw: string): ExecApprovalsFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isValidPersistedExecApprovals(parsed)) {
      return normalizeExecApprovals(parsed);
    }
  } catch {
    // A partial Windows fallback write is existing state, not a missing policy.
  }
  // Never let malformed persisted state inherit permissive product defaults.
  return createFailClosedExecApprovalsFallback();
}

function normalizeAllowlistPattern(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed ? normalizeLowercaseStringOrEmpty(trimmed) : null;
}

function mergeLegacyAgent(
  current: ExecApprovalsAgent,
  legacy: ExecApprovalsAgent,
): ExecApprovalsAgent {
  const allowlist: ExecAllowlistEntry[] = [];
  const seen = new Set<string>();
  const pushEntry = (entry: ExecAllowlistEntry) => {
    const patternKey = normalizeAllowlistPattern(entry.pattern);
    if (!patternKey) {
      return;
    }
    const key = `${patternKey}\x00${entry.argPattern?.trim() ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    allowlist.push(entry);
  };
  for (const entry of current.allowlist ?? []) {
    pushEntry(entry);
  }
  for (const entry of legacy.allowlist ?? []) {
    pushEntry(entry);
  }

  return {
    security: current.security ?? legacy.security,
    ask: current.ask ?? legacy.ask,
    askFallback: current.askFallback ?? legacy.askFallback,
    autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
    allowlist: allowlist.length > 0 ? allowlist : undefined,
  };
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  assertNoExecApprovalsSymlinkParents(dir, resolveRequiredHomeDir());
  fs.mkdirSync(dir, { recursive: true });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use unsafe exec approvals directory: ${dir}`);
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    if (process.platform !== "win32") {
      throw err;
    }
  }
  return dir;
}

function resolveCanonicalExecApprovalsTarget(filePath: string): string {
  const dir = ensureDir(filePath);
  return path.join(fs.realpathSync(dir), path.basename(filePath));
}

function assertNoExecApprovalsSymlinkParents(targetPath: string, trustedRoot: string): void {
  try {
    assertNoSymlinkParentsSync({
      rootDir: trustedRoot,
      targetPath,
      allowOutsideRoot: true,
      messagePrefix: "Refusing to traverse symlink in exec approvals path",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UnsafeExecApprovalsPathError(message, { cause: err });
  }
}

class UnsafeExecApprovalsPathError extends Error {}

function assertSafeExecApprovalsStat(filePath: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) {
    throw new UnsafeExecApprovalsPathError(
      `Refusing to write exec approvals via symlink: ${filePath}`,
    );
  }
  if (!stat.isFile()) {
    throw new UnsafeExecApprovalsPathError(
      `Refusing to use non-file exec approvals path: ${filePath}`,
    );
  }
}

function assertSafeExecApprovalsDestination(filePath: string): void {
  try {
    assertSafeExecApprovalsStat(filePath, fs.lstatSync(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function assertSafeExecApprovalsOverwriteFallback(filePath: string): void {
  assertSafeExecApprovalsDestination(filePath);
  try {
    const stat = fs.statSync(filePath);
    if (stat.nlink > 1) {
      throw new Error(`Refusing copy fallback for hard-linked exec approvals file: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

type ExecApprovalsFallbackDestination = {
  existed: boolean;
  fd: number;
  snapshot: Buffer | null;
};

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type ExecApprovalsRawState = { exists: false; raw: null } | { exists: true; raw: string };

function readExecApprovalsRawState(filePath: string): ExecApprovalsRawState {
  assertNoExecApprovalsSymlinkParents(path.dirname(filePath), resolveRequiredHomeDir());
  // Anchor policy bytes to one inode; otherwise a path swap can make the CAS
  // hash describe a different file than the guarded approvals destination.
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, raw: null };
    }
    throw err;
  }
  assertSafeExecApprovalsStat(filePath, before);

  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
        { cause: err },
      );
    }
    if (code === "ELOOP") {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to write exec approvals via symlink: ${filePath}`,
        { cause: err },
      );
    }
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFilesystemEntry(before, opened)) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
      );
    }
    const raw = fs.readFileSync(fd, "utf8");
    let after: fs.Stats;
    try {
      after = fs.lstatSync(filePath);
    } catch (err) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
        { cause: err },
      );
    }
    assertSafeExecApprovalsStat(filePath, after);
    if (!sameFilesystemEntry(opened, after)) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
      );
    }
    return { exists: true, raw };
  } finally {
    fs.closeSync(fd);
  }
}

function readExecApprovalsSnapshotFromPath(filePath: string): ExecApprovalsSnapshot {
  const state = readExecApprovalsRawState(filePath);
  if (!state.exists) {
    return {
      path: filePath,
      exists: false,
      raw: null,
      file: normalizeExecApprovals({ version: 1, agents: {} }),
      hash: hashExecApprovalsRaw(null),
    };
  }
  return {
    path: filePath,
    exists: true,
    raw: state.raw,
    file: parsePersistedExecApprovals(state.raw),
    hash: hashExecApprovalsRaw(state.raw),
  };
}

function readExecApprovalsFallbackSnapshotFromFd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

function validateExecApprovalsFallbackFd(filePath: string, fd: number): fs.Stats {
  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to write exec approvals via symlink: ${filePath}`);
  }
  const pathStat = fs.statSync(filePath);
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isFile()) {
    throw new Error(`Refusing copy fallback for non-file exec approvals path: ${filePath}`);
  }
  if (fdStat.nlink > 1) {
    throw new Error(`Refusing copy fallback for hard-linked exec approvals file: ${filePath}`);
  }
  if (!sameFilesystemEntry(pathStat, fdStat)) {
    throw new Error(`Refusing copy fallback after exec approvals path changed: ${filePath}`);
  }
  return fdStat;
}

function openExistingExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | noFollowFlag, 0o600);
  try {
    validateExecApprovalsFallbackFd(filePath, fd);
    return {
      existed: true,
      fd,
      snapshot: readExecApprovalsFallbackSnapshotFromFd(fd),
    };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort after validation failure
    }
    throw err;
  }
}

function createExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  try {
    const fd = fs.openSync(
      filePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
      0o600,
    );
    try {
      validateExecApprovalsFallbackFd(filePath, fd);
      return { existed: false, fd, snapshot: null };
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort after validation failure
      }
      throw err;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return openExistingExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function openExecApprovalsFallbackDestination(filePath: string): ExecApprovalsFallbackDestination {
  try {
    return openExistingExecApprovalsFallbackDestination(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return createExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function writeExecApprovalsFallbackBuffer(fd: number, contents: Buffer): void {
  fs.ftruncateSync(fd, 0);
  let written = 0;
  while (written < contents.length) {
    written += fs.writeSync(fd, contents, written, contents.length - written, written);
  }
  fs.ftruncateSync(fd, contents.length);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

function restoreExecApprovalsFallbackDestination(
  filePath: string,
  destination: ExecApprovalsFallbackDestination,
): void {
  if (!destination.existed) {
    try {
      const pathStat = fs.statSync(filePath);
      const fdStat = fs.fstatSync(destination.fd);
      if (sameFilesystemEntry(pathStat, fdStat)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  writeExecApprovalsFallbackBuffer(destination.fd, destination.snapshot ?? Buffer.alloc(0));
}

function copyExecApprovalsFallback(tempPath: string, filePath: string): void {
  const contents = fs.readFileSync(tempPath);
  const destination = openExecApprovalsFallbackDestination(filePath);
  try {
    writeExecApprovalsFallbackBuffer(destination.fd, contents);
    validateExecApprovalsFallbackFd(filePath, destination.fd);
  } catch (copyErr) {
    try {
      restoreExecApprovalsFallbackDestination(filePath, destination);
    } catch (restoreErr) {
      throw new Error(
        `Failed to restore exec approvals after copy fallback failure for ${filePath}: ${String(
          copyErr,
        )}`,
        { cause: restoreErr },
      );
    }
    throw copyErr;
  } finally {
    fs.closeSync(destination.fd);
  }
}

function renameExecApprovalsWithFallback(tempPath: string, filePath: string): void {
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows can reject rename-overwrite when another process has a transient
    // handle on the target approvals file.
    if (code !== "EPERM" && code !== "EEXIST") {
      throw err;
    }
    assertSafeExecApprovalsOverwriteFallback(filePath);
    copyExecApprovalsFallback(tempPath, filePath);
    fs.rmSync(tempPath, { force: true });
  }
}

// Coerce legacy/corrupted allowlists into `ExecAllowlistEntry[]` before we spread
// entries to add ids (spreading strings creates {"0":"l","1":"s",...}).
function coerceAllowlistEntries(allowlist: unknown): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return Array.isArray(allowlist) ? (allowlist as ExecAllowlistEntry[]) : undefined;
  }
  let changed = false;
  const result: ExecAllowlistEntry[] = [];
  for (const item of allowlist) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        result.push({ pattern: trimmed });
        changed = true;
      } else {
        changed = true; // dropped empty string
      }
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const pattern = (item as { pattern?: unknown }).pattern;
      if (typeof pattern === "string" && pattern.trim().length > 0) {
        result.push(item as ExecAllowlistEntry);
      } else {
        changed = true; // dropped invalid entry
      }
    } else {
      changed = true; // dropped invalid entry
    }
  }
  return changed ? (result.length > 0 ? result : undefined) : (allowlist as ExecAllowlistEntry[]);
}

function ensureAllowlistIds(
  allowlist: ExecAllowlistEntry[] | undefined,
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }
  let changed = false;
  const next = allowlist.map((entry) => {
    if (entry.id) {
      return entry;
    }
    changed = true;
    return { ...entry, id: crypto.randomUUID() };
  });
  return changed ? next : allowlist;
}

function stripAllowlistCommandText(
  allowlist: ExecAllowlistEntry[] | undefined,
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }
  let changed = false;
  const next = allowlist.map((entry) => {
    if (typeof entry.commandText !== "string") {
      return entry;
    }
    changed = true;
    const { commandText: _commandText, ...rest } = entry;
    return rest;
  });
  return changed ? next : allowlist;
}

function sanitizeExecApprovalPolicy(
  policy: ExecApprovalsDefaults | ExecApprovalsAgent | undefined,
): ExecApprovalsDefaults {
  const security = toStringOrUndefined(policy?.security)?.trim();
  const ask = toStringOrUndefined(policy?.ask)?.trim();
  const askFallback = toStringOrUndefined(policy?.askFallback)?.trim();
  return {
    security:
      security === "deny" || security === "allowlist" || security === "full" ? security : undefined,
    ask: ask === "off" || ask === "on-miss" || ask === "always" ? ask : undefined,
    askFallback:
      askFallback === "deny" || askFallback === "allowlist" || askFallback === "full"
        ? askFallback
        : undefined,
    autoAllowSkills: policy?.autoAllowSkills,
  };
}

export function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
  const agents = { ...file.agents };
  const legacyDefault = agents.default;
  if (legacyDefault) {
    const main = agents[DEFAULT_AGENT_ID];
    agents[DEFAULT_AGENT_ID] = main ? mergeLegacyAgent(main, legacyDefault) : legacyDefault;
    delete agents.default;
  }
  for (const [key, agent] of Object.entries(agents)) {
    const coerced = coerceAllowlistEntries(agent.allowlist);
    const withIds = ensureAllowlistIds(coerced);
    const allowlist = stripAllowlistCommandText(withIds);
    const sanitizedPolicy = sanitizeExecApprovalPolicy(agent);
    const agentChanged =
      allowlist !== agent.allowlist ||
      sanitizedPolicy.security !== agent.security ||
      sanitizedPolicy.ask !== agent.ask ||
      sanitizedPolicy.askFallback !== agent.askFallback;
    if (agentChanged) {
      agents[key] = {
        ...agent,
        allowlist,
        security: sanitizedPolicy.security,
        ask: sanitizedPolicy.ask,
        askFallback: sanitizedPolicy.askFallback,
      };
    }
  }
  const sanitizedDefaults = sanitizeExecApprovalPolicy(file.defaults);
  const normalized: ExecApprovalsFile = {
    version: 1,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : undefined,
      token: token && token.length > 0 ? token : undefined,
    },
    defaults: {
      ...sanitizedDefaults,
    },
    agents,
  };
  return normalized;
}

export function mergeExecApprovalsSocketDefaults(params: {
  normalized: ExecApprovalsFile;
  current?: ExecApprovalsFile;
}): ExecApprovalsFile {
  const currentSocketPath = params.current?.socket?.path?.trim();
  const currentToken = params.current?.socket?.token?.trim();
  const socketPath =
    params.normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
  const token = params.normalized.socket?.token?.trim() ?? currentToken ?? generateToken();
  return {
    ...params.normalized,
    socket: {
      path: socketPath,
      token,
    },
  };
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function readExecApprovalsSnapshotUnlocked(): ExecApprovalsSnapshot {
  const filePath = resolveExecApprovalsPath();
  if (hasUnmigratedLegacyExecApprovals(filePath)) {
    const file = createUnmigratedLegacyExecApprovalsFallback();
    return {
      path: filePath,
      exists: false,
      raw: null,
      file,
      hash: hashExecApprovalsRaw(null),
    };
  }
  return readExecApprovalsSnapshotFromPath(filePath);
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  // Windows' overwrite fallback updates the destination inode in place. Readers
  // must share its lock so they observe either the old policy or the new one.
  return withExecApprovalsReadLockSync(
    resolveExecApprovalsPath(),
    readExecApprovalsSnapshotUnlocked,
  );
}

function loadExecApprovalsUnlocked(): ExecApprovalsFile {
  const filePath = resolveExecApprovalsPath();
  if (hasUnmigratedLegacyExecApprovals(filePath)) {
    return createUnmigratedLegacyExecApprovalsFallback();
  }
  try {
    return readExecApprovalsSnapshotFromPath(filePath).file;
  } catch {
    return createFailClosedExecApprovalsFallback();
  }
}

export function loadExecApprovals(): ExecApprovalsFile {
  try {
    return withExecApprovalsReadLockSync(resolveExecApprovalsPath(), loadExecApprovalsUnlocked);
  } catch {
    // A busy, malformed, or unreadable approvals store must never restore the
    // permissive defaults while another process is revoking access.
    return createFailClosedExecApprovalsFallback();
  }
}

export async function loadExecApprovalsAsync(): Promise<ExecApprovalsFile> {
  try {
    return await withExecApprovalsReadLock(resolveExecApprovalsPath(), async () =>
      loadExecApprovalsUnlocked(),
    );
  } catch {
    // Match the synchronous reader's fail-closed contract while allowing
    // same-process async writers to finish instead of rejecting valid state.
    return createFailClosedExecApprovalsFallback();
  }
}

type ExecApprovalsSyncLock = {
  descriptor: number;
  lockPath: string;
  device: number;
  inode: number;
  raw: string;
};

function readLockPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readExecApprovalsLockState(lockPath: string): {
  ownerPid: number | null;
  definitelyStale: boolean;
} {
  try {
    const payload = readLockPayload(fs.readFileSync(lockPath, "utf8"));
    const ownerPid =
      typeof payload?.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0
        ? payload.pid
        : null;
    return {
      ownerPid,
      definitelyStale: isLockOwnerDefinitelyStale({ payload }),
    };
  } catch {
    return { ownerPid: null, definitelyStale: false };
  }
}

function sleepExecApprovalsSyncLockRetry(): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EXEC_APPROVALS_SYNC_LOCK_RETRY_MS);
  } catch {
    const deadline = Date.now() + EXEC_APPROVALS_SYNC_LOCK_RETRY_MS;
    while (Date.now() < deadline) {
      // Best-effort fallback when Atomics.wait is unavailable.
    }
  }
}

function removeOwnedExecApprovalsLock(
  lock: ExecApprovalsSyncLock,
  options: { requirePayloadMatch: boolean },
): void {
  try {
    const current = fs.lstatSync(lock.lockPath);
    if (
      current.dev === lock.device &&
      current.ino === lock.inode &&
      (!options.requirePayloadMatch || fs.readFileSync(lock.lockPath, "utf8") === lock.raw)
    ) {
      fs.rmSync(lock.lockPath, { force: true });
    }
  } catch {
    // Best-effort release; a changed path belongs to another lock owner.
  }
}

function acquireExecApprovalsLockSync(filePath: string): ExecApprovalsSyncLock {
  const normalizedTarget = resolveCanonicalExecApprovalsTarget(filePath);
  const lockPath = `${normalizedTarget}.lock`;
  const payload: Record<string, unknown> = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
  const starttime = getExecApprovalsProcessStartTime();
  if (starttime !== null) {
    payload.starttime = starttime;
  }
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  for (let attempt = 0; attempt <= EXEC_APPROVALS_SYNC_LOCK_RETRIES; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const state = readExecApprovalsLockState(lockPath);
      if (state.definitelyStale) {
        throw Object.assign(new Error(`Exec approvals lock has a stale owner: ${lockPath}`), {
          code: "file_lock_stale",
          lockPath,
        });
      }
      if (
        state.ownerPid !== null &&
        state.ownerPid !== process.pid &&
        attempt < EXEC_APPROVALS_SYNC_LOCK_RETRIES
      ) {
        sleepExecApprovalsSyncLockRetry();
        continue;
      }
      throw Object.assign(new Error(`Exec approvals are locked: ${lockPath}`), {
        code: "file_lock_timeout",
        lockPath,
      });
    }
    let stat: fs.Stats;
    try {
      stat = fs.fstatSync(descriptor);
    } catch (err) {
      fs.closeSync(descriptor);
      throw err;
    }
    const lock: ExecApprovalsSyncLock = {
      descriptor,
      lockPath,
      device: stat.dev,
      inode: stat.ino,
      raw,
    };
    try {
      fs.writeFileSync(descriptor, raw, "utf8");
      return lock;
    } catch (err) {
      fs.closeSync(descriptor);
      removeOwnedExecApprovalsLock(lock, { requirePayloadMatch: false });
      throw err;
    }
  }
  throw new Error(`Failed to acquire exec approvals lock: ${lockPath}`);
}

function withExecApprovalsLockSync<T>(fn: () => T): T {
  const lock = acquireExecApprovalsLockSync(resolveExecApprovalsPath());
  try {
    return fn();
  } finally {
    fs.closeSync(lock.descriptor);
    removeOwnedExecApprovalsLock(lock, { requirePayloadMatch: true });
  }
}

function withExecApprovalsReadLockSync<T>(filePath: string, fn: () => T): T {
  if (!isExecApprovalsTargetMissing(filePath) || !isExecApprovalsLockMissing(filePath)) {
    return withExecApprovalsLockSync(fn);
  }
  // Avoid creating a missing state directory for an uncontended read. Recheck
  // after reading: a writer can create the lock or target between the probes.
  const result = fn();
  // Probe the lock first so the target probe is the final linearization check.
  // A writer that finishes after the lock probe must make the target visible.
  return isExecApprovalsLockMissing(filePath) && isExecApprovalsTargetMissing(filePath)
    ? result
    : withExecApprovalsLockSync(fn);
}

function saveExecApprovalsUnlocked(file: ExecApprovalsFile): void {
  const filePath = resolveExecApprovalsPath();
  const raw = `${JSON.stringify(file, null, 2)}\n`;
  writeExecApprovalsRaw(filePath, raw);
}

type ExecApprovalsUpdate = {
  baseHash?: string;
  update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
};

function updateExecApprovalsUnlocked(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  // Both sync and async entry points hold the sidecar lock across this full CAS transaction.
  if (hasUnmigratedLegacyExecApprovals(resolveExecApprovalsPath())) {
    throw new Error("Exec approvals must be migrated before they can be updated");
  }
  const current = readExecApprovalsSnapshotUnlocked();
  if (params.baseHash !== undefined && current.hash !== params.baseHash) {
    return null;
  }
  const next = params.update(current.file);
  if (next === null) {
    return current;
  }
  if (
    current.exists &&
    current.hash === hashExecApprovalsFile(next) &&
    hardenUnchangedExecApprovals(current.path)
  ) {
    return current;
  }
  saveExecApprovalsUnlocked(next);
  return readExecApprovalsSnapshotUnlocked();
}

function updateExecApprovalsSync(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  return withExecApprovalsLockSync(() => updateExecApprovalsUnlocked(params));
}

export function saveExecApprovals(file: ExecApprovalsFile): void {
  updateExecApprovalsSync({ update: () => file });
}

function enqueueExecApprovalsLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Queue process-local holders before taking the re-entrant shared lock;
  // otherwise concurrent callbacks could both mutate stale state.
  const previous = EXEC_APPROVALS_LOCK_QUEUE.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  EXEC_APPROVALS_LOCK_QUEUE.set(filePath, next);
  void next
    .finally(() => {
      if (EXEC_APPROVALS_LOCK_QUEUE.get(filePath) === next) {
        EXEC_APPROVALS_LOCK_QUEUE.delete(filePath);
      }
    })
    .catch(() => {});
  return next;
}

async function withExecApprovalsLock<T>(fn: () => Promise<T>): Promise<T> {
  // Harden and canonicalize before entering either lock layer. This prevents a
  // symlinked state component from redirecting the sidecar and secures the
  // directory even when the guarded update becomes a no-op or loses its CAS.
  const filePath = resolveCanonicalExecApprovalsTarget(resolveExecApprovalsPath());
  return await enqueueExecApprovalsLock(filePath, async () =>
    withFileLock(filePath, EXEC_APPROVALS_LOCK_OPTIONS, fn),
  );
}

async function withExecApprovalsReadLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  if (!isExecApprovalsTargetMissing(filePath) || !isExecApprovalsLockMissing(filePath)) {
    return await withExecApprovalsLock(fn);
  }
  const result = await fn();
  // Keep the target probe last for the same missing-file race as the sync path.
  return isExecApprovalsLockMissing(filePath) && isExecApprovalsTargetMissing(filePath)
    ? result
    : await withExecApprovalsLock(fn);
}

export async function updateExecApprovals(
  params: ExecApprovalsUpdate,
): Promise<ExecApprovalsSnapshot | null> {
  return await withExecApprovalsLock(async () => updateExecApprovalsUnlocked(params));
}

function hardenUnchangedExecApprovals(filePath: string): boolean {
  ensureDir(filePath);
  assertSafeExecApprovalsDestination(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
  if (stat.nlink > 1) {
    return false;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
  return true;
}

function writeExecApprovalsRaw(filePath: string, raw: string) {
  const dir = ensureDir(filePath);
  assertSafeExecApprovalsDestination(filePath);
  const tempPath = path.join(dir, `.exec-approvals.${process.pid}.${crypto.randomUUID()}.tmp`);
  let tempWritten = false;
  try {
    fs.writeFileSync(tempPath, raw, { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // best-effort on platforms without chmod
    }
    tempWritten = true;
    renameExecApprovalsWithFallback(tempPath, filePath);
  } finally {
    if (tempWritten && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

function restoreExecApprovalsSnapshotUnlocked(snapshot: ExecApprovalsSnapshot): void {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
  } else if (snapshot.raw !== null) {
    writeExecApprovalsRaw(snapshot.path, snapshot.raw);
  } else {
    saveExecApprovalsUnlocked(snapshot.file);
  }
}

export function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void {
  withExecApprovalsLockSync(() => restoreExecApprovalsSnapshotUnlocked(snapshot));
}

export async function restoreExecApprovalsSnapshotLocked(
  snapshot: ExecApprovalsSnapshot,
  baseHash: string,
): Promise<boolean> {
  return await withExecApprovalsLock(async () => {
    if (readExecApprovalsSnapshotUnlocked().hash !== baseHash) {
      return false;
    }
    restoreExecApprovalsSnapshotUnlocked(snapshot);
    return true;
  });
}

function ensureExecApprovalsSocket(file: ExecApprovalsFile): ExecApprovalsFile {
  const next = normalizeExecApprovals(file);
  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();
  return {
    ...next,
    socket: {
      path: socketPath || resolveExecApprovalsSocketPath(),
      token: token || generateToken(),
    },
  };
}

function requireInitializedExecApprovals(
  snapshot: ExecApprovalsSnapshot | null,
): ExecApprovalsSnapshot {
  if (!snapshot) {
    throw new Error("Failed to initialize exec approvals");
  }
  return snapshot;
}

export async function ensureExecApprovalsSnapshot(): Promise<ExecApprovalsSnapshot> {
  if (hasUnmigratedLegacyExecApprovals(resolveExecApprovalsPath())) {
    return readExecApprovalsSnapshot();
  }
  return requireInitializedExecApprovals(
    await updateExecApprovals({ update: ensureExecApprovalsSocket }),
  );
}

export function ensureExecApprovals(): ExecApprovalsFile {
  if (hasUnmigratedLegacyExecApprovals(resolveExecApprovalsPath())) {
    return createUnmigratedLegacyExecApprovalsFallback();
  }
  return requireInitializedExecApprovals(
    updateExecApprovalsSync({ update: ensureExecApprovalsSocket }),
  ).file;
}

function readExecApprovalsForNoPersistenceUnlocked(filePath: string): ExecApprovalsFile {
  if (hasUnmigratedLegacyExecApprovals(filePath)) {
    return createUnmigratedLegacyExecApprovalsFallback();
  }
  try {
    return readExecApprovalsSnapshotFromPath(filePath).file;
  } catch (err) {
    if (err instanceof UnsafeExecApprovalsPathError) {
      throw err;
    }
    return createFailClosedExecApprovalsFallback();
  }
}

function isExecSecurity(value: unknown): value is ExecSecurity {
  return value === "allowlist" || value === "full" || value === "deny";
}

function isExecAsk(value: unknown): value is ExecAsk {
  return value === "always" || value === "off" || value === "on-miss";
}

function normalizeSecurity(value: unknown, fallback: ExecSecurity): ExecSecurity {
  return isExecSecurity(value) ? value : fallback;
}

function normalizeAsk(value: unknown, fallback: ExecAsk): ExecAsk {
  return isExecAsk(value) ? value : fallback;
}

type ResolvedExecPolicyField<TValue extends ExecSecurity | ExecAsk> = {
  value: TValue;
  source: string | null;
};

function resolveDefaultSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const defaultValue = params.defaults[params.field];
  if (isExecSecurity(defaultValue)) {
    return {
      value: defaultValue,
      source: `defaults.${params.field}`,
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveDefaultAskField(params: {
  defaults: ExecApprovalsDefaults;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  if (isExecAsk(params.defaults.ask)) {
    return {
      value: params.defaults.ask,
      source: "defaults.ask",
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveAgentSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const fallbackField = resolveDefaultSecurityField({
    field: params.field,
    defaults: params.defaults,
    fallback: params.fallback,
  });
  const rawAgentValue = params.rawAgent[params.field];
  if (rawAgentValue != null) {
    if (isExecSecurity(params.agent[params.field])) {
      return {
        value: params.agent[params.field] as ExecSecurity,
        source: `agents.${params.agentKey}.${params.field}`,
      };
    }
    return fallbackField;
  }
  const rawWildcardValue = params.rawWildcard[params.field];
  if (rawWildcardValue != null) {
    if (isExecSecurity(params.wildcard[params.field])) {
      return {
        value: params.wildcard[params.field] as ExecSecurity,
        source: `agents.*.${params.field}`,
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

function resolveAgentAskField(params: {
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  const fallbackField = resolveDefaultAskField({
    defaults: params.defaults,
    fallback: params.fallback,
  });
  if (params.rawAgent.ask != null) {
    if (isExecAsk(params.agent.ask)) {
      return {
        value: params.agent.ask,
        source: `agents.${params.agentKey}.ask`,
      };
    }
    return fallbackField;
  }
  if (params.rawWildcard.ask != null) {
    if (isExecAsk(params.wildcard.ask)) {
      return {
        value: params.wildcard.ask,
        source: "agents.*.ask",
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

export type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
  requireSocket?: boolean;
};

function shapeResolvedExecApprovals(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  socket: "none" | "persisted";
}): ExecApprovalsResolved {
  const defaultSocketPath = resolveExecApprovalsSocketPath();
  return resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
    overrides: params.overrides,
    path: params.filePath,
    socketPath:
      params.socket === "persisted"
        ? expandHomePrefix(params.file.socket?.path ?? defaultSocketPath)
        : defaultSocketPath,
    token: params.socket === "persisted" ? (params.file.socket?.token ?? "") : "",
  });
}

function resolveExecApprovalsWithoutSocket(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
}): ExecApprovalsResolved | null {
  const resolved = shapeResolvedExecApprovals({ ...params, socket: "none" });
  const noPrompt =
    (resolved.agent.security === "full" || resolved.agent.security === "deny") &&
    resolved.agent.ask === "off";
  return noPrompt && !params.file.socket?.token?.trim() ? resolved : null;
}

export function resolveExecApprovals(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): ExecApprovalsResolved {
  const filePath = resolveExecApprovalsPath();
  if (hasUnmigratedLegacyExecApprovals(filePath)) {
    return shapeResolvedExecApprovals({
      file: createUnmigratedLegacyExecApprovalsFallback(),
      filePath,
      agentId,
      overrides,
      socket: "none",
    });
  }
  if (!overrides?.requireSocket) {
    const file = withExecApprovalsReadLockSync(filePath, () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  const file = ensureExecApprovals();
  return shapeResolvedExecApprovals({
    file,
    filePath,
    agentId,
    overrides,
    socket: "persisted",
  });
}

export async function resolveExecApprovalsLocked(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): Promise<ExecApprovalsResolved> {
  const filePath = resolveExecApprovalsPath();
  if (hasUnmigratedLegacyExecApprovals(filePath)) {
    return shapeResolvedExecApprovals({
      file: createUnmigratedLegacyExecApprovalsFallback(),
      filePath,
      agentId,
      overrides,
      socket: "none",
    });
  }
  if (!overrides?.requireSocket) {
    const file = await withExecApprovalsReadLock(filePath, async () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  return shapeResolvedExecApprovals({
    file: (await ensureExecApprovalsSnapshot()).file,
    filePath: resolveExecApprovalsPath(),
    agentId,
    overrides,
    socket: "persisted",
  });
}

export function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  const rawAgent = rawFile.agents?.[agentKey] ?? {};
  const rawWildcard = rawFile.agents?.["*"] ?? {};
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_EXEC_APPROVAL_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback,
    ),
    autoAllowSkills: defaults.autoAllowSkills ?? fallbackAutoAllowSkills,
  };
  const resolvedAgentSecurity = resolveAgentSecurityField({
    field: "security",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.security,
  });
  const resolvedAgentAsk = resolveAgentAskField({
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.ask,
  });
  const resolvedAgentAskFallback = resolveAgentSecurityField({
    field: "askFallback",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.askFallback,
  });
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: resolvedAgentSecurity.value,
    ask: resolvedAgentAsk.value,
    askFallback: resolvedAgentAskFallback.value,
    autoAllowSkills:
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
  };
  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];
  return {
    path: params.path ?? resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token ?? file.socket?.token ?? "",
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    agentSources: {
      security: resolvedAgentSecurity.source,
      ask: resolvedAgentAsk.source,
      askFallback: resolvedAgentAskFallback.source,
    },
    allowlist,
    file,
  };
}

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
}): boolean {
  if (params.ask === "always") {
    return true;
  }
  if (params.durableApprovalSatisfied === true) {
    return false;
  }
  return (
    params.ask === "on-miss" &&
    params.security === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied)
  );
}

function normalizeCommandName(value: string | undefined): string {
  return (value ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function textMentionsSecurityAuditSuppressions(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("security.audit.suppressions") ||
    /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(
      normalized,
    )
  );
}

function isReadOnlySecurityAuditSuppressionInspection(argv: string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  let offset = command === "pnpm" && argv[1] === "openclaw" ? 1 : 0;
  if (normalizeCommandName(argv[offset]) !== "openclaw") {
    return false;
  }
  offset += 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (["--dev", "--no-color"].includes(arg ?? "")) {
      offset += 1;
      continue;
    }
    if (["--profile", "--container", "--log-level"].includes(arg ?? "")) {
      offset += 2;
      continue;
    }
    if (
      arg?.startsWith("--profile=") ||
      arg?.startsWith("--container=") ||
      arg?.startsWith("--log-level=")
    ) {
      offset += 1;
      continue;
    }
    break;
  }
  return (
    argv[offset] === "config" && ["get", "schema", "validate"].includes(argv[offset + 1] ?? "")
  );
}

function removeParsedSegmentText(
  command: string,
  segments: Array<{ argv?: string[]; raw?: string }>,
): string {
  let remaining = command;
  for (const segment of segments) {
    const raw = (segment.raw ?? segment.argv?.join(" "))?.trim();
    if (!raw) {
      continue;
    }
    remaining = remaining.replace(raw, " ");
  }
  return remaining;
}

export function commandRequiresSecurityAuditSuppressionApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  segments: Array<{ argv: string[]; raw?: string }>;
}): boolean {
  let sawSegmentMention = false;
  for (const segment of params.segments) {
    const segmentText = `${segment.raw ?? ""} ${segment.argv.join(" ")}`;
    if (!textMentionsSecurityAuditSuppressions(segmentText)) {
      continue;
    }
    sawSegmentMention = true;
    if (!isReadOnlySecurityAuditSuppressionInspection(segment.argv)) {
      return true;
    }
  }
  if (sawSegmentMention) {
    const unparsedText = removeParsedSegmentText(params.command, params.segments);
    if (textMentionsSecurityAuditSuppressions(unparsedText)) {
      return true;
    }
    return false;
  }
  return textMentionsSecurityAuditSuppressions(params.command);
}

export function hasDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  return (
    hasExactCommandDurableExecApproval({
      allowlist: params.allowlist,
      commandText: params.commandText,
    }) ||
    hasSegmentDurableExecApproval({
      analysisOk: params.analysisOk,
      segmentAllowlistEntries: params.segmentAllowlistEntries,
    })
  );
}

// Digest input is the trimmed command text only. Shipped approvals files
// already hold `=command:` entries in this format; changing the input
// silently orphans every persisted exact-command grant.
function buildDurableCommandApprovalPattern(commandText: string): string {
  return `=command:${sha256HexPrefix(commandText, 16)}`;
}

function buildNodeCommandApprovalPattern(commandText: string): string {
  return `=node-command:${sha256HexPrefix(commandText, 16)}`;
}

export function hasNodeCommandAllowAlwaysMarker(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildNodeCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) => entry.source === "allow-always" && entry.pattern === commandPattern,
  );
}

export function hasExactCommandDurableExecApproval(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildDurableCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) =>
      entry.source === "allow-always" &&
      (entry.pattern === commandPattern ||
        (typeof entry.commandText === "string" && entry.commandText.trim() === normalizedCommand)),
  );
}

type DurableExecApprovalRequirement = "exact-command" | "segment-allowlist";

/** Callers pass whether their final, post-gate authorization depends on a durable grant. */
export function resolveDurableExecApprovalRequirement(params: {
  durableApprovalRequired: boolean;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): DurableExecApprovalRequirement | null {
  if (!params.durableApprovalRequired) {
    return null;
  }
  return hasExactCommandDurableExecApproval({
    allowlist: params.allowlist,
    commandText: params.commandText,
  })
    ? "exact-command"
    : "segment-allowlist";
}

function hasSegmentDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
}): boolean {
  return (
    params.analysisOk &&
    params.segmentAllowlistEntries.length > 0 &&
    params.segmentAllowlistEntries.every((entry) => entry?.source === "allow-always")
  );
}

function buildAllowlistEntryMatchKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern">,
): string {
  return JSON.stringify([entry.pattern, entry.argPattern ?? null]);
}

function buildExecApprovalPolicyRuleKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern" | "source">,
): string {
  // A JSON tuple preserves exact regex bytes without delimiter collisions.
  return JSON.stringify([entry.pattern, entry.argPattern ?? null, entry.source ?? null]);
}

function buildAllowAlwaysUpgradeRuleKey(
  rule: Pick<ExecAllowlistEntry, "pattern" | "argPattern" | "source">,
): string | null {
  if (rule.source !== undefined) {
    return null;
  }
  return buildExecApprovalPolicyRuleKey({ ...rule, source: "allow-always" });
}

/** Captures effective file policy while excluding ids and mutable usage metadata. */
export function createExecApprovalPolicySnapshot(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
}): ExecApprovalPolicySnapshot {
  // Runtime overrides are deliberately absent: the snapshot protects the
  // persisted policy that may change while a human approval is pending.
  const resolved = resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
  });
  const allowlistRulesByKey = new Map(
    resolved.allowlist.map((entry) => {
      const rule = {
        pattern: entry.pattern,
        ...(entry.argPattern !== undefined ? { argPattern: entry.argPattern } : {}),
        ...(entry.source === "allow-always" ? { source: entry.source } : {}),
      };
      return [buildExecApprovalPolicyRuleKey(rule), rule] as const;
    }),
  );
  return {
    security: resolved.agent.security,
    ask: resolved.agent.ask,
    askFallback: resolved.agent.askFallback,
    autoAllowSkills: resolved.agent.autoAllowSkills,
    allowlistRules: canonicalizeExecApprovalPolicyRules([...allowlistRulesByKey.values()]),
  };
}

export function isExecApprovalPolicySnapshotCurrent(
  expected: ExecApprovalPolicySnapshot,
  current: ExecApprovalPolicySnapshot,
): boolean {
  const currentRuleKeys = new Set(current.allowlistRules.map(buildExecApprovalPolicyRuleKey));
  return (
    expected.security === current.security &&
    expected.ask === current.ask &&
    expected.askFallback === current.askFallback &&
    expected.autoAllowSkills === current.autoAllowSkills &&
    // Concurrent operator-approved grants are additive. Preserve them while
    // accepting an in-place allow-always upgrade of the same rule. Revocations
    // and reverse source downgrades still remove an expected authority.
    expected.allowlistRules.every((rule) => {
      const key = buildExecApprovalPolicyRuleKey(rule);
      if (currentRuleKeys.has(key)) {
        return true;
      }
      const upgradedKey = buildAllowAlwaysUpgradeRuleKey(rule);
      return upgradedKey !== null && currentRuleKeys.has(upgradedKey);
    })
  );
}

export type ExecApprovalUsageAuthorization = {
  source: "current-policy" | "ask-fallback" | "explicit-approval" | "auto-review";
  security: ExecSecurity;
  ask: ExecAsk;
  allowlistSatisfied: boolean;
  policySnapshot?: ExecApprovalPolicySnapshot;
  requireAutoAllowSkills?: boolean;
  requireExactCommandApproval?: boolean;
  requireDurableAllowlistApproval?: boolean;
};

function assertCurrentUsageAuthorization(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  command: string;
  matchKeys: ReadonlySet<string>;
  authorization: ExecApprovalUsageAuthorization;
}): void {
  const current = resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
    overrides: {
      security: params.authorization.security,
      ask: params.authorization.ask,
    },
  });
  const security = minSecurity(params.authorization.security, current.agent.security);
  const ask = maxAsk(params.authorization.ask, current.agent.ask);
  if (security === "deny") {
    throw new Error("Exec approval changed before execution");
  }
  // Human and model decisions are delayed authority. Bind both one-shot and
  // persistent decisions to the persisted policy they were evaluated against.
  const delayedAuthorization =
    params.authorization.source === "explicit-approval" ||
    params.authorization.source === "auto-review";
  if (delayedAuthorization) {
    const expectedPolicy = params.authorization.policySnapshot;
    if (
      !expectedPolicy ||
      !isExecApprovalPolicySnapshotCurrent(
        expectedPolicy,
        createExecApprovalPolicySnapshot({ file: params.file, agentId: params.agentId }),
      )
    ) {
      throw new Error("Exec approval changed before execution");
    }
  }
  if (params.authorization.source === "explicit-approval") {
    return;
  }
  if (params.authorization.source === "auto-review") {
    if (ask === "always") {
      throw new Error("Exec approval changed before execution");
    }
    return;
  }
  let authorizationSecurity = security;
  if (params.authorization.source === "ask-fallback") {
    const askFallback = minSecurity(security, current.agent.askFallback);
    // The execution plan was built for the evaluated fallback mode. If policy
    // tightened, fail closed instead of reusing a broader argv plan.
    if (askFallback === "deny" || askFallback !== params.authorization.security) {
      throw new Error("Exec approval changed before execution");
    }
    if (askFallback === "full") {
      return;
    }
    authorizationSecurity = askFallback;
  } else if (
    // A current-policy plan may only survive policy broadening. Tightening from
    // full to allowlist requires a newly bound command, not the stale raw plan.
    security !== params.authorization.security ||
    ask !== params.authorization.ask
  ) {
    throw new Error("Exec approval changed before execution");
  }
  if (authorizationSecurity !== "allowlist") {
    return;
  }
  if (params.authorization.requireExactCommandApproval) {
    if (
      !hasExactCommandDurableExecApproval({
        allowlist: current.allowlist,
        commandText: params.command,
      })
    ) {
      throw new Error("Exec approval changed before execution");
    }
    return;
  }
  if (params.authorization.requireDurableAllowlistApproval) {
    const durableKeys = new Set(
      current.allowlist
        .filter((entry) => entry.source === "allow-always")
        .map(buildAllowlistEntryMatchKey),
    );
    if (params.matchKeys.size === 0 || [...params.matchKeys].some((key) => !durableKeys.has(key))) {
      throw new Error("Exec approval changed before execution");
    }
  }
  if (!params.authorization.allowlistSatisfied) {
    throw new Error("Exec approval changed before execution");
  }
  const currentKeys = new Set(current.allowlist.map(buildAllowlistEntryMatchKey));
  if ([...params.matchKeys].some((key) => !currentKeys.has(key))) {
    throw new Error("Exec approval changed before execution");
  }
  if (params.authorization.requireAutoAllowSkills && !current.agent.autoAllowSkills) {
    throw new Error("Exec approval changed before execution");
  }
}

function replaceExecApprovalsSnapshot(target: ExecApprovalsFile, source: ExecApprovalsFile): void {
  target.version = source.version;
  if (source.socket === undefined) {
    delete target.socket;
  } else {
    target.socket = source.socket;
  }
  if (source.defaults === undefined) {
    delete target.defaults;
  } else {
    target.defaults = source.defaults;
  }
  if (source.agents === undefined) {
    delete target.agents;
  } else {
    target.agents = source.agents;
  }
}

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
): void {
  recordAllowlistMatchesUse({
    approvals,
    agentId,
    matches: [entry],
    command,
    resolvedPath,
  });
}

export function recordAllowlistMatchesUse(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization?: ExecApprovalUsageAuthorization;
}): void {
  if (params.matches.length === 0 && !params.authorization) {
    return;
  }
  const snapshot = updateExecApprovalsSync({
    update: (file) => applyRecordedAllowlistUse({ ...params, file }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(params.approvals, snapshot.file);
  }
}

function applyRecordedAllowlistUse(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization?: ExecApprovalUsageAuthorization;
}): ExecApprovalsFile | null {
  const keys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  if (params.authorization) {
    assertCurrentUsageAuthorization({
      file: params.file,
      agentId: params.agentId,
      command: params.command,
      matchKeys: keys,
      authorization: params.authorization,
    });
  }
  return applyRecordedAllowlistMetadata(params);
}

function applyRecordedAllowlistMetadata(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
}): ExecApprovalsFile | null {
  const keys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  if (keys.size === 0) {
    return null;
  }
  const target = params.agentId ?? DEFAULT_AGENT_ID;
  const agents = params.file.agents ?? {};
  let changed = false;
  const nextAgents = { ...agents };
  for (const key of target === "*" ? [target] : ["*", target]) {
    const existing = agents[key];
    if (!existing?.allowlist) {
      continue;
    }
    let entryChanged = false;
    const nextAllowlist = existing.allowlist.map((entry) => {
      if (!keys.has(buildAllowlistEntryMatchKey(entry))) {
        return entry;
      }
      changed = true;
      entryChanged = true;
      return Object.assign({}, entry, {
        id: entry.id ?? crypto.randomUUID(),
        lastUsedAt: Date.now(),
        lastUsedCommand: params.command,
        lastResolvedPath: params.resolvedPath,
      });
    });
    if (entryChanged) {
      nextAgents[key] = { ...existing, allowlist: nextAllowlist };
    }
  }
  return changed
    ? {
        ...params.file,
        agents: nextAgents,
      }
    : null;
}
export async function commitExecAuthorizationLocked(params: {
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization: ExecApprovalUsageAuthorization;
  allowAlwaysDecision?: AllowAlwaysPersistenceDecision;
}): Promise<void> {
  if (
    (params.authorization.source === "explicit-approval" ||
      params.authorization.source === "auto-review") &&
    !params.authorization.policySnapshot
  ) {
    throw new Error("Delayed exec authorization requires a policy snapshot");
  }
  if (params.allowAlwaysDecision && params.allowAlwaysDecision.kind !== "one-shot") {
    if (params.authorization.source !== "explicit-approval") {
      throw new Error("Allow-always persistence requires explicit approval");
    }
  }
  await updateExecApprovals({
    update: (file) => {
      const matchKeys = new Set(
        params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
      );
      assertCurrentUsageAuthorization({
        file,
        agentId: params.agentId,
        command: params.command,
        matchKeys,
        authorization: params.authorization,
      });

      let next = file;
      let changed = false;
      if (params.allowAlwaysDecision && params.allowAlwaysDecision.kind !== "one-shot") {
        const granted = applyAllowAlwaysDecision({
          file: next,
          agentId: params.agentId,
          decision: params.allowAlwaysDecision,
        });
        if (granted) {
          next = granted;
          changed = true;
        }
      }
      const recorded = applyRecordedAllowlistMetadata({ ...params, file: next });
      return recorded ?? (changed ? next : null);
    },
  });
}

function applyAllowlistEntryUpdate(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  pattern: string;
  options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
  };
}): ExecApprovalsFile | null {
  const target = params.agentId ?? DEFAULT_AGENT_ID;
  const agents = params.file.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  const trimmed = params.pattern.trim();
  if (!trimmed) {
    return null;
  }
  const argPattern = params.options?.argPattern === "" ? undefined : params.options?.argPattern;
  const existingEntry = allowlist.find(
    (entry) => entry.pattern === trimmed && (entry.argPattern ?? undefined) === argPattern,
  );
  if (
    existingEntry &&
    (!params.options?.source || existingEntry.source === params.options.source)
  ) {
    return null;
  }
  const now = Date.now();
  const nextAllowlist = existingEntry
    ? allowlist.map((entry) =>
        entry.pattern === trimmed && (entry.argPattern ?? undefined) === argPattern
          ? {
              ...entry,
              argPattern,
              source: params.options?.source ?? entry.source,
              lastUsedAt: now,
            }
          : entry,
      )
    : [
        ...allowlist,
        {
          id: crypto.randomUUID(),
          pattern: trimmed,
          argPattern,
          source: params.options?.source,
          lastUsedAt: now,
        },
      ];
  return {
    ...params.file,
    agents: { ...agents, [target]: { ...existing, allowlist: nextAllowlist } },
  };
}

export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string,
  options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
  },
): void {
  const snapshot = updateExecApprovalsSync({
    update: (file) =>
      applyAllowlistEntryUpdate({
        file,
        agentId,
        pattern,
        options,
      }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(approvals, snapshot.file);
  }
}

export function addDurableCommandApproval(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  commandText: string,
): void {
  const normalized = commandText.trim();
  if (!normalized) {
    return;
  }
  addAllowlistEntry(approvals, agentId, buildDurableCommandApprovalPattern(normalized), {
    source: "allow-always",
  });
}

export function resolveAllowAlwaysPatternCoverage(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): {
  complete: boolean;
  patterns: ReturnType<typeof resolveAllowAlwaysPatternEntries>;
} {
  const byKey = new Map<string, ReturnType<typeof resolveAllowAlwaysPatternEntries>[number]>();
  let representedSegmentCount = 0;
  for (const segment of params.segments) {
    if (isShellWrapperInvocation(segment.argv)) {
      const segmentPatterns = resolveAllowAlwaysPatternEntries({
        segments: [segment],
        cwd: params.cwd,
        env: params.env,
        platform: params.platform,
        strictInlineEval: params.strictInlineEval,
      });
      for (const pattern of segmentPatterns) {
        byKey.set(`${pattern.pattern}\x00${pattern.argPattern ?? ""}`, pattern);
      }
      continue;
    }
    const segmentPatterns = resolveAllowAlwaysPatternEntries({
      segments: [segment],
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (segmentPatterns.length === 0) {
      continue;
    }
    representedSegmentCount += 1;
    for (const pattern of segmentPatterns) {
      byKey.set(`${pattern.pattern}\x00${pattern.argPattern ?? ""}`, pattern);
    }
  }
  return {
    complete: params.segments.length > 0 && representedSegmentCount === params.segments.length,
    patterns: [...byKey.values()],
  };
}

export function persistAllowAlwaysPatterns(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  commandText?: string;
  strictInlineEval?: boolean;
}): ReturnType<typeof resolveAllowAlwaysPatternEntries> {
  const coverage = resolveAllowAlwaysPatternCoverage(params);
  const commandText = params.commandText?.trim();
  persistAllowAlwaysDecision({
    approvals: params.approvals,
    agentId: params.agentId,
    decision: {
      kind: "patterns",
      patterns: coverage.patterns,
      ...(commandText && coverage.complete && coverage.patterns.length > 0 ? { commandText } : {}),
    },
  });
  return coverage.patterns;
}

export type AllowAlwaysPersistenceReason =
  | "no-reusable-pattern"
  | "prompt-only"
  | "runtime-payload"
  | "unplanned";

export type AllowAlwaysPersistenceDecision =
  | { kind: "patterns"; patterns: readonly AllowAlwaysPattern[]; commandText?: string }
  | { kind: "exact-command"; commandText: string }
  | { kind: "one-shot"; reasons: AllowAlwaysPersistenceReason[] };

function hasRuntimeShellPayload(argv: readonly string[]): boolean {
  const inlineCommand = extractBindableShellWrapperInlineCommand([...argv]);
  return Boolean(
    inlineCommand &&
    (/(?:\$[A-Za-z0-9_@*?#$!-]|\$\{|`|\$\()/u.test(inlineCommand) ||
      hasPosixInteractiveStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS) ||
      hasPosixLoginStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS)),
  );
}

function resolvePlanPersistenceState(plan: ExecAuthorizationPlan | undefined): {
  reusablePatternsAllowed: boolean;
  reasons: AllowAlwaysPersistenceReason[];
} {
  if (!plan) {
    return { reusablePatternsAllowed: true, reasons: [] };
  }
  if (!plan.ok) {
    return { reusablePatternsAllowed: false, reasons: ["unplanned"] };
  }
  const reasons = new Set<AllowAlwaysPersistenceReason>();
  let reusablePatternsAllowed = true;
  const candidates = plan.groups.flatMap((group) => group.candidates);
  for (const candidate of candidates) {
    if (candidate.trustMode === "prompt-only") {
      reasons.add("prompt-only");
    }
    if (candidate.trustMode === "exact-command") {
      // Durable `=command:` entries are command-text-only and cannot bind
      // cwd, env, or PATH, so planner exact-command candidates stay one-shot.
      reasons.add("no-reusable-pattern");
    }
    if (candidate.trustMode === "executable" && !candidate.allowAlways) {
      reasons.add("no-reusable-pattern");
    }
    reusablePatternsAllowed = reusablePatternsAllowed && candidate.allowAlways;
    if (hasRuntimeShellPayload(candidate.sourceSegment.argv)) {
      reasons.add("runtime-payload");
    }
    if (
      candidate.transport.kind === "shell-wrapper" &&
      hasRuntimeShellPayload(candidate.transport.wrapperArgv)
    ) {
      reasons.add("runtime-payload");
    }
  }
  return {
    reusablePatternsAllowed,
    reasons: [...reasons],
  };
}

export function resolveAllowAlwaysPersistenceDecision(params: {
  segments: ExecCommandSegment[];
  commandText?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
  authorizationPlan?: ExecAuthorizationPlan;
  runtimePayload?: boolean;
  preparedCoverage?: ReturnType<typeof resolveAllowAlwaysPatternCoverage> | null;
}): AllowAlwaysPersistenceDecision {
  const planPersistence = resolvePlanPersistenceState(params.authorizationPlan);
  const reasons = new Set<AllowAlwaysPersistenceReason>(planPersistence.reasons);
  if (params.runtimePayload === true) {
    reasons.add("runtime-payload");
  }
  const commandText = params.commandText?.trim();
  const hardReasons = [...reasons].filter((reason) => reason !== "no-reusable-pattern");
  if (hardReasons.length > 0) {
    return { kind: "one-shot", reasons: hardReasons };
  }

  if (params.preparedCoverage?.complete === true && params.preparedCoverage.patterns.length > 0) {
    return {
      kind: "patterns",
      patterns: params.preparedCoverage.patterns,
      ...(commandText ? { commandText } : {}),
    };
  }

  if (planPersistence.reusablePatternsAllowed) {
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: params.segments,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (coverage.patterns.length > 0) {
      return {
        kind: "patterns",
        patterns: coverage.patterns,
        ...(commandText && coverage.complete ? { commandText } : {}),
      };
    }
  }

  reasons.add("no-reusable-pattern");
  return { kind: "one-shot", reasons: [...reasons] };
}

export function persistAllowAlwaysDecision(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  decision: AllowAlwaysPersistenceDecision;
}): void {
  const decision = params.decision;
  if (decision.kind === "one-shot") {
    return;
  }
  const snapshot = updateExecApprovalsSync({
    update: (file) =>
      applyAllowAlwaysDecision({
        file,
        agentId: params.agentId,
        decision,
      }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(params.approvals, snapshot.file);
  }
}

function applyAllowAlwaysDecision(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  decision: Exclude<AllowAlwaysPersistenceDecision, { kind: "one-shot" }>;
}): ExecApprovalsFile | null {
  const entries: Array<{
    pattern: string;
    argPattern?: string;
    source: "allow-always";
  }> =
    params.decision.kind === "exact-command"
      ? params.decision.commandText.trim()
        ? [
            {
              pattern: buildDurableCommandApprovalPattern(params.decision.commandText.trim()),
              source: "allow-always" as const,
            },
          ]
        : []
      : [
          ...params.decision.patterns.map((pattern) => ({
            pattern: pattern.pattern,
            argPattern: pattern.argPattern,
            source: "allow-always" as const,
          })),
          ...(params.decision.commandText?.trim()
            ? [
                {
                  pattern: buildNodeCommandApprovalPattern(params.decision.commandText.trim()),
                  source: "allow-always" as const,
                },
              ]
            : []),
        ];
  let next = params.file;
  let changed = false;
  for (const entry of entries) {
    const updated = applyAllowlistEntryUpdate({
      file: next,
      agentId: params.agentId,
      pattern: entry.pattern,
      options: { argPattern: entry.argPattern, source: entry.source },
    });
    if (updated) {
      next = updated;
      changed = true;
    }
  }
  return changed ? next : null;
}
export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
export const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
export const OPTIONAL_EXEC_APPROVAL_DECISIONS = [
  "allow-always",
] as const satisfies readonly ExecApprovalDecision[];
export type ExecApprovalUnavailableDecision = (typeof OPTIONAL_EXEC_APPROVAL_DECISIONS)[number];

const OPTIONAL_EXEC_APPROVAL_DECISION_SET: ReadonlySet<string> = new Set(
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
);

function isOptionalExecApprovalDecision(
  decision: string,
): decision is ExecApprovalUnavailableDecision {
  return OPTIONAL_EXEC_APPROVAL_DECISION_SET.has(decision);
}

function collectExecApprovalUnavailableDecisionSet(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): ReadonlySet<ExecApprovalUnavailableDecision> {
  const unavailable = new Set<ExecApprovalUnavailableDecision>();
  if (!Array.isArray(decisions)) {
    return unavailable;
  }
  for (const decision of decisions) {
    if (isOptionalExecApprovalDecision(decision)) {
      unavailable.add(decision);
    }
  }
  return unavailable;
}

export function normalizeExecApprovalUnavailableDecisions(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): readonly ExecApprovalUnavailableDecision[] {
  const unavailable = collectExecApprovalUnavailableDecisionSet(decisions);
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => unavailable.has(decision));
}

export function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalDecision[] {
  const ask = normalizeExecAsk(params?.ask);
  if (ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function resolveExecApprovalUnavailableDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalUnavailableDecision[] {
  const allowed = new Set(resolveExecApprovalAllowedDecisions(params));
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => !allowed.has(decision));
}

export function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const policyDecisions = resolveExecApprovalAllowedDecisions({ ask: params?.ask });
  const unavailableDecisions = collectExecApprovalUnavailableDecisionSet(
    params?.unavailableDecisions,
  );
  if (unavailableDecisions.size === 0) {
    return policyDecisions;
  }
  return policyDecisions.filter(
    (decision) => !isOptionalExecApprovalDecision(decision) || !unavailableDecisions.has(decision),
  );
}

export function isExecApprovalDecisionAllowed(params: {
  decision: ExecApprovalDecision;
  ask?: string | null;
}): boolean {
  return resolveExecApprovalAllowedDecisions({ ask: params.ask }).includes(params.decision);
}

export async function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null> {
  const { socketPath, token, request } = params;
  if (!socketPath || !token) {
    return null;
  }
  const timeoutMs = params.timeoutMs ?? 15_000;
  const payload = JSON.stringify({
    type: "request",
    token,
    id: crypto.randomUUID(),
    request,
  });

  return await requestJsonlSocket({
    socketPath,
    requestLine: payload,
    timeoutMs,
    accept: (value) => {
      const msg = value as { type?: string; decision?: ExecApprovalDecision };
      if (msg?.type === "decision" && msg.decision) {
        return msg.decision;
      }
      return undefined;
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
