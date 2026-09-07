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

function assertSkillName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(trimmed)) {
    throw new Error("skill selection audit requires a stable skill name");
  }
  return trimmed;
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
    selectedSkill: assertSkillName(params.skillName),
    selectionSource: "observed_runtime",
    selectionConfidence: "observed",
    selectionRule: "tool_invocation",
    activation: params.activation,
    skillSource: params.skillSource,
    redaction: "metadata_only",
  };
}
