import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isFileMissingError } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { asRecord } from "../dreaming-shared.js";

export type McporterConfigMode = "generated" | "external";
export type McporterEnvMode = "discovery" | McporterConfigMode;

export type ConfiguredMcporterServer =
  | { mode: "generated"; server: Record<string, unknown> }
  | { mode: "external" };

export type RawMcporterEntry = {
  lifecycle?: unknown;
  logging?: unknown;
  cwd?: unknown;
  path?: unknown;
};

const MCPORTER_REMOTE_AUTH_KEYS = new Set(
  [
    "auth",
    "authProvider",
    "authProviderEnv",
    "bearerToken",
    "bearerTokenEnv",
    "oauth",
    "oauthClientId",
    "oauthClientSecret",
    "oauthClientSecretEnv",
    "refresh",
    "refreshToken",
    "refreshTokenEnv",
    "tokenCacheDir",
  ].map(normalizeMcporterConfigKey),
);

type JsonExtractionResult = { found: true; value: unknown } | { found: false };

function normalizeMcporterConfigKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function isMcporterAuthLikeKey(key: string): boolean {
  const normalized = normalizeMcporterConfigKey(key);
  return (
    MCPORTER_REMOTE_AUTH_KEYS.has(normalized) ||
    normalized.includes("apikey") ||
    normalized.includes("auth") ||
    normalized.includes("bearer") ||
    normalized.includes("credential") ||
    normalized.includes("header") ||
    normalized.includes("jwt") ||
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.includes("secret") ||
    normalized.includes("signature") ||
    normalized.includes("token") ||
    normalized === "key" ||
    normalized === "pwd" ||
    normalized === "sig"
  );
}

function hasMcporterHeaderAuthMaterial(value: unknown): boolean {
  const headers = asRecord(value);
  if (!headers) {
    return true;
  }
  for (const [key, headerValue] of Object.entries(headers)) {
    const normalized = normalizeMcporterConfigKey(key);
    if (
      normalized === "accept" &&
      typeof headerValue === "string" &&
      hasRequiredMcporterAcceptTokens(headerValue)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function hasRequiredMcporterAcceptTokens(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("application/json") && lower.includes("text/event-stream");
}

export function hasMcporterRemoteAuthMaterial(server: Record<string, unknown>): boolean {
  if (hasMcporterRemoteUrlCredentials(server)) {
    return true;
  }
  return Object.entries(server).some(([key, value]) => {
    if (normalizeMcporterConfigKey(key) === "env") {
      return true;
    }
    if (normalizeMcporterConfigKey(key) === "headers") {
      return hasMcporterHeaderAuthMaterial(value);
    }
    return isMcporterAuthLikeKey(key);
  });
}

export function hasMcporterStdioUserOwnedMaterial(server: Record<string, unknown>): boolean {
  return Object.entries(server).some(([key, value]) => {
    const normalizedKey = normalizeMcporterConfigKey(key);
    if (normalizedKey === "env") {
      return true;
    }
    if (normalizedKey === "command") {
      return hasMcporterAuthLikeText(value);
    }
    if (normalizedKey === "args") {
      return hasMcporterAuthLikeArgs(value);
    }
    return isMcporterAuthLikeKey(key);
  });
}

export function isGeneratedMcporterQmdStdioServer(server: Record<string, unknown>): boolean {
  if (!isQmdExecutableCommand(server.command)) {
    return false;
  }
  const args = server.args;
  return Array.isArray(args) && args.length === 1 && args[0] === "mcp";
}

function isQmdExecutableCommand(command: unknown): boolean {
  if (typeof command !== "string" || command.length === 0) {
    return false;
  }
  const normalized = command.replace(/\\/g, "/");
  const commandName = normalized.split("/").findLast(Boolean) ?? normalized;
  return normalizeMcporterConfigKey(commandName) === "qmd";
}

function hasMcporterAuthLikeArgs(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => hasMcporterAuthLikeText(entry));
}

function hasMcporterAuthLikeText(value: unknown): boolean {
  return typeof value === "string" && isMcporterAuthLikeKey(value);
}

function hasMcporterRemoteUrlCredentials(server: Record<string, unknown>): boolean {
  for (const key of ["baseUrl", "base_url", "url", "serverUrl", "server_url"]) {
    const value = server[key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    try {
      const parsed = new URL(value);
      if (parsed.username.length > 0 || parsed.password.length > 0) {
        return true;
      }
      for (const queryKey of parsed.searchParams.keys()) {
        if (isMcporterAuthLikeKey(queryKey)) {
          return true;
        }
      }
    } catch {
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#@]+@/i.test(value)) {
        return true;
      }
    }
  }
  return false;
}

export function parseMcporterResponseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (err) {
    const payload = extractLastJsonValue(trimmed);
    if (payload.found) {
      return payload.value;
    }
    throw err;
  }
}

// Scan stdout for the last syntactically valid top-level JSON value.
// mcporter/daemon log lines can themselves be valid JSON objects; the actual
// response is the final top-level value in the stream, so a preceding log
// line must not shadow it. We walk the text at root depth and parse each
// complete top-level value, keeping the last one that successfully parses.
function extractLastJsonValue(raw: string): JsonExtractionResult {
  let lastResult: JsonExtractionResult = { found: false };
  let i = 0;
  const len = raw.length;
  while (i < len) {
    const ch = raw[i];
    if (ch !== "{" && ch !== "[") {
      i += 1;
      continue;
    }
    const opening = ch;
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = -1;
    for (let index = i; index < len; index += 1) {
      const c = raw[index];
      if (c === undefined) {
        break;
      }
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (c === "\\") {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === opening) {
        depth += 1;
      } else if (c === closing) {
        depth -= 1;
        if (depth === 0) {
          closed = index;
          break;
        }
      }
    }
    if (closed === -1) {
      // Unbalanced; no more complete top-level values to find.
      return lastResult;
    }
    try {
      lastResult = {
        found: true,
        value: JSON.parse(raw.slice(i, closed + 1)) as unknown,
      };
    } catch {
      // Skip this malformed candidate and look for the next top-level value.
    }
    i = closed + 1;
  }
  return lastResult;
}

function expandMcporterHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = os.homedir();
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function resolveMcporterConfigCandidates(env: NodeJS.ProcessEnv, workspaceDir: string): string[] {
  // Match mcporter's config discovery precedence (mcporter source:
  // src/config/path-discovery.ts): explicit override -> project -> XDG/home ->
  // legacy home fallback. Workspace config wins over user-level definitions.
  const candidates: string[] = [];

  const explicitConfig = env.MCPORTER_CONFIG;
  if (explicitConfig && explicitConfig.trim().length > 0) {
    candidates.push(path.resolve(expandMcporterHome(explicitConfig.trim())));
  }

  const projectConfigDir = path.resolve(workspaceDir, "config");
  candidates.push(path.join(projectConfigDir, "mcporter.json"));
  candidates.push(path.join(projectConfigDir, "mcporter.jsonc"));

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  if (xdgConfigHome && xdgConfigHome.trim().length > 0) {
    const resolved = expandMcporterHome(xdgConfigHome.trim());
    if (path.isAbsolute(resolved)) {
      candidates.push(path.join(resolved, "mcporter", "mcporter.json"));
      candidates.push(path.join(resolved, "mcporter", "mcporter.jsonc"));
    }
  }

  candidates.push(path.join(os.homedir(), ".mcporter", "mcporter.json"));
  candidates.push(path.join(os.homedir(), ".mcporter", "mcporter.jsonc"));

  return candidates;
}

export function extractMcporterSourcePath(serialized: Record<string, unknown>): string | undefined {
  const source = serialized.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const sourceRecord = source as Record<string, unknown>;
  if (typeof sourceRecord.path === "string") {
    return sourceRecord.path;
  }
  return undefined;
}

// String-aware JSONC comment and trailing-comma stripper. Walks the source
// respecting string boundaries so URLs containing "//" and similar tokens
// are not mistaken for line comments. Used only for the read-only probe of
// raw mcporter entries; mcporter itself is the source of truth for runtime
// config loading.
function stripJsoncCommentsAndTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === '"') {
      // Copy the entire string literal verbatim, honoring backslash escapes.
      let j = i + 1;
      while (j < len) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? len : newline;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? len : close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Strip trailing commas before closing brackets/braces. The preceding
  // comment pass already removed any "//" inside string values, so the
  // remaining "," characters only appear in structural positions.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

async function readRawMcporterEntryFromFile(
  serverName: string,
  filePath: string,
): Promise<RawMcporterEntry | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  // Try strict JSON first; only fall back to JSONC cleanup for ".jsonc" files
  // that need comment/trailing-comma removal. The cleanup is string-aware so
  // URLs containing "//" inside string values are not mistaken for comments.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    if (!filePath.endsWith(".jsonc")) {
      return null;
    }
    try {
      parsed = JSON.parse(stripJsoncCommentsAndTrailingCommas(text)) as unknown;
    } catch {
      return null;
    }
  }
  const record = asRecord(parsed);
  const servers = record ? asRecord(record.mcpServers) : null;
  const entry = servers ? asRecord(servers[serverName]) : null;
  if (entry) {
    return entry as RawMcporterEntry;
  }
  return null;
}

export async function readRawMcporterEntry(
  serverName: string,
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
  sourcePath?: string,
): Promise<RawMcporterEntry | null> {
  // Prefer the file mcporter actually reported via source.path; it is the
  // authoritative layer for this server. Fall back to enumerating layers in
  // mcporter's documented precedence order.
  if (sourcePath) {
    const resolved = path.resolve(expandMcporterHome(sourcePath.trim()));
    const entry = await readRawMcporterEntryFromFile(serverName, resolved);
    if (entry) {
      return entry;
    }
  }

  for (const candidate of resolveMcporterConfigCandidates(env, workspaceDir)) {
    const entry = await readRawMcporterEntryFromFile(serverName, candidate);
    if (entry) {
      return entry;
    }
  }
  return null;
}

export function hasMcporterStdioLifecycleOrLogging(server: RawMcporterEntry): boolean {
  if (server.lifecycle !== undefined) {
    return true;
  }
  const logging =
    typeof server.logging === "object" && server.logging !== null
      ? (server.logging as Record<string, unknown>)
      : null;
  if (logging) {
    // Detect top-level logging.enabled (mcporter legacy shape) and nested
    // logging.daemon.enabled (mcporter current shape: src/config-schema.ts:39-49).
    if (logging.enabled === true) {
      return true;
    }
    const daemon =
      typeof logging.daemon === "object" && logging.daemon !== null
        ? (logging.daemon as Record<string, unknown>)
        : null;
    if (daemon?.enabled === true) {
      return true;
    }
  }
  // A user-set cwd or path is context-dependent and must not be copied into
  // the per-agent generated config under OpenClaw state, where it would
  // resolve against a different working directory. Check the raw entry so
  // mcporter's normalized default cwd (added to "config get --json" output)
  // does not force every bare qmd server into external mode.
  if (typeof server.cwd === "string" && server.cwd.length > 0) {
    return true;
  }
  if (typeof server.path === "string" && server.path.length > 0) {
    return true;
  }
  return false;
}
