import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  parseQmdQueryJson,
  type QmdQueryResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const log = createSubsystemLogger("memory");

export function asQmdAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error("qmd search aborted");
}

export function parseFailedQmdSearchJson(
  err: unknown,
  command: "query" | "search" | "vsearch",
): QmdQueryResult[] | null {
  if (
    !isQmdCliCommandError(err) ||
    isMissingCollectionSearchError(err) ||
    isUnsupportedQmdOptionError(err) ||
    isSqliteBusyError(err) ||
    !isQmdNativeAbortAfterOutput(err)
  ) {
    return null;
  }
  try {
    const parsed = parseQmdQueryJson(err.stdout, err.stderr);
    log.warn(
      `qmd ${command} exited non-zero after producing valid JSON; using captured search results (${formatQmdSearchExit(err)})`,
    );
    return parsed;
  } catch {
    return null;
  }
}

export function isMissingCollectionSearchError(err: unknown): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  return (
    normalized.includes("collection") &&
    (normalized.includes("not found") ||
      normalized.includes("does not exist") ||
      normalized.includes("missing"))
  );
}

export function isUnsupportedQmdOptionError(err: unknown): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  return (
    normalized.includes("unknown flag") ||
    normalized.includes("unknown option") ||
    normalized.includes("unrecognized option") ||
    normalized.includes("flag provided but not defined") ||
    normalized.includes("unexpected argument")
  );
}

export function isSqliteBusyError(err: unknown): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  return normalized.includes("sqlite_busy") || normalized.includes("database is locked");
}

function formatQmdSearchExit(err: { code: number | null; signal: NodeJS.Signals | null }): string {
  return err.code === null ? `signal ${err.signal ?? "unknown"}` : `code ${err.code}`;
}

function isQmdCliCommandError(err: unknown): err is {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
} {
  if (!(err instanceof Error)) {
    return false;
  }
  const candidate = err as {
    code?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return (
    (typeof candidate.code === "number" || candidate.code === null) &&
    (typeof candidate.signal === "string" || candidate.signal === null) &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string"
  );
}

function isQmdNativeAbortAfterOutput(err: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}): boolean {
  const aborted = err.code === 134 || err.signal === "SIGABRT";
  if (!aborted) {
    return false;
  }
  const stderr = normalizeLowercaseStringOrEmpty(err.stderr);
  return (
    stderr.includes("ggml-metal") ||
    stderr.includes("node-llama-cpp") ||
    stderr.includes("llama.cpp") ||
    stderr.includes("abort trap") ||
    stderr.includes("assertion failed")
  );
}
