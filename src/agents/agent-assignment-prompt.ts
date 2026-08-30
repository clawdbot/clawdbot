import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveAgentIdentity } from "./identity.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

const MAX_AGENT_ASSIGNMENT_ID_CHARS = 128;
const MAX_AGENT_ASSIGNMENT_NAME_CHARS = 128;
const MAX_AGENT_ASSIGNMENT_DESCRIPTION_CHARS = 1_024;

function normalizeAssignmentText(value: string, maxChars: number): string | undefined {
  const normalized = sanitizeForPromptLiteral(value.replace(/\s+/gu, " ")).trim();
  const bounded = truncateUtf16Safe(normalized, maxChars).trimEnd();
  return bounded || undefined;
}

/** Builds the selected agent's bounded factual self-assignment for model context. */
export function buildAgentAssignmentPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): string | undefined {
  if (!params.agentId?.trim()) {
    return undefined;
  }
  const agentId = normalizeAssignmentText(
    normalizeAgentId(params.agentId),
    MAX_AGENT_ASSIGNMENT_ID_CHARS,
  );
  if (!agentId) {
    return undefined;
  }
  const resolved = params.config ? resolveAgentConfig(params.config, agentId) : undefined;
  const agentName = params.config
    ? normalizeAssignmentText(
        resolveAgentIdentity(params.config, agentId)?.name ?? "",
        MAX_AGENT_ASSIGNMENT_NAME_CHARS,
      )
    : undefined;
  const description = normalizeAssignmentText(
    resolved?.description ?? "",
    MAX_AGENT_ASSIGNMENT_DESCRIPTION_CHARS,
  );
  return [
    "## Agent Assignment",
    "OpenClaw config is authoritative for agent ID, name, specialist scope, and handoff boundary.",
    `Agent ID: ${agentId}`,
    agentName && agentName !== agentId ? `Name: ${agentName}` : undefined,
    description ? `Specialist scope and handoff boundary: ${description}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
