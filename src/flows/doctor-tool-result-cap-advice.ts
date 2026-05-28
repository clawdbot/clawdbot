import {
  calculateMaxToolResultCharsWithCap,
  resolveAutoLiveToolResultMaxChars,
} from "../agents/embedded-agent-runner/tool-result-truncation.js";

export type ToolResultCapDoctorAdviceParams = {
  contextWindowTokens: number;
  modelKey: string;
  configuredCap?: number;
  deep?: boolean;
  scopeLabel?: string;
};

function formatNumber(value: number): string {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function buildToolResultCapDoctorAdvice(params: ToolResultCapDoctorAdviceParams): string[] {
  if (!Number.isFinite(params.contextWindowTokens) || params.contextWindowTokens <= 0) {
    return [];
  }

  const autoCap = resolveAutoLiveToolResultMaxChars(params.contextWindowTokens);
  const runtimeCeiling = calculateMaxToolResultCharsWithCap(
    params.contextWindowTokens,
    Number.MAX_SAFE_INTEGER,
  );
  const configuredCap =
    typeof params.configuredCap === "number" && Number.isFinite(params.configuredCap)
      ? Math.floor(params.configuredCap)
      : undefined;
  const configuredSource = configuredCap !== undefined;
  const requestedCap = configuredCap ?? autoCap;
  const effectiveCap = calculateMaxToolResultCharsWithCap(params.contextWindowTokens, requestedCap);
  const autoEffectiveCap = calculateMaxToolResultCharsWithCap(params.contextWindowTokens, autoCap);

  const lines: string[] = [];
  const prefix = params.scopeLabel ? `${params.scopeLabel}: ` : "";
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

  if (configuredCap > runtimeCeiling) {
    lines.push(
      `- ${prefix}configured toolResultMaxChars is ${formatNumber(
        configuredCap,
      )} chars, but this model can use at most ${formatNumber(
        runtimeCeiling,
      )} chars per live tool result; lower it or unset it.`,
    );
    return lines;
  }

  if (effectiveCap < autoEffectiveCap) {
    lines.push(
      `- ${prefix}configured toolResultMaxChars is ${formatNumber(
        configuredCap,
      )} chars; unset it to use the ${formatNumber(
        autoEffectiveCap,
      )} char auto cap for "${params.modelKey}".`,
    );
  }

  return lines;
}
