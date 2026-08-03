import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  BootstrapBudgetAnalysis,
  BootstrapPromptWarning,
  BootstrapPromptWarningMode,
  BootstrapTruncationCause,
} from "./bootstrap-budget.types.js";
import { USER_BOOTSTRAP_MAX_CHARS } from "./embedded-agent-helpers/bootstrap.js";

const DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES = 3;
const DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX = 32;

function formatWarningCause(cause: BootstrapTruncationCause): string {
  return cause === "per-file-limit" ? "max/file" : "max/total";
}

export function normalizeBootstrapWarningSignatures(signatures?: string[]): string[] {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const signature of signatures) {
    const value = normalizeOptionalString(signature) ?? "";
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function appendSeenSignature(signatures: string[], signature: string): string[] {
  if (!signature.trim() || signatures.includes(signature)) {
    return signatures;
  }
  const next = [...signatures, signature];
  return next.length <= DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX
    ? next
    : next.slice(-DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX);
}

function buildBootstrapTruncationSignature(analysis: BootstrapBudgetAnalysis): string | undefined {
  if (!analysis.hasTruncation) {
    return undefined;
  }
  const files = analysis.truncatedFiles
    .map((file) => ({
      path: file.path || file.name,
      rawChars: file.rawChars,
      injectedChars: file.injectedChars,
      causes: [...file.causes].toSorted(),
    }))
    .toSorted((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) {
        return pathCmp;
      }
      if (a.rawChars !== b.rawChars) {
        return a.rawChars - b.rawChars;
      }
      if (a.injectedChars !== b.injectedChars) {
        return a.injectedChars - b.injectedChars;
      }
      return a.causes.join("+").localeCompare(b.causes.join("+"));
    });
  return JSON.stringify({
    bootstrapMaxChars: analysis.totals.bootstrapMaxChars,
    bootstrapTotalMaxChars: analysis.totals.bootstrapTotalMaxChars,
    files,
  });
}

function formatBootstrapTruncationWarningLines(params: {
  analysis: BootstrapBudgetAnalysis;
  maxFiles?: number;
}): string[] {
  if (!params.analysis.hasTruncation) {
    return [];
  }
  const maxFiles =
    typeof params.maxFiles === "number" && Number.isFinite(params.maxFiles) && params.maxFiles > 0
      ? Math.floor(params.maxFiles)
      : DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES;
  const lines: string[] = [];
  const duplicateNameCounts = params.analysis.truncatedFiles.reduce((acc, file) => {
    acc.set(file.name, (acc.get(file.name) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());
  const topFiles = params.analysis.truncatedFiles.slice(0, maxFiles);
  for (const file of topFiles) {
    const pct =
      file.rawChars > 0
        ? Math.round(((file.rawChars - file.injectedChars) / file.rawChars) * 100)
        : 0;
    const causeText =
      file.causes.length > 0
        ? file.causes.map((cause) => formatWarningCause(cause)).join(", ")
        : "";
    const nameLabel =
      (duplicateNameCounts.get(file.name) ?? 0) > 1 && file.path.trim().length > 0
        ? `${file.name} (${file.path})`
        : file.name;
    lines.push(
      `${nameLabel}: ${file.rawChars} raw -> ${file.injectedChars} injected (~${Math.max(0, pct)}% removed${causeText ? `; ${causeText}` : ""}).`,
    );
  }
  if (params.analysis.truncatedFiles.length > topFiles.length) {
    lines.push(
      `+${params.analysis.truncatedFiles.length - topFiles.length} more truncated file(s).`,
    );
  }
  if (params.analysis.truncatedFiles.some((file) => file.name?.toLowerCase() === "agents.md")) {
    lines.push("AGENTS.md was truncated; read the full AGENTS.md before relying on scoped policy.");
  }
  const fixedUserCapApplied = params.analysis.truncatedFiles.some(
    (file) =>
      file.name?.toLowerCase() === "user.md" &&
      file.effectiveFileLimit === USER_BOOTSTRAP_MAX_CHARS &&
      file.causes.includes("per-file-limit"),
  );
  if (fixedUserCapApplied) {
    lines.push(
      `USER.md has a fixed ${USER_BOOTSTRAP_MAX_CHARS}-character bootstrap cap; keep it compact.`,
    );
  }
  const configurableLimitApplied = params.analysis.truncatedFiles.some(
    (file) =>
      file.name?.toLowerCase() !== "user.md" ||
      file.effectiveFileLimit < USER_BOOTSTRAP_MAX_CHARS ||
      file.causes.includes("total-limit"),
  );
  if (configurableLimitApplied) {
    lines.push(
      "If unintentional, raise agents.defaults.bootstrapMaxChars and/or agents.defaults.bootstrapTotalMaxChars.",
    );
  }
  return lines;
}

/** Decides whether to show a prompt warning and returns the updated dedupe state. */
export function buildBootstrapPromptWarning(params: {
  analysis: BootstrapBudgetAnalysis;
  mode: BootstrapPromptWarningMode;
  previousSignature?: string;
  seenSignatures?: string[];
  maxFiles?: number;
}): BootstrapPromptWarning {
  const signature = buildBootstrapTruncationSignature(params.analysis);
  let seenSignatures = normalizeBootstrapWarningSignatures(params.seenSignatures);
  if (params.previousSignature && !seenSignatures.includes(params.previousSignature)) {
    seenSignatures = appendSeenSignature(seenSignatures, params.previousSignature);
  }
  const hasSeenSignature = Boolean(signature && seenSignatures.includes(signature));
  const warningShown =
    params.mode !== "off" && Boolean(signature) && (params.mode === "always" || !hasSeenSignature);
  const warningSignaturesSeen =
    signature && params.mode !== "off"
      ? appendSeenSignature(seenSignatures, signature)
      : seenSignatures;
  return {
    signature,
    warningShown,
    lines: warningShown
      ? formatBootstrapTruncationWarningLines({
          analysis: params.analysis,
          maxFiles: params.maxFiles,
        })
      : [],
    warningSignaturesSeen,
  };
}
