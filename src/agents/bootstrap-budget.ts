/**
 * Analyzes injected workspace bootstrap files and builds warnings when context
 * was truncated before an agent sees it.
 */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildBootstrapPromptWarning,
  normalizeBootstrapWarningSignatures,
} from "./bootstrap-budget-warning.js";
import type {
  BootstrapBudgetAnalysis,
  BootstrapInjectionStat,
  BootstrapPromptWarning,
  BootstrapPromptWarningMode,
  BootstrapTruncationCause,
} from "./bootstrap-budget.types.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
  USER_BOOTSTRAP_MAX_CHARS,
} from "./embedded-agent-helpers/bootstrap.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

const DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = 0.85;

type BootstrapTruncationReportMeta = {
  warningMode: BootstrapPromptWarningMode;
  warningShown: boolean;
  promptWarningSignature?: string;
  warningSignaturesSeen?: string[];
  truncatedFiles: number;
  nearLimitFiles: number;
  totalNearLimit: boolean;
};

function normalizePositiveLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.floor(value);
}

function effectiveBootstrapFileLimit(name: string, bootstrapMaxChars: number): number {
  return name.toLowerCase() === "user.md"
    ? Math.min(bootstrapMaxChars, USER_BOOTSTRAP_MAX_CHARS)
    : bootstrapMaxChars;
}

/** Restores prompt-warning dedupe state from a previous bootstrap report. */
export function resolveBootstrapWarningSignaturesSeen(report?: {
  bootstrapTruncation?: {
    warningMode?: BootstrapPromptWarningMode;
    warningSignaturesSeen?: string[];
    promptWarningSignature?: string;
  };
}): string[] {
  const truncation = report?.bootstrapTruncation;
  const seenFromReport = normalizeBootstrapWarningSignatures(truncation?.warningSignaturesSeen);
  if (seenFromReport.length > 0) {
    return seenFromReport;
  }
  // In off mode, signature metadata should not seed once-mode dedupe state.
  if (truncation?.warningMode === "off") {
    return [];
  }
  const single =
    typeof truncation?.promptWarningSignature === "string"
      ? (normalizeOptionalString(truncation.promptWarningSignature) ?? "")
      : "";
  return single ? [single] : [];
}

/** Compares raw bootstrap files with the injected context files the agent received. */
export function buildBootstrapInjectionStats(params: {
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
}): BootstrapInjectionStat[] {
  const injectedByPath = new Map<string, string>();
  const injectedByBaseName = new Map<string, string>();
  for (const file of params.injectedFiles) {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    if (!pathValue) {
      continue;
    }
    if (!injectedByPath.has(pathValue)) {
      injectedByPath.set(pathValue, file.content);
    }
    const normalizedPath = pathValue.replace(/\\/g, "/");
    const baseName = path.posix.basename(normalizedPath);
    if (!injectedByBaseName.has(baseName)) {
      injectedByBaseName.set(baseName, file.content);
    }
  }
  return params.bootstrapFiles.map((file) => {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    const normalizedPath = pathValue.replace(/\\/g, "/");
    // Bootstrap hooks are extension-facing and may provide path/content only.
    // Derive the display name before budget classification so those entries
    // keep working and cannot crash the turn when filename-specific caps run.
    const name =
      normalizeOptionalString(file.name) ??
      (normalizedPath ? path.posix.basename(normalizedPath) : "bootstrap");
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const injected =
      (pathValue ? injectedByPath.get(pathValue) : undefined) ??
      injectedByPath.get(name) ??
      injectedByBaseName.get(name);
    const injectedChars = injected ? injected.length : 0;
    const truncated = !file.missing && injectedChars < rawChars;
    return {
      name,
      path: pathValue || name,
      missing: file.missing,
      rawChars,
      injectedChars,
      truncated,
    };
  });
}

/** Classifies bootstrap truncation and near-limit pressure for prompt/report output. */
export function analyzeBootstrapBudget(params: {
  files: BootstrapInjectionStat[];
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars: number;
  nearLimitRatio?: number;
}): BootstrapBudgetAnalysis {
  const bootstrapMaxChars = normalizePositiveLimit(params.bootstrapMaxChars);
  const bootstrapTotalMaxChars = normalizePositiveLimit(params.bootstrapTotalMaxChars);
  const nearLimitRatio =
    typeof params.nearLimitRatio === "number" &&
    Number.isFinite(params.nearLimitRatio) &&
    params.nearLimitRatio > 0 &&
    params.nearLimitRatio < 1
      ? params.nearLimitRatio
      : DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO;
  const nonMissing = params.files.filter((file) => !file.missing);
  const rawChars = nonMissing.reduce((sum, file) => sum + file.rawChars, 0);
  const injectedChars = nonMissing.reduce((sum, file) => sum + file.injectedChars, 0);
  const totalNearLimit = injectedChars >= Math.ceil(bootstrapTotalMaxChars * nearLimitRatio);
  let remainingTotalChars = bootstrapTotalMaxChars;
  const files = params.files.map((file) => {
    const effectiveFileLimit = effectiveBootstrapFileLimit(file.name, bootstrapMaxChars);
    const availableTotalChars = remainingTotalChars;
    remainingTotalChars = Math.max(0, remainingTotalChars - file.injectedChars);
    if (file.missing) {
      return { ...file, effectiveFileLimit, nearLimit: false, causes: [] };
    }
    const perFileOverLimit = file.rawChars > effectiveFileLimit;
    const nearLimit = file.rawChars >= Math.ceil(effectiveFileLimit * nearLimitRatio);
    const causes: BootstrapTruncationCause[] = [];
    if (file.truncated) {
      if (perFileOverLimit) {
        causes.push("per-file-limit");
      }
      if (availableTotalChars < effectiveFileLimit && file.rawChars > availableTotalChars) {
        causes.push("total-limit");
      }
    }
    return { ...file, effectiveFileLimit, nearLimit, causes };
  });

  const truncatedFiles = files.filter((file) => file.truncated);
  const nearLimitFiles = files.filter((file) => file.nearLimit);

  return {
    files,
    truncatedFiles,
    nearLimitFiles,
    totalNearLimit,
    hasTruncation: truncatedFiles.length > 0,
    totals: {
      rawChars,
      injectedChars,
      truncatedChars: Math.max(0, rawChars - injectedChars),
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      nearLimitRatio,
    },
  };
}

/** Builds the canonical bootstrap budget diagnosis after caller-owned routing. */
export function buildBootstrapBudgetState(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  previousSignature?: string;
  seenSignatures?: string[];
}) {
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config, params.agentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, params.agentId);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles: params.bootstrapFiles,
      injectedFiles: params.injectedFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode: BootstrapPromptWarningMode = "always";
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.seenSignatures,
    previousSignature: params.previousSignature,
  });
  return {
    bootstrapAnalysis,
    bootstrapMaxChars,
    bootstrapPromptWarning,
    bootstrapPromptWarningMode,
    bootstrapTotalMaxChars,
  };
}

/** Builds the compact truncation notice mirrored into run metadata. */
export function buildBootstrapPromptWarningNotice(warningLines?: string[]): string | undefined {
  const hasWarning = (warningLines ?? []).some((line) => line.trim().length > 0);
  if (!hasWarning) {
    return undefined;
  }
  return [
    "[Bootstrap truncation warning]",
    "Some workspace bootstrap files were truncated before Project Context injection.",
    "Treat Project Context as partial and read the relevant files directly if details seem missing.",
  ].join("\n");
}

/** Serializes truncation warning state for run reports and future dedupe. */
export function buildBootstrapTruncationReportMeta(params: {
  analysis: BootstrapBudgetAnalysis;
  warningMode: BootstrapPromptWarningMode;
  warning: BootstrapPromptWarning;
}): BootstrapTruncationReportMeta {
  return {
    warningMode: params.warningMode,
    warningShown: params.warning.warningShown,
    promptWarningSignature: params.warning.signature,
    ...(params.warning.warningSignaturesSeen.length > 0
      ? { warningSignaturesSeen: params.warning.warningSignaturesSeen }
      : {}),
    truncatedFiles: params.analysis.truncatedFiles.length,
    nearLimitFiles: params.analysis.nearLimitFiles.length,
    totalNearLimit: params.analysis.totalNearLimit,
  };
}
