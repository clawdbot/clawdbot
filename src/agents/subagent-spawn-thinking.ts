import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function resolveSubagentThinkingOverride(params: {
  cfg: OpenClawConfig;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
}) {
  const requesterSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.requesterAgentConfig)?.subagents,
  );
  const targetSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.targetAgentConfig)?.subagents,
  );
  const defaultSubagents = asOptionalObjectRecord(params.cfg.agents?.defaults?.subagents);
  const resolvedThinkingDefaultRaw =
    readString(requesterSubagents ?? {}, "thinking") ??
    readString(targetSubagents ?? {}, "thinking") ??
    readString(defaultSubagents ?? {}, "thinking");

  const overrideCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (overrideCandidateRaw) {
    const normalizedThinking = normalizeThinkLevel(overrideCandidateRaw);
    if (!normalizedThinking) {
      return {
        status: "error" as const,
        thinkingCandidateRaw: overrideCandidateRaw,
      };
    }

    return {
      status: "ok" as const,
      thinkingOverride: normalizedThinking,
      initialSessionPatch: {
        thinkingLevel: normalizedThinking,
      },
    };
  }

  if (!params.callerThinkingRaw) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  const normalizedThinking = normalizeThinkLevel(params.callerThinkingRaw);
  if (!normalizedThinking) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  return {
    status: "ok" as const,
    thinkingOverride: undefined,
    initialSessionPatch: {
      thinkingLevel: normalizedThinking,
    },
  };
}
