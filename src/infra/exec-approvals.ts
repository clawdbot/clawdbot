import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { DEFAULT_AGENT_ID } from "../routing/session-key.js";

export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

export type ExecApprovalsDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};

export type ExecAllowlistEntry = {
  pattern: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
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
  allowlist: ExecAllowlistEntry[];
  file: ExecApprovalsFile;
};

const DEFAULT_SECURITY: ExecSecurity = "deny";
const DEFAULT_ASK: ExecAsk = "on-miss";
const DEFAULT_ASK_FALLBACK: ExecSecurity = "deny";
const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_SOCKET = "~/.clawdbot/exec-approvals.sock";
const DEFAULT_FILE = "~/.clawdbot/exec-approvals.json";
export const DEFAULT_SAFE_BINS = ["jq", "grep", "cut", "sort", "uniq", "head", "tail", "tr", "wc"];

function hashExecApprovalsRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveExecApprovalsPath(): string {
  return expandHome(DEFAULT_FILE);
}

export function resolveExecApprovalsSocketPath(): string {
  return expandHome(DEFAULT_SOCKET);
}

function normalizeAllowlistPattern(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.toLowerCase() : null;
}

function mergeLegacyAgent(
  current: ExecApprovalsAgent,
  legacy: ExecApprovalsAgent,
): ExecApprovalsAgent {
  const allowlist: ExecAllowlistEntry[] = [];
  const seen = new Set<string>();
  const pushEntry = (entry: ExecAllowlistEntry) => {
    const key = normalizeAllowlistPattern(entry.pattern);
    if (!key || seen.has(key)) return;
    seen.add(key);
    allowlist.push(entry);
  };
  for (const entry of current.allowlist ?? []) pushEntry(entry);
  for (const entry of legacy.allowlist ?? []) pushEntry(entry);

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
  fs.mkdirSync(dir, { recursive: true });
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
  const normalized: ExecApprovalsFile = {
    version: 1,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : undefined,
      token: token && token.length > 0 ? token : undefined,
    },
    defaults: {
      security: file.defaults?.security,
      ask: file.defaults?.ask,
      askFallback: file.defaults?.askFallback,
      autoAllowSkills: file.defaults?.autoAllowSkills,
    },
    agents,
  };
  return normalized;
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
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
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

function normalizeSecurity(value: ExecSecurity | undefined, fallback: ExecSecurity): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") return value;
  return fallback;
}

function normalizeAsk(value: ExecAsk | undefined, fallback: ExecAsk): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") return value;
  return fallback;
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
    socketPath: expandHome(file.socket?.path ?? resolveExecApprovalsSocketPath()),
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
  const file = normalizeExecApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback,
    ),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? fallbackAutoAllowSkills),
  };
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(
      agent.security ?? wildcard.security ?? resolvedDefaults.security,
      resolvedDefaults.security,
    ),
    ask: normalizeAsk(agent.ask ?? wildcard.ask ?? resolvedDefaults.ask, resolvedDefaults.ask),
    askFallback: normalizeSecurity(
      agent.askFallback ?? wildcard.askFallback ?? resolvedDefaults.askFallback,
      resolvedDefaults.askFallback,
    ),
    autoAllowSkills: Boolean(
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
    ),
  };
  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];
  return {
    path: params.path ?? resolveExecApprovalsPath(),
    socketPath: expandHome(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token ?? file.socket?.token ?? "",
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    allowlist,
    file,
  };
}

type CommandResolution = {
  rawExecutable: string;
  resolvedPath?: string;
  executableName: string;
};

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function parseFirstToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const end = trimmed.indexOf(first, 1);
    if (end > 1) return trimmed.slice(1, end);
    return trimmed.slice(1);
  }
  const match = /^[^\s]+/.exec(trimmed);
  return match ? match[0] : null;
}

function resolveExecutablePath(rawExecutable: string, cwd?: string, env?: NodeJS.ProcessEnv) {
  const expanded = rawExecutable.startsWith("~") ? expandHome(rawExecutable) : rawExecutable;
  if (expanded.includes("/") || expanded.includes("\\")) {
    if (path.isAbsolute(expanded)) {
      return isExecutableFile(expanded) ? expanded : undefined;
    }
    const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
    const candidate = path.resolve(base, expanded);
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  const envPath = env?.PATH ?? process.env.PATH ?? "";
  const entries = envPath.split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (env?.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => ext.toLowerCase())
      : [""];
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, expanded + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveCommandResolution(
  command: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const rawExecutable = parseFirstToken(command);
  if (!rawExecutable) return null;
  const resolvedPath = resolveExecutablePath(rawExecutable, cwd, env);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
  return { rawExecutable, resolvedPath, executableName };
}

export function resolveCommandResolutionFromArgv(
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const rawExecutable = argv[0]?.trim();
  if (!rawExecutable) return null;
  const resolvedPath = resolveExecutablePath(rawExecutable, cwd, env);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
  return { rawExecutable, resolvedPath, executableName };
}

function normalizeMatchTarget(value: string): string {
  return value.replace(/\\\\/g, "/").toLowerCase();
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += ".";
      i += 1;
      continue;
    }
    regex += ch.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
    i += 1;
  }
  regex += "$";
  return new RegExp(regex, "i");
}

function matchesPattern(pattern: string, target: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const expanded = trimmed.startsWith("~") ? expandHome(trimmed) : trimmed;
  const normalizedPattern = normalizeMatchTarget(expanded);
  const normalizedTarget = normalizeMatchTarget(target);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedTarget);
}

export function matchAllowlist(
  entries: ExecAllowlistEntry[],
  resolution: CommandResolution | null,
): ExecAllowlistEntry | null {
  if (!entries.length || !resolution?.resolvedPath) return null;
  const resolvedPath = resolution.resolvedPath;
  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) continue;
    const hasPath = pattern.includes("/") || pattern.includes("\\") || pattern.includes("~");
    if (!hasPath) continue;
    if (matchesPattern(pattern, resolvedPath)) return entry;
  }
  return null;
}

export type ExecCommandSegment = {
  raw: string;
  argv: string[];
  resolution: CommandResolution | null;
};

export type ExecCommandAnalysis = {
  ok: boolean;
  reason?: string;
  segments: ExecCommandSegment[];
};

const DISALLOWED_TOKENS = new Set([";", "&", ">", "<", "`", "\n", "\r", "(", ")"]);

function splitShellPipeline(command: string): { ok: boolean; reason?: string; segments: string[] } {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushSegment = () => {
    const trimmed = buf.trim();
    if (!trimmed) {
      return false;
    }
    segments.push(trimmed);
    buf = "";
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      buf += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      buf += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      return { ok: false, reason: "unsupported shell token: ||", segments: [] };
    }
    if (ch === "|" && command[i + 1] === "&") {
      return { ok: false, reason: "unsupported shell token: |&", segments: [] };
    }
    if (ch === "|") {
      if (!pushSegment()) {
        return { ok: false, reason: "empty pipeline segment", segments: [] };
      }
      continue;
    }
    if (DISALLOWED_TOKENS.has(ch)) {
      return { ok: false, reason: `unsupported shell token: ${ch}`, segments: [] };
    }
    if (ch === "$" && command[i + 1] === "(") {
      return { ok: false, reason: "unsupported shell token: $()", segments: [] };
    }
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return { ok: false, reason: "unterminated shell quote/escape", segments: [] };
  }
  if (!pushSegment()) {
    return { ok: false, reason: "empty command", segments: [] };
  }
  return { ok: true, segments };
}

function tokenizeShellSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}

export function analyzeShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const split = splitShellPipeline(params.command);
  if (!split.ok) {
    return { ok: false, reason: split.reason, segments: [] };
  }
  const segments: ExecCommandSegment[] = [];
  for (const raw of split.segments) {
    const argv = tokenizeShellSegment(raw);
    if (!argv || argv.length === 0) {
      return { ok: false, reason: "unable to parse shell segment", segments: [] };
    }
    segments.push({
      raw,
      argv,
      resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env),
    });
  }
  return { ok: true, segments };
}

export function analyzeArgvCommand(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const argv = params.argv.filter((entry) => entry.trim().length > 0);
  if (argv.length === 0) {
    return { ok: false, reason: "empty argv", segments: [] };
  }
  return {
    ok: true,
    segments: [
      {
        raw: argv.join(" "),
        argv,
        resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env),
      },
    ],
  };
}

function isPathLikeToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === "-") return false;
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) return true;
  if (trimmed.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

function defaultFileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function normalizeSafeBins(entries?: string[]): Set<string> {
  if (!Array.isArray(entries)) return new Set();
  const normalized = entries
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

export function resolveSafeBins(entries?: string[] | null): Set<string> {
  if (entries === undefined) return normalizeSafeBins(DEFAULT_SAFE_BINS);
  return normalizeSafeBins(entries ?? []);
}

export function isSafeBinUsage(params: {
  argv: string[];
  resolution: CommandResolution | null;
  safeBins: Set<string>;
  cwd?: string;
  fileExists?: (filePath: string) => boolean;
}): boolean {
  if (params.safeBins.size === 0) return false;
  const resolution = params.resolution;
  const execName = resolution?.executableName?.toLowerCase();
  if (!execName) return false;
  const matchesSafeBin =
    params.safeBins.has(execName) ||
    (process.platform === "win32" && params.safeBins.has(path.parse(execName).name));
  if (!matchesSafeBin) return false;
  if (!resolution?.resolvedPath) return false;
  const cwd = params.cwd ?? process.cwd();
  const exists = params.fileExists ?? defaultFileExists;
  const argv = params.argv.slice(1);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token === "-") continue;
    if (token.startsWith("-")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex > 0) {
        const value = token.slice(eqIndex + 1);
        if (value && (isPathLikeToken(value) || exists(path.resolve(cwd, value)))) {
          return false;
        }
      }
      continue;
    }
    if (isPathLikeToken(token)) return false;
    if (exists(path.resolve(cwd, token))) return false;
  }
  return true;
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
    item.pattern === entry.pattern
      ? {
          ...item,
          lastUsedAt: Date.now(),
          lastUsedCommand: command,
          lastResolvedPath: resolvedPath,
        }
      : item,
  );
  agents[target] = { ...existing, allowlist: nextAllowlist };
  approvals.agents = agents;
  saveExecApprovals(approvals);
}

export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string,
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  const trimmed = pattern.trim();
  if (!trimmed) return;
  if (allowlist.some((entry) => entry.pattern === trimmed)) return;
  allowlist.push({ pattern: trimmed, lastUsedAt: Date.now() });
  agents[target] = { ...existing, allowlist };
  approvals.agents = agents;
  saveExecApprovals(approvals);
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

export async function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null> {
  const { socketPath, token, request } = params;
  if (!socketPath || !token) return null;
  const timeoutMs = params.timeoutMs ?? 15_000;
  return await new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    let buffer = "";
    const finish = (value: ExecApprovalDecision | null) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    const payload = JSON.stringify({
      type: "request",
      token,
      id: crypto.randomUUID(),
      request,
    });

    client.on("error", () => finish(null));
    client.connect(socketPath, () => {
      client.write(`${payload}\n`);
    });
    client.on("data", (data) => {
      buffer += data.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { type?: string; decision?: ExecApprovalDecision };
          if (msg?.type === "decision" && msg.decision) {
            clearTimeout(timer);
            finish(msg.decision);
            return;
          }
        } catch {
          // ignore
        }
      }
    });
  });
}
