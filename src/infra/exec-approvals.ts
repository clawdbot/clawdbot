import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";
export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecTarget = "auto" | ExecHost;
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

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
  mutableFileOperand?: SystemRunApprovalFileOperand | null;
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
export const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK: ExecSecurity = "full";
const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_SOCKET = "~/.openclaw/exec-approvals.sock";
const DEFAULT_FILE = "~/.openclaw/exec-approvals.json";

function hashExecApprovalsRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

export function resolveExecApprovalsPath(): string {
  return expandHomePrefix(DEFAULT_FILE);
}

export function resolveExecApprovalsSocketPath(): string {
  return expandHomePrefix(DEFAULT_SOCKET);
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
  assertNoSymlinkPathComponents(dir, resolveRequiredHomeDir());
  fs.mkdirSync(dir, { recursive: true });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use unsafe exec approvals directory: ${dir}`);
  }
  return dir;
}

function assertNoSymlinkPathComponents(targetPath: string, trustedRoot: string): void {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(trustedRoot);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return;
  }

  const relative = path.relative(resolvedRoot, resolvedTarget);
  const segments = relative && relative !== "." ? relative.split(path.sep) : [];
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to traverse symlink in exec approvals path: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

function assertSafeExecApprovalsDestination(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write exec approvals via symlink: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
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
  const token = params.normalized.socket?.token?.trim() ?? currentToken ?? "";
  return {
    ...params.normalized,
    socket: {
      path: socketPath,
      token,
    },
  };
}

function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  const filePath = resolveExecApprovalsPath();
  if (!fs.existsSync(filePath)) {
    const file = normalizeExecApprovals({ version: 1, agents: {} });
    return {
      path: filePath,
      exists: false,
      raw: null,
      file,
      hash: hashExecApprovalsRaw(null),
    };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: ExecApprovalsFile | null = null;
  try {
    parsed = JSON.parse(raw) as ExecApprovalsFile;
  } catch {
    parsed = null;
  }
  const file =
    parsed?.version === 1
      ? normalizeExecApprovals(parsed)
      : normalizeExecApprovals({ version: 1, agents: {} });
  return {
    path: filePath,
    exists: true,
    raw,
    file,
    hash: hashExecApprovalsRaw(raw),
  };
}

export function loadExecApprovals(): ExecApprovalsFile {
  const filePath = resolveExecApprovalsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return normalizeExecApprovals({ version: 1, agents: {} });
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ExecApprovalsFile;
    if (parsed?.version !== 1) {
      return normalizeExecApprovals({ version: 1, agents: {} });
    }
    return normalizeExecApprovals(parsed);
  } catch {
    return normalizeExecApprovals({ version: 1, agents: {} });
  }
}

export function saveExecApprovals(file: ExecApprovalsFile) {
  const filePath = resolveExecApprovalsPath();
  const raw = `${JSON.stringify(file, null, 2)}\n`;
  writeExecApprovalsRaw(filePath, raw);
}

function writeExecApprovalsRaw(filePath: string, raw: string) {
  const dir = ensureDir(filePath);
  assertSafeExecApprovalsDestination(filePath);
  const tempPath = path.join(dir, `.exec-approvals.${process.pid}.${crypto.randomUUID()}.tmp`);
  let tempWritten = false;
  try {
    fs.writeFileSync(tempPath, raw, { mode: 0o600, flag: "wx" });
    tempWritten = true;
    fs.renameSync(tempPath, filePath);
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

export function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  if (snapshot.raw !== null) {
    writeExecApprovalsRaw(snapshot.path, snapshot.raw);
    return;
  }
  saveExecApprovals(snapshot.file);
}

export function ensureExecApprovals(): ExecApprovalsFile {
  const loaded = loadExecApprovals();
  const next = normalizeExecApprovals(loaded);
  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();
  const updated: ExecApprovalsFile = {
    ...next,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : resolveExecApprovalsSocketPath(),
      token: token && token.length > 0 ? token : generateToken(),
    },
  };
  saveExecApprovals(updated);
  return updated;
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
};

export function resolveExecApprovals(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): ExecApprovalsResolved {
  const file = ensureExecApprovals();
  return resolveExecApprovalsFromFile({
    file,
    agentId,
    overrides,
    path: resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(file.socket?.path ?? resolveExecApprovalsSocketPath()),
    token: file.socket?.token ?? "",
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

function buildDurableCommandApprovalPattern(commandText: string): string {
  const digest = crypto.createHash("sha256").update(commandText).digest("hex").slice(0, 16);
  return `=command:${digest}`;
}

function hasExactCommandDurableExecApproval(params: {
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

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  const nextAllowlist = allowlist.map((item) =>
    item.pattern === entry.pattern &&
    (item.argPattern ?? undefined) === (entry.argPattern ?? undefined)
      ? Object.assign({}, item, {
          id: item.id ?? crypto.randomUUID(),
          lastUsedAt: Date.now(),
          lastUsedCommand: command,
          lastResolvedPath: resolvedPath,
        })
      : item,
  );
  agents[target] = { ...existing, allowlist: nextAllowlist };
  approvals.agents = agents;
  saveExecApprovals(approvals);
}

function buildAllowlistEntryMatchKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern">,
): string {
  return `${entry.pattern}\x00${entry.argPattern?.trim() ?? ""}`;
}

export function recordAllowlistMatchesUse(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
}): void {
  if (params.matches.length === 0) {
    return;
  }
  const seen = new Set<string>();
  for (const match of params.matches) {
    if (!match.pattern) {
      continue;
    }
    const key = buildAllowlistEntryMatchKey(match);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    recordAllowlistUse(
      params.approvals,
      params.agentId,
      match,
      params.command,
      params.resolvedPath,
    );
  }
}

export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string,
  options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
  },
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  const trimmed = pattern.trim();
  if (!trimmed) {
    return;
  }
  const trimmedArgPattern = normalizeOptionalString(options?.argPattern);
  const existingEntry = allowlist.find(
    (entry) => entry.pattern === trimmed && (entry.argPattern ?? undefined) === trimmedArgPattern,
  );
  if (existingEntry && (!options?.source || existingEntry.source === options.source)) {
    return;
  }
  const now = Date.now();
  const nextAllowlist = existingEntry
    ? allowlist.map((entry) =>
        entry.pattern === trimmed
          ? {
              ...entry,
              argPattern: trimmedArgPattern,
              source: options?.source ?? entry.source,
              lastUsedAt: now,
            }
          : entry,
      )
    : [
        ...allowlist,
        {
          id: crypto.randomUUID(),
          pattern: trimmed,
          argPattern: trimmedArgPattern,
          source: options?.source,
          lastUsedAt: now,
        },
      ];
  agents[target] = { ...existing, allowlist: nextAllowlist };
  approvals.agents = agents;
  saveExecApprovals(approvals);
}

export function addDurableCommandApproval(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  commandText: string,
) {
  const normalized = commandText.trim();
  if (!normalized) {
    return;
  }
  addAllowlistEntry(approvals, agentId, buildDurableCommandApprovalPattern(normalized), {
    source: "allow-always",
  });
}

export function persistAllowAlwaysPatterns(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): ReturnType<typeof resolveAllowAlwaysPatternEntries> {
  const patterns = resolveAllowAlwaysPatternEntries({
    segments: params.segments,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
    strictInlineEval: params.strictInlineEval,
  });
  for (const pattern of patterns) {
    if (!pattern.pattern) {
      continue;
    }
    addAllowlistEntry(params.approvals, params.agentId, pattern.pattern, {
      argPattern: pattern.argPattern,
      source: "allow-always",
    });
  }
  return patterns;
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

export function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
}): readonly ExecApprovalDecision[] {
  const ask = normalizeExecAsk(params?.ask);
  if (ask === "always") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const explicit = Array.isArray(params?.allowedDecisions)
    ? params.allowedDecisions.filter(
        (decision): decision is ExecApprovalDecision =>
          decision === "allow-once" || decision === "allow-always" || decision === "deny",
      )
    : [];
  return explicit.length > 0 ? explicit : resolveExecApprovalAllowedDecisions({ ask: params?.ask });
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
