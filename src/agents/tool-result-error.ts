import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { FileTarget } from "./tool-mutation.js";

const TOOL_TIMEOUT_ERROR_CODES = new Set([
  "ERR_TIMEOUT",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function readToolErrorField(error: object, key: string): unknown {
  try {
    return key in error ? (error as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

function readToolErrorKeys(error: object): string[] {
  try {
    return Object.keys(error);
  } catch {
    return [];
  }
}

function isCanonicalFileNotFoundLine(value: string): boolean {
  const normalized = value.trim();
  return (
    /(?:^|:\s*)ENOENT(?=:\s|$)/u.test(normalized) ||
    /\(\s*ENOENT\s*\)(?=:\s|$)/u.test(normalized) ||
    /(?:^|:\s*|\[errno\s+\d+\]\s*)(?:no such file or directory|file not found)(?=$|:\s|,\s|\.\s*$|\s+\(|\s+@|\s+-\s)/iu.test(
      normalized,
    ) ||
    /\(\s*(?:no such file or directory|file not found)\s*\)$/iu.test(normalized)
  );
}

function hasSpawnFailureMarker(value: string): boolean {
  return value.split(/\r?\n/u).some((rawLine) => {
    const line = rawLine.trim();
    if (/^at\s/iu.test(line)) {
      return false;
    }
    return (
      /(?:^|[^/\\.'"\w])spawn(?:Sync)?\b(?![\\/])/iu.test(line) ||
      /\b(?:node:)?child_process\.spawn(?:Sync)?\b/iu.test(line)
    );
  });
}

function stripPathQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");
}

function normalizeComparablePath(value: string, cwd?: string): string {
  const unquoted = stripPathQuotes(value);
  if (!unquoted) {
    return "";
  }
  const windowsPath = isWindowsAbsolutePath(unquoted) || (cwd ? isWindowsAbsolutePath(cwd) : false);
  const implementation = windowsPath ? path.win32 : path;
  const resolved =
    cwd && !implementation.isAbsolute(unquoted)
      ? implementation.resolve(cwd, unquoted)
      : implementation.normalize(unquoted);
  return resolved.replace(/\\/g, "/").replace(/\/+$/u, "");
}

function matchesFileTargetPath(value: string, target: FileTarget, cwd?: string): boolean {
  const targetPath =
    typeof target.path === "string" ? normalizeComparablePath(target.path, cwd) : "";
  const candidatePath = normalizeComparablePath(value, cwd);
  if (!targetPath || !candidatePath) {
    return false;
  }
  if (
    process.platform === "win32" ||
    isWindowsAbsolutePath(candidatePath) ||
    isWindowsAbsolutePath(targetPath)
  ) {
    return candidatePath.toLowerCase() === targetPath.toLowerCase();
  }
  return candidatePath === targetPath;
}

function extractExplicitPathLiterals(line: string): string[] {
  const candidates = new Set<string>();
  for (const match of line.matchAll(/(['"])([^'"]+)\1/gu)) {
    const candidate = match[2];
    if (candidate) {
      candidates.add(candidate);
    }
  }
  for (const match of line.matchAll(/(?:^|\s|\(|=|\[)((?:\/|[a-z]:[\\/]|\\\\)[^\s'")\],;:]+)/giu)) {
    const candidate = match[1];
    if (candidate) {
      candidates.add(candidate);
    }
  }
  if (
    /\b(?:access|chmod|chown|copy|create|delete|link|load|lstat|mkdir|mkdtemp|open|read|readdir|readlink|realpath|remove|rename|rm|rmdir|save|scandir|stat|symlink|truncate|unlink|write)\b/iu.test(
      line,
    )
  ) {
    for (const match of line.matchAll(
      /\b(?:access|chmod|chown|copy|create|delete|link|load|lstat|mkdir|mkdtemp|open|read|readdir|readlink|realpath|remove|rename|rm|rmdir|save|scandir|stat|symlink|truncate|unlink|write)\s+([^\s:'"(),]+)/giu,
    )) {
      const candidate = match[1];
      if (candidate) {
        candidates.add(candidate);
      }
    }
    for (const match of line.matchAll(/\bto\s+([^\s:'"(),]+)/giu)) {
      const candidate = match[1];
      if (candidate) {
        candidates.add(candidate);
      }
    }
  }
  return [...candidates];
}

function findTargetPathInDiagnostic(
  line: string,
  target: FileTarget,
  cwd?: string,
): string | undefined {
  const targetPath = typeof target.path === "string" ? target.path : "";
  if (!targetPath.trim()) {
    return undefined;
  }
  const normalizedTargetPath = normalizeComparablePath(targetPath, cwd);
  const candidates = new Set([
    targetPath,
    normalizedTargetPath,
    normalizedTargetPath.replace(/\//g, "\\"),
  ]);
  return [...candidates]
    .filter(Boolean)
    .toSorted((left, right) => right.length - left.length)
    .find((candidate) => {
      const escaped = escapeRegExp(candidate);
      const suffix = `(?=$|[\\s'"),:;])`;
      return [
        new RegExp(
          `\\b(?:access|lstat|open|readlink|realpath|scandir|stat|unlink)\\s+['"]?${escaped}${suffix}`,
          "iu",
        ),
        new RegExp(
          `(?:no such file or directory|file not found)\\s*:\\s*['"]?${escaped}${suffix}`,
          "iu",
        ),
        new RegExp(`\\(ENOENT\\):\\s*${escaped}${suffix}`, "u"),
        new RegExp(`-\\s*${escaped}${suffix}`, "u"),
        new RegExp(`:\\s*${escaped}\\s+\\((?:no such file or directory|file not found)\\)`, "iu"),
      ].some((pattern) => pattern.test(line));
    });
}

function extractNotFoundDiagnosticPaths(
  rawLine: string,
  target: FileTarget,
  cwd?: string,
): string[] {
  const line = rawLine.trim().replace(/^(?:error:\s*)+/giu, "");
  const candidates = new Set<string>();
  const exactTargetPath = findTargetPathInDiagnostic(line, target, cwd);
  if (exactTargetPath) {
    candidates.add(exactTargetPath);
    const secondaryEvidenceLine = line.replace(exactTargetPath, "");
    for (const candidate of extractExplicitPathLiterals(secondaryEvidenceLine)) {
      candidates.add(candidate);
    }
    return [...candidates];
  }
  let primaryPath: string | undefined;
  for (const pattern of [
    /(?:no such file or directory|file not found),?\s*(?:access|lstat|open|readlink|realpath|scandir|stat|unlink)\s+['"]([^'"]+)['"]/iu,
    /(?:no such file or directory|file not found),?\s*(?:access|lstat|open|readlink|realpath|scandir|stat|unlink)\s+(.+?)\s*$/iu,
    /\b(?:access|lstat|open|readlink|realpath|scandir|stat|unlink)\s+(.+?)\s*:\s*(?:no such file or directory|file not found)(?:$|[,(])/iu,
    /^[^:]+:\s*(.+?)\s*:\s*(?:no such file or directory|file not found)(?:$|[,(])/iu,
    /(?:no such file or directory|file not found)\s*:\s*['"]?(.+?)['"]?$/iu,
    /(?:no such file or directory|file not found)\s+@\s+\S+\s+-\s+(.+)$/iu,
    /:\s*(.+?)\s+\((?:no such file or directory|file not found)\)\s*$/iu,
    /\(ENOENT\):\s*(.+)$/u,
    /(?:^|:\s*)ENOENT:\s*(?!no such file or directory\b)(.+)$/iu,
  ]) {
    const match = line.match(pattern);
    if (match?.[1]) {
      // Diagnostic grammars overlap (for example, Node's ENOENT prefix also
      // resembles a command prefix). The first specific match owns the path.
      candidates.add(match[1]);
      primaryPath = match[1];
      break;
    }
  }
  const secondaryEvidenceLine = primaryPath ? line.replace(primaryPath, "") : line;
  for (const candidate of extractExplicitPathLiterals(secondaryEvidenceLine)) {
    candidates.add(candidate);
  }
  return [...candidates];
}

function hasDirectStructuredNotFoundIdentity(value: object): boolean {
  for (const key of ["code", "status"] as const) {
    const normalized = normalizeOptionalLowercaseString(readToolErrorField(value, key));
    if (normalized === "enoent" || normalized === "not_found" || normalized === "not-found") {
      return true;
    }
  }
  return false;
}

type FileNotFoundEvidence = {
  ambiguousDiagnostic: boolean;
  conflictingPath: boolean;
  explicitConflictingPath: boolean;
  spawnFailure: boolean;
  structuredTargetedPath: boolean;
  targetedPath: boolean;
  truncatedGraph: boolean;
};

function collectDiagnosticNotFoundEvidence(
  value: string,
  target: FileTarget,
  cwd: string | undefined,
  evidence: FileNotFoundEvidence,
): void {
  for (const line of value.split(/\r?\n/u)) {
    const normalizedLine = line.trim();
    if (!normalizedLine || /^at\s/iu.test(normalizedLine)) {
      continue;
    }
    const explicitCandidates = extractExplicitPathLiterals(line);
    let spawnComparableLine = line;
    for (const candidate of [...explicitCandidates].toSorted(
      (left, right) => right.length - left.length,
    )) {
      spawnComparableLine = spawnComparableLine.split(candidate).join("");
    }
    if (hasSpawnFailureMarker(spawnComparableLine)) {
      evidence.spawnFailure = true;
    }
    const canonicalNotFound = isCanonicalFileNotFoundLine(line);
    if (!canonicalNotFound) {
      for (const candidate of explicitCandidates) {
        if (!matchesFileTargetPath(candidate, target, cwd)) {
          evidence.explicitConflictingPath = true;
        }
      }
      evidence.ambiguousDiagnostic = true;
      continue;
    }
    const candidates = extractNotFoundDiagnosticPaths(line, target, cwd);
    for (const candidate of candidates) {
      if (matchesFileTargetPath(candidate, target, cwd)) {
        evidence.targetedPath = true;
      } else {
        evidence.conflictingPath = true;
      }
    }
  }
}

function collectFileNotFoundEvidence(
  value: unknown,
  target: FileTarget,
  cwd: string | undefined,
  seen: Set<unknown>,
  evidence: FileNotFoundEvidence,
): void {
  if (typeof value === "string") {
    collectDiagnosticNotFoundEvidence(value, target, cwd, evidence);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  if (seen.size >= 12) {
    evidence.truncatedGraph = true;
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFileNotFoundEvidence(entry, target, cwd, seen, evidence);
    }
    return;
  }
  const structuredIdentity = hasDirectStructuredNotFoundIdentity(value);
  const syscall = readToolErrorField(value, "syscall");
  if (typeof syscall === "string" && hasSpawnFailureMarker(syscall)) {
    evidence.spawnFailure = true;
  }
  const pathKeys = new Set([
    "dest",
    "destination",
    "file",
    "filename",
    "path",
    "source",
    "src",
    "target",
  ]);
  let hasTargetedPathField = false;
  for (const key of pathKeys) {
    const field = readToolErrorField(value, key);
    if (typeof field !== "string" || !field.trim()) {
      continue;
    }
    if (matchesFileTargetPath(field, target, cwd)) {
      hasTargetedPathField = true;
    } else {
      evidence.explicitConflictingPath = true;
    }
  }
  // Structured identity and path fields are only authoritative when they
  // describe the same error object; wrapped sibling data may concern another failure.
  evidence.structuredTargetedPath ||= structuredIdentity && hasTargetedPathField;
  const keys = new Set([
    ...readToolErrorKeys(value),
    "cause",
    "content",
    "details",
    "error",
    "errors",
    "message",
    "reason",
    "stderr",
    "text",
  ]);
  for (const key of keys) {
    if (
      pathKeys.has(key) ||
      key === "code" ||
      key === "name" ||
      key === "stack" ||
      key === "status" ||
      key === "syscall" ||
      key === "type"
    ) {
      continue;
    }
    collectFileNotFoundEvidence(readToolErrorField(value, key), target, cwd, seen, evidence);
  }
}

export function isFileTargetNotFoundToolFailure(
  value: unknown,
  target: FileTarget,
  cwd?: string,
): boolean {
  const evidence: FileNotFoundEvidence = {
    ambiguousDiagnostic: false,
    conflictingPath: false,
    explicitConflictingPath: false,
    spawnFailure: false,
    structuredTargetedPath: false,
    targetedPath: false,
    truncatedGraph: false,
  };
  collectFileNotFoundEvidence(value, target, cwd, new Set(), evidence);
  if (
    (evidence.ambiguousDiagnostic && !evidence.structuredTargetedPath) ||
    evidence.spawnFailure ||
    evidence.conflictingPath ||
    evidence.explicitConflictingPath ||
    evidence.truncatedGraph
  ) {
    return false;
  }
  return evidence.targetedPath || evidence.structuredTargetedPath;
}

function hasStructuredToolTimeoutIdentity(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const name = readToolErrorField(current, "name");
    if (name === "TimeoutError") {
      return true;
    }
    const code = readToolErrorField(current, "code");
    if (typeof code === "string" && TOOL_TIMEOUT_ERROR_CODES.has(code.trim().toUpperCase())) {
      return true;
    }
    for (const key of ["reason", "status"] as const) {
      const value = readToolErrorField(current, key);
      const normalized = normalizeOptionalLowercaseString(value);
      if (normalized === "timeout" || normalized === "timed_out") {
        return true;
      }
      if (value && typeof value === "object") {
        pending.push(value);
      }
    }
    const cause = readToolErrorField(current, "cause");
    if (cause && typeof cause === "object") {
      pending.push(cause);
    }
  }
  return false;
}

export function readToolResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  try {
    const details = readToolErrorField(result, "details");
    return details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readToolResultStatus(result: unknown): string | undefined {
  const details = readToolResultDetails(result);
  return normalizeOptionalLowercaseString(
    details ? readToolErrorField(details, "status") : undefined,
  );
}

export function isToolResultError(result: unknown): boolean {
  const details = readToolResultDetails(result);
  const normalized = readToolResultStatus(result);
  const ok = details ? readToolErrorField(details, "ok") : undefined;
  const success = details ? readToolErrorField(details, "success") : undefined;
  const explicitlySuccessful = ok === true || success === true;
  if (ok === false || success === false) {
    return true;
  }
  const hasFailureStatus =
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "timeout" ||
    normalized === "timed_out" ||
    normalized === "blocked" ||
    normalized === "denied" ||
    normalized === "forbidden" ||
    normalized === "unavailable" ||
    normalized === "approval-unavailable" ||
    normalized === "disabled" ||
    normalized === "aborted" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "killed" ||
    normalized === "invalid";
  if (hasFailureStatus && !explicitlySuccessful) {
    return true;
  }
  const timedOut = details ? readToolErrorField(details, "timedOut") : undefined;
  const error = details ? readToolErrorField(details, "error") : undefined;
  if (timedOut === true || Boolean(error)) {
    return true;
  }
  if (normalized === "completed") {
    return false;
  }
  const exitCode = details ? readToolErrorField(details, "exitCode") : undefined;
  return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
}

export type ToolResultFailureKind = "blocked" | "cancelled" | "failed" | "timed_out";

/** Classify a thrown tool error without inferring cancellation from message text. */
export function resolveToolExecutionErrorKind(error: unknown): "failed" | "timed_out" {
  try {
    return hasStructuredToolTimeoutIdentity(error) ? "timed_out" : "failed";
  } catch {
    return "failed";
  }
}

/** Format a redacted tool error without allowing hostile getters to escape observability. */
export function formatToolExecutionErrorMessage(error: unknown, fallback: string): string {
  try {
    return formatErrorMessage(error) || fallback;
  } catch {
    return fallback;
  }
}

/** Classify a resolved structured tool result through the shared terminal contract. */
export function resolveToolResultFailureKind(result: unknown): ToolResultFailureKind | undefined {
  if (!isToolResultError(result)) {
    return undefined;
  }
  const status = readToolResultStatus(result);
  if (
    status === "blocked" ||
    status === "denied" ||
    status === "forbidden" ||
    status === "disabled" ||
    status === "approval-unavailable"
  ) {
    return "blocked";
  }
  const details = readToolResultDetails(result);
  const timedOut = details ? readToolErrorField(details, "timedOut") : undefined;
  if (timedOut === true || status === "timeout" || status === "timed_out") {
    return "timed_out";
  }
  if (
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "killed"
  ) {
    return "cancelled";
  }
  return "failed";
}
