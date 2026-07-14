import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Resolves an agent override before falling back to the configured default. */
export function resolveAgentContextLimitValue(params: {
  config: EmbeddedRunAttemptParams["config"] | undefined;
  agentId?: string;
  key: string;
}): number | undefined {
  const agents = readRecord(params.config?.agents);
  const defaults = readRecord(readRecord(agents?.defaults)?.contextLimits);
  const defaultValue = readPositiveInteger(defaults?.[params.key]);
  if (!params.agentId) {
    return defaultValue;
  }
  const list = agents?.list;
  if (!Array.isArray(list)) {
    return defaultValue;
  }
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const agent = list.find((entry) => {
    const entryId = readRecord(entry)?.id;
    return typeof entryId === "string" && normalizeAgentId(entryId) === normalizedAgentId;
  });
  const agentValue = readPositiveInteger(
    readRecord(readRecord(agent)?.contextLimits)?.[params.key],
  );
  return agentValue ?? defaultValue;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
