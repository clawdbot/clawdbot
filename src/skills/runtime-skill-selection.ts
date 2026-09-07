import type { SkillTelemetrySource } from "./types.js";

export type RuntimeSkillSelectionMarker = {
  kind: "skill_selection";
  schemaVersion: 1;
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  runId: string | null;
  selectedSkill: string;
  selectionSource: "observed_runtime";
  selectionConfidence: "observed";
  selectionRule: "tool_invocation";
  activation: "command" | "read";
  skillSource: SkillTelemetrySource;
  redaction: "metadata_only";
};

function cleanOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Sanitize a skill name into a safe form for audit storage.
 * Skill names like "Daily Brief" are valid at runtime but contain characters
 * (spaces) that are not safe for audit field values. We replace unsafe
 * characters with hyphens and truncate to 128 chars.
 */
function sanitizeSkillName(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 128) || "unknown";
}

export function buildRuntimeSkillSelectionMarker(params: {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  skillName: string;
  skillSource: SkillTelemetrySource;
  activation: "command" | "read";
}): RuntimeSkillSelectionMarker {
  return {
    kind: "skill_selection",
    schemaVersion: 1,
    agentId: cleanOptionalString(params.agentId),
    sessionKey: cleanOptionalString(params.sessionKey),
    sessionId: cleanOptionalString(params.sessionId),
    runId: cleanOptionalString(params.runId),
    selectedSkill: sanitizeSkillName(params.skillName),
    selectionSource: "observed_runtime",
    selectionConfidence: "observed",
    selectionRule: "tool_invocation",
    activation: params.activation,
    skillSource: params.skillSource,
    redaction: "metadata_only",
  };
}
