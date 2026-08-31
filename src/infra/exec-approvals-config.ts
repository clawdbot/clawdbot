// Parses and normalizes the persisted exec approval policy.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import type {
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecAsk,
  ExecSecurity,
} from "./exec-approvals-core.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { expandHomePrefix, resolveHomeRelativePath } from "./home-dir.js";

const toStringOrUndefined = readStringValue;

const execSecuritySchema = z.enum(["allowlist", "full", "deny"]);
const execAskSchema = z.enum(["always", "off", "on-miss"]);
const persistedExecApprovalPolicySchema = z.looseObject({
  security: execSecuritySchema.optional(),
  ask: execAskSchema.optional(),
  askFallback: execSecuritySchema.optional(),
  autoAllowSkills: z.boolean().optional(),
});
function normalizePersistedAllowlistSource(value: string): "allow-always" | undefined {
  return value === "allow-always" ? value : undefined;
}
const persistedExecAllowlistEntrySchema = z
  .union([
    z.string().trim().min(1),
    z.looseObject({
      pattern: z.string().refine((value) => value.trim().length > 0),
      id: z.string().optional(),
      source: z.string().transform(normalizePersistedAllowlistSource).optional(),
      commandText: z.string().optional(),
      argPattern: z.string().optional(),
      lastUsedAt: z.number().finite().optional(),
      lastUsedCommand: z.string().optional(),
      lastResolvedPath: z.string().optional(),
    }),
  ])
  .transform(
    (value): ExecAllowlistEntry => (typeof value === "string" ? { pattern: value } : value),
  );
const persistedExecApprovalsAgentSchema = persistedExecApprovalPolicySchema.extend({
  allowlist: z.array(persistedExecAllowlistEntrySchema).optional(),
});
const persistedExecApprovalsAgentsSchema = z
  .unknown()
  .refine((value) => !isRecord(value) || !Object.hasOwn(value, "__proto__"))
  .pipe(z.record(z.string(), persistedExecApprovalsAgentSchema));
const persistedExecApprovalsSchema = z.looseObject({
  version: z.literal(1),
  socket: z
    .looseObject({
      path: z.string().optional(),
      token: z.string().optional(),
    })
    .optional(),
  defaults: persistedExecApprovalPolicySchema.optional(),
  agents: persistedExecApprovalsAgentsSchema.optional(),
});

export const DEFAULT_SECURITY: ExecSecurity = "full";
export const DEFAULT_ASK: ExecAsk = "off";
export const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK: ExecSecurity = "deny";
export const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_EXEC_APPROVALS_STATE_DIR = "~/.openclaw";
const EXEC_APPROVALS_FILE = "exec-approvals.json";
const EXEC_APPROVALS_SOCKET = "exec-approvals.sock";
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

export function resolveExecApprovalsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveExecApprovalsStateDir(env).path, EXEC_APPROVALS_FILE);
}

export function resolveExecApprovalsSocketPath(): string {
  return path.join(resolveExecApprovalsStateDir().path, EXEC_APPROVALS_SOCKET);
}

export function resolveExecApprovalsDisplayPath(): string {
  const stateDir = resolveExecApprovalsStateDir().displayPath;
  const locator = path.join("state", "openclaw.sqlite#exec_approvals_config");
  return stateDir === DEFAULT_EXEC_APPROVALS_STATE_DIR
    ? `${stateDir}/${locator}`
    : path.join(stateDir, locator);
}

export function resolveExecApprovalsTranscriptPath(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    ? "$OPENCLAW_STATE_DIR/state/openclaw.sqlite#exec_approvals_config"
    : `${DEFAULT_EXEC_APPROVALS_STATE_DIR}/state/openclaw.sqlite#exec_approvals_config`;
}

export function createFailClosedExecApprovalsFallback(): ExecApprovalsFile {
  return normalizeExecApprovalsInternal({
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

// Only schema field names may enter diagnostics; agent keys are always replaced by ordinals.
const diagnosticFields = new Set([
  "version",
  "socket",
  "path",
  "token",
  "defaults",
  "agents",
  "security",
  "ask",
  "askFallback",
  "autoAllowSkills",
  "allowlist",
  "pattern",
  "id",
  "source",
  "commandText",
  "argPattern",
  "lastUsedAt",
  "lastUsedCommand",
  "lastResolvedPath",
]);

function formatPersistedExecApprovalsIssue(issue: z.core.$ZodIssue, parsed: unknown): string {
  // Only the object arm has field issues. The string arm's root error would
  // misdiagnose object metadata; Zod's union child paths are relative.
  const fieldIssue =
    issue.code === "invalid_union"
      ? issue.errors[1]?.find((child) => child.path.length === 1)
      : undefined;
  const detail = fieldIssue ?? issue;
  const issuePath = fieldIssue ? [...issue.path, ...fieldIssue.path] : issue.path;
  let location = "";
  // The schema has at most five path segments. Fixed field names and numeric
  // indices bound the output even when source keys or values are enormous.
  for (const [index, segment] of issuePath.slice(0, 5).entries()) {
    if (index === 1 && issuePath[0] === "agents") {
      const agents = isRecord(parsed) && isRecord(parsed.agents) ? parsed.agents : {};
      const ordinal = typeof segment === "string" ? Object.keys(agents).indexOf(segment) + 1 : 0;
      if (!ordinal) {
        break;
      }
      location += ` entry #${ordinal}`;
    } else if (
      index === 3 &&
      issuePath[2] === "allowlist" &&
      typeof segment === "number" &&
      Number.isSafeInteger(segment) &&
      segment >= 0
    ) {
      location += `[${segment}]`;
    } else if (typeof segment === "string" && diagnosticFields.has(segment)) {
      location += `${location ? "." : ""}${segment}`;
    } else {
      break;
    }
  }
  let reason = "invalid value";
  switch (detail.code) {
    case "invalid_type":
      switch (detail.expected) {
        case "string":
          reason = "expected a string";
          break;
        case "number":
          reason = "expected a finite number";
          break;
        case "boolean":
          reason = "expected a boolean";
          break;
        case "array":
          reason = "expected an array";
          break;
        case "object":
          reason = "expected an object";
          break;
        default:
          break;
      }
      break;
    case "invalid_value":
      reason = "expected a supported value";
      break;
    case "invalid_union":
      reason = "expected a non-empty string or an object with a non-empty pattern";
      break;
    case "too_small":
      reason = "expected a non-empty string";
      break;
    case "custom":
      if (issuePath.at(-1) === "pattern") {
        reason = "expected a non-empty string";
      }
      break;
    default:
      // Other Zod issue kinds retain a value-free reason, never raw error text.
      break;
  }
  return `${location || "document"}: ${reason}`;
}

/** Validate canonical policy and expose only a bounded, value-free failure diagnostic. */
export function parsePersistedExecApprovals(raw: string): Result<ExecApprovalsFile, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return err("invalid JSON syntax");
  }
  try {
    const result = persistedExecApprovalsSchema.safeParse(parsed);
    if (result.success) {
      return ok(normalizeExecApprovalsInternal(result.data));
    }
    const issue = result.error.issues[0];
    return err(
      issue ? formatPersistedExecApprovalsIssue(issue, parsed) : "invalid approvals structure",
    );
  } catch {
    return err("invalid approvals structure");
  }
}

/** Parse only structurally valid persisted approvals without inventing fallback policy. */
export function tryParsePersistedExecApprovals(raw: string): ExecApprovalsFile | null {
  const result = parsePersistedExecApprovals(raw);
  return result.ok ? result.value : null;
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

export function normalizeExecApprovalsInternal(file: ExecApprovalsFile): ExecApprovalsFile {
  const { path: rawSocketPath, token: rawValue } = file.socket ?? {};
  const socketPath = rawSocketPath?.trim();
  const token = rawValue?.trim();
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

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}
