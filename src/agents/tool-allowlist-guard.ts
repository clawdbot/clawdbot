import { normalizeToolName } from "./tool-policy.js";

type ExplicitToolAllowlistSource = {
  label: string;
  entries: string[];
  enforceWhenToolsDisabled?: boolean;
};

export function collectExplicitToolAllowlistSources(
  sources: Array<{ label: string; allow?: string[]; enforceWhenToolsDisabled?: boolean }>,
): ExplicitToolAllowlistSource[] {
  return sources.flatMap((source) => {
    const entries = (source.allow ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) {
      return [];
    }
    return [
      {
        label: source.label,
        entries,
        ...(source.enforceWhenToolsDisabled === true ? { enforceWhenToolsDisabled: true } : {}),
      },
    ];
  });
}

export function buildEmptyExplicitToolAllowlistError(params: {
  sources: ExplicitToolAllowlistSource[];
  callableToolNames: string[];
  toolsEnabled: boolean;
  disableTools?: boolean;
}): Error | null {
  const sources =
    params.disableTools === true
      ? params.sources.filter((source) => source.enforceWhenToolsDisabled === true)
      : params.sources;
  const callableToolNames = params.callableToolNames.map(normalizeToolName).filter(Boolean);
  if (sources.length === 0 || callableToolNames.length > 0) {
    return null;
  }
  const requested = sources
    .map((source) => `${source.label}: ${source.entries.map(normalizeToolName).join(", ")}`)
    .join("; ");
  const reason =
    params.disableTools === true
      ? "tools are disabled for this run"
      : params.toolsEnabled
        ? "no registered tools matched"
        : "the selected model does not support tools";
  return new Error(
    `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`,
  );
}
