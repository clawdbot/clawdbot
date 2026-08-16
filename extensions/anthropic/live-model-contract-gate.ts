/**
 * Contract gate for live-discovered Anthropic models the manifest does not
 * publish. Claude request shaping is selected by model-version predicates, so a
 * model those predicates do not recognize is shaped like a pre-4.6 model:
 * manual `budget_tokens` thinking plus caller sampling parameters. Current
 * Claude models reject both, so surfacing an unrecognized model would offer a
 * selectable entry whose every request 400s.
 *
 * Rather than hand-maintaining a family allowlist that rots on each launch,
 * accept a discovered model only when Anthropic's advertised capabilities agree
 * with what our contracts would apply. Disagreement means our shaping is stale
 * for that model, so it stays hidden until the contracts are updated.
 */
import {
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "openclaw/plugin-sdk/provider-model-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function readCapabilityFlag(root: unknown, path: readonly string[]): boolean | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "boolean" ? current : undefined;
}

/**
 * Anthropic publishes a capability tree on `/v1/models`. Each entry pairs a
 * capability we can read from that tree with the contract predicate that must
 * agree, so a mismatch on any axis rejects the model.
 */
const CLAUDE_CONTRACT_CAPABILITY_CHECKS = [
  {
    path: ["thinking", "types", "adaptive", "supported"],
    matches: supportsClaudeAdaptiveThinking,
  },
  { path: ["effort", "xhigh", "supported"], matches: supportsClaudeNativeXhighEffort },
  { path: ["effort", "max", "supported"], matches: supportsClaudeNativeMaxEffort },
] as const;

/**
 * Return whether a live-discovered Claude model can be shaped by the current
 * contracts. Fails closed: a model without a readable capability tree is
 * rejected, because we cannot prove our shaping matches it.
 */
export function acceptsAnthropicLiveModelContract(params: {
  id: string;
  record: Record<string, unknown>;
}): boolean {
  const capabilities = params.record.capabilities;
  if (!isRecord(capabilities)) {
    return false;
  }
  const ref = { id: params.id };
  return CLAUDE_CONTRACT_CAPABILITY_CHECKS.every((check) => {
    const advertised = readCapabilityFlag(capabilities, check.path);
    return advertised !== undefined && advertised === check.matches(ref);
  });
}
