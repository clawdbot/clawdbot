import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function resolveSubagentThinkingOverride(params: {
  cfg: OpenClawConfig;
  targetAgentConfig?: unknown;
  thinkingOverrideRaw?: string;
}) {
  const targetSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.targetAgentConfig)?.subagents,
  );
  const defaultSubagents = asOptionalObjectRecord(params.cfg.agents?.defaults?.subagents);
  const resolvedThinkingDefaultRaw =
    readString(targetSubagents ?? {}, "thinking") ?? readString(defaultSubagents ?? {}, "thinking");

  const thinkingCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (!thinkingCandidateRaw) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  const normalizedThinking = normalizeThinkLevel(thinkingCandidateRaw);
  if (!normalizedThinking) {
    return {
      status: "error" as const,
      thinkingCandidateRaw,
    };
  }

  return {
    status: "ok" as const,
    thinkingOverride: normalizedThinking,
    initialSessionPatch: {
      thinkingLevel: normalizedThinking === "off" ? null : normalizedThinking,
    },
  };
}
