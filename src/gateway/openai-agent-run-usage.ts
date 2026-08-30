/** Shared agent-run usage selection for OpenAI-compatible Gateway endpoints. */
import {
  hasNonzeroUsage,
  normalizeUsage,
  type NormalizedUsage,
  type UsageLike,
} from "../agents/usage.js";

type AgentRunUsageMeta = {
  usage?: UsageLike;
  lastCallUsage?: UsageLike;
};

/** Prefer a nonzero aggregate snapshot, then the latest model-call snapshot. */
export function resolveAgentRunUsage(result: unknown): NormalizedUsage | undefined {
  const agentMeta = (result as { meta?: { agentMeta?: AgentRunUsageMeta } } | null)?.meta
    ?.agentMeta;
  const aggregate = normalizeUsage(agentMeta?.usage);
  if (hasNonzeroUsage(aggregate)) {
    return aggregate;
  }
  const lastCall = normalizeUsage(agentMeta?.lastCallUsage);
  if (hasNonzeroUsage(lastCall)) {
    return lastCall;
  }
  return aggregate ?? lastCall;
}
