// Tool result cap advice helpers format doctor guidance for capped outputs.
import {
  calculateMaxToolResultCharsWithCap,
  resolveAutoLiveToolResultMaxChars,
} from "../agents/embedded-agent-runner/tool-result-truncation.js";
import type { HealthFinding } from "./health-checks.js";

const TOOL_RESULT_CAP_CHECK_ID = "core/doctor/tool-result-cap";

type ToolResultCapDoctorIssue = {
  kind: "configured-above-runtime-ceiling" | "configured-below-auto-cap";
  contextWindowTokens: number;
  modelKey: string;
  configuredCap: number;
  runtimeCeiling?: number;
  autoEffectiveCap?: number;
  path?: string;
  scopeLabel?: string;
  target?: string;
};

// Doctor advice for explicit live tool-result caps that fight model-window defaults.
type ToolResultCapDoctorAdviceParams = {
  contextWindowTokens: number;
  modelKey: string;
  configuredCap?: number;
  deep?: boolean;
  path?: string;
  scopeLabel?: string;
  target?: string;
};

function formatNumber(value: number): string {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatIssueMessage(issue: ToolResultCapDoctorIssue): string {
  const prefix = issue.scopeLabel ? `${issue.scopeLabel}: ` : "";
  if (issue.kind === "configured-above-runtime-ceiling") {
    return `${prefix}configured toolResultMaxChars is ${formatNumber(
      issue.configuredCap,
    )} chars, but this model can use at most ${formatNumber(
      issue.runtimeCeiling ?? 0,
    )} chars per live tool result; lower it or unset it.`;
  }
  return `${prefix}configured toolResultMaxChars is ${formatNumber(
    issue.configuredCap,
  )} chars; unset it to use the ${formatNumber(issue.autoEffectiveCap ?? 0)} char auto cap for "${
    issue.modelKey
  }".`;
}

export function collectToolResultCapDoctorIssues(
  params: ToolResultCapDoctorAdviceParams,
): ToolResultCapDoctorIssue[] {
  if (!Number.isFinite(params.contextWindowTokens) || params.contextWindowTokens <= 0) {
    return [];
  }

  const configuredCap =
    typeof params.configuredCap === "number" && Number.isFinite(params.configuredCap)
      ? Math.floor(params.configuredCap)
      : undefined;
  if (configuredCap === undefined) {
    return [];
  }

  const autoCap = resolveAutoLiveToolResultMaxChars(params.contextWindowTokens);
  const runtimeCeiling = calculateMaxToolResultCharsWithCap(
    params.contextWindowTokens,
    Number.MAX_SAFE_INTEGER,
  );
  const effectiveCap = calculateMaxToolResultCharsWithCap(
    params.contextWindowTokens,
    configuredCap,
  );
  const autoEffectiveCap = calculateMaxToolResultCharsWithCap(params.contextWindowTokens, autoCap);

  if (configuredCap > runtimeCeiling) {
    return [
      {
        kind: "configured-above-runtime-ceiling",
        contextWindowTokens: params.contextWindowTokens,
        modelKey: params.modelKey,
        configuredCap,
        runtimeCeiling,
        path: params.path,
        scopeLabel: params.scopeLabel,
        target: params.target,
      },
    ];
  }

  if (effectiveCap < autoEffectiveCap) {
    return [
      {
        kind: "configured-below-auto-cap",
        contextWindowTokens: params.contextWindowTokens,
        modelKey: params.modelKey,
        configuredCap,
        autoEffectiveCap,
        path: params.path,
        scopeLabel: params.scopeLabel,
        target: params.target,
      },
    ];
  }

  return [];
}

export function toolResultCapDoctorIssueToHealthFinding(
  issue: ToolResultCapDoctorIssue,
): HealthFinding {
  return {
    checkId: TOOL_RESULT_CAP_CHECK_ID,
    severity: "warning",
    message: formatIssueMessage(issue),
    ...(issue.path ? { path: issue.path } : {}),
    ...(issue.target ? { target: issue.target } : {}),
    requirement: issue.kind,
    fixHint: issue.path ? `Lower or unset ${issue.path}.` : "Lower or unset toolResultMaxChars.",
  };
}

/** Builds human-readable doctor lines for stale or ineffective toolResultMaxChars settings. */
export function buildToolResultCapDoctorAdvice(params: ToolResultCapDoctorAdviceParams): string[] {
  if (!Number.isFinite(params.contextWindowTokens) || params.contextWindowTokens <= 0) {
    return [];
  }

  const autoCap = resolveAutoLiveToolResultMaxChars(params.contextWindowTokens);
  const configuredCap =
    typeof params.configuredCap === "number" && Number.isFinite(params.configuredCap)
      ? Math.floor(params.configuredCap)
      : undefined;
  const configuredSource = configuredCap !== undefined;
  const requestedCap = configuredCap ?? autoCap;
  const effectiveCap = calculateMaxToolResultCharsWithCap(params.contextWindowTokens, requestedCap);
  const lines: string[] = [];
  const prefix = params.scopeLabel ? `${params.scopeLabel}: ` : "";
  // Deep mode always shows the effective cap, even when no warning is needed.
  if (params.deep) {
    lines.push(
      `- ${prefix}primary model "${params.modelKey}" context window ${formatNumber(
        params.contextWindowTokens,
      )} tokens; live tool-result cap ${formatNumber(effectiveCap)} chars (${
        configuredSource ? "explicit" : "auto"
      })`,
    );
  }

  if (configuredCap === undefined) {
    return lines;
  }

  lines.push(
    ...collectToolResultCapDoctorIssues(params).map((issue) => `- ${formatIssueMessage(issue)}`),
  );

  return lines;
}
