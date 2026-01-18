import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
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
    agents: file.agents ?? {},
  };
  return normalized;
}

function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
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
      return normalizeExecApprovals({ version: 1, agents: parsed?.agents ?? {} });
    }
    return normalizeExecApprovals(parsed);
  } catch {
    return normalizeExecApprovals({ version: 1, agents: {} });
  }
}

export function saveExecApprovals(file: ExecApprovalsFile) {
  const filePath = resolveExecApprovalsPath();
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
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

function normalizeSecurity(value?: ExecSecurity): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") return value;
  return DEFAULT_SECURITY;
}

function normalizeAsk(value?: ExecAsk): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") return value;
  return DEFAULT_ASK;
}

export function resolveExecApprovals(agentId?: string): ExecApprovalsResolved {
  const file = ensureExecApprovals();
  const defaults = file.defaults ?? {};
  const agentKey = agentId ?? "default";
  const agent = file.agents?.[agentKey] ?? {};
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security),
    ask: normalizeAsk(defaults.ask),
    askFallback: normalizeSecurity(defaults.askFallback ?? DEFAULT_ASK_FALLBACK),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS),
  };
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(agent.security ?? resolvedDefaults.security),
    ask: normalizeAsk(agent.ask ?? resolvedDefaults.ask),
    askFallback: normalizeSecurity(agent.askFallback ?? resolvedDefaults.askFallback),
    autoAllowSkills: Boolean(agent.autoAllowSkills ?? resolvedDefaults.autoAllowSkills),
  };
  const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
  return {
    path: resolveExecApprovalsPath(),
    socketPath: expandHome(file.socket?.path ?? resolveExecApprovalsSocketPath()),
    token: file.socket?.token ?? "",
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

function parseFirstToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const end = trimmed.indexOf(first, 1);
    if (end > 1) return trimmed.slice(1, end);
    return trimmed.slice(1);
  }
  const match = /^[^\\s]+/.exec(trimmed);
  return match ? match[0] : null;
}

function resolveExecutablePath(rawExecutable: string, cwd?: string, env?: NodeJS.ProcessEnv) {
  const expanded = rawExecutable.startsWith("~") ? expandHome(rawExecutable) : rawExecutable;
  if (expanded.includes("/") || expanded.includes("\\")) {
    if (path.isAbsolute(expanded)) return expanded;
    const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
    return path.resolve(base, expanded);
  }
  const envPath = env?.PATH ?? process.env.PATH ?? "";
  const entries = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, expanded);
    if (fs.existsSync(candidate)) return candidate;
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
  if (!entries.length || !resolution) return null;
  const rawExecutable = resolution.rawExecutable;
  const resolvedPath = resolution.resolvedPath;
  const executableName = resolution.executableName;
  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) continue;
    const hasPath = pattern.includes("/") || pattern.includes("\\") || pattern.includes("~");
    if (hasPath) {
      const target = resolvedPath ?? rawExecutable;
      if (target && matchesPattern(pattern, target)) return entry;
      continue;
    }
    if (executableName && matchesPattern(pattern, executableName)) return entry;
  }
  return null;
}

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
) {
  const target = agentId ?? "default";
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
  const target = agentId ?? "default";
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
