/**
 * Shared helpers for bash exec/process tools.
 * Owns Docker exec argument construction, output slicing, environment
 * coercion, and compact session labels.
 */
import { parseStrictInteger } from "@openclaw/normalization-core/number-coercion";
import { sliceUtf16Safe } from "../utils.js";
import type {
  SandboxBackendExecSpec,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirValidator,
} from "./sandbox/backend-handle.types.js";

const CHUNK_LIMIT = 8 * 1024;

/** Sandbox metadata needed to map host workspaces into container exec calls. */
export type BashSandboxConfig = {
  containerName: string;
  workspaceDir: string;
  containerWorkdir: string;
  workdirValidation?: SandboxBackendWorkdirValidation;
  validateWorkdir?: SandboxBackendWorkdirValidator;
  discardPreparedWorkdir?: (workdir: string) => void;
  workdirRoots?: readonly string[];
  env?: Record<string, string>;
  buildExecSpec?: (params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }) => Promise<SandboxBackendExecSpec>;
  finalizeExec?: (params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
    token?: unknown;
  }) => Promise<void>;
};

/** Builds the environment passed into sandboxed exec calls. */
export function buildSandboxEnv(params: {
  defaultPath: string;
  paramsEnv?: Record<string, string>;
  sandboxEnv?: Record<string, string>;
  containerWorkdir: string;
}) {
  const env: Record<string, string> = {
    PATH: params.defaultPath,
    HOME: params.containerWorkdir,
  };
  for (const [key, value] of Object.entries(params.sandboxEnv ?? {})) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(params.paramsEnv ?? {})) {
    env[key] = value;
  }
  return env;
}

/** Coerces process/env-like records to string-only environment variables. */
export function coerceEnv(env?: NodeJS.ProcessEnv | Record<string, string>) {
  const record: Record<string, string> = {};
  if (!env) {
    return record;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}

/** Builds `docker exec` arguments while preserving container PATH behavior. */
export function buildDockerExecArgs(params: {
  containerName: string;
  command: string;
  workdir?: string;
  env: Record<string, string>;
  tty: boolean;
}) {
  const args = ["exec", "-i"];
  if (params.tty) {
    args.push("-t");
  }
  if (params.workdir) {
    args.push("-w", params.workdir);
  }
  for (const [key, value] of Object.entries(params.env)) {
    // Skip PATH — passing a host PATH (e.g. Windows paths) via -e poisons
    // Docker's executable lookup, causing "sh: not found" on Windows hosts.
    // PATH is handled separately via OPENCLAW_PREPEND_PATH below.
    if (key === "PATH") {
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }
  const hasCustomPath = typeof params.env.PATH === "string" && params.env.PATH.length > 0;
  if (hasCustomPath) {
    // Avoid interpolating PATH into the shell command; pass it via env instead.
    args.push("-e", `OPENCLAW_PREPEND_PATH=${params.env.PATH}`);
  }
  // Login shell (-l) sources /etc/profile which resets PATH to a minimal set,
  // overriding both Docker ENV and -e PATH=... environment variables.
  // Prepend custom PATH after profile sourcing to ensure custom tools are accessible
  // while preserving system paths that /etc/profile may have added.
  const pathExport = hasCustomPath
    ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
    : "";
  // Use absolute path for sh to avoid dependency on PATH resolution during exec.
  args.push(params.containerName, "/bin/sh", "-lc", `${pathExport}${params.command}`);
  return args;
}

/**
 * Clamp a number within min/max bounds, using defaultValue if undefined or NaN.
 */
export function clampWithDefault(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
) {
  if (value === undefined || Number.isNaN(value)) {
    return defaultValue;
  }
  return Math.min(Math.max(value, min), max);
}

/** Reads a strict integer from the preferred env var or one legacy alias. */
export function readEnvInt(key: string, legacyKey?: string) {
  const raw = process.env[key] || (legacyKey ? process.env[legacyKey] : undefined);
  return parseStrictInteger(raw);
}

/** Splits output into bounded chunks without splitting UTF-16 surrogate pairs. */
export function chunkString(input: string, limit = CHUNK_LIMIT) {
  const chunks: string[] = [];
  const chunkLimit = Number.isNaN(limit) ? CHUNK_LIMIT : Math.max(1, Math.floor(limit));
  let i = 0;
  while (i < input.length) {
    const firstCodePointWidth = (input.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    // A code point is indivisible; a tiny limit may require one chunk to exceed it.
    const chunk = sliceUtf16Safe(input, i, i + Math.max(chunkLimit, firstCodePointWidth));
    chunks.push(chunk);
    i += chunk.length;
  }
  return chunks;
}

/** Truncates long labels in the middle while preserving UTF-16 boundaries. */
export function truncateMiddle(str: string, max: number) {
  if (str.length <= max) {
    return str;
  }
  const half = Math.floor((max - 3) / 2);
  return `${sliceUtf16Safe(str, 0, half)}...${sliceUtf16Safe(str, -half)}`;
}

/** Returns a line-based log slice plus original line/character counts. */
export function sliceLogLines(
  text: string,
  offset?: number,
  limit?: number,
): { slice: string; totalLines: number; totalChars: number } {
  if (!text) {
    return { slice: "", totalLines: 0, totalChars: 0 };
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const totalChars = text.length;
  let start =
    typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  if (limit !== undefined && offset === undefined) {
    const tailCount = Math.max(0, Math.floor(limit));
    start = Math.max(totalLines - tailCount, 0);
  }
  const end =
    typeof limit === "number" && Number.isFinite(limit)
      ? start + Math.max(0, Math.floor(limit))
      : undefined;
  return { slice: lines.slice(start, end).join("\n"), totalLines, totalChars };
}

/** Derives a compact human label from a shell command. */
export function deriveSessionName(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return undefined;
  }
  const verb = tokens[0];
  if (!verb) {
    return "";
  }
  let target = tokens.slice(1).find((t) => !t.startsWith("-"));
  if (!target) {
    target = tokens[1];
  }
  if (!target) {
    return verb;
  }
  const cleaned = truncateMiddle(stripQuotes(target), 48);
  return `${stripQuotes(verb)} ${cleaned}`;
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
  return matches.map((token) => stripQuotes(token)).filter(Boolean);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Right-pads a string for aligned plain-text process output. */
export function pad(str: string, width: number) {
  if (str.length >= width) {
    return str;
  }
  return str + " ".repeat(width - str.length);
}
