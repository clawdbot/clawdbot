/**
 * Policy Engine - Evaluate tool calls against configurable rules.
 *
 * Rules are sorted by priority (ascending). First match wins.
 * Supports allow/deny/warn decisions with optional dry-run mode.
 * Optionally integrates with RateLimiter for time-windowed rate limiting.
 */

import type { ToolCategory } from "./r6.js";
import type {
  PolicyConfig,
  PolicyDecision,
  PolicyEvaluation,
  PolicyRule,
} from "./policy-types.js";
import { matchesRule } from "./matchers.js";
import type { RateLimiter } from "./rate-limiter.js";

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  defaultPolicy: "allow",
  enforce: true,
  rules: [],
};

export class PolicyEngine {
  private rules: PolicyRule[];
  private defaultPolicy: PolicyDecision;
  private enforce: boolean;
  private rateLimiter?: RateLimiter;

  constructor(config: Partial<PolicyConfig> = {}, rateLimiter?: RateLimiter) {
    const merged = { ...DEFAULT_POLICY_CONFIG, ...config };
    this.defaultPolicy = merged.defaultPolicy;
    this.enforce = merged.enforce;
    // Sort by priority ascending (lower = higher priority)
    this.rules = [...merged.rules].sort((a, b) => a.priority - b.priority);
    this.rateLimiter = rateLimiter;
  }

  /** Evaluate a tool call against all rules. First match wins. */
  evaluate(
    toolName: string,
    category: ToolCategory,
    target: string | undefined,
  ): PolicyEvaluation {
    for (const rule of this.rules) {
      // Check standard matchers
      const matchesStandard = matchesRule(toolName, category, target, rule.match);
      if (!matchesStandard) continue;

      // If rule has rateLimit, also check the rate limiter
      if (rule.match.rateLimit && this.rateLimiter) {
        const key = this.buildRateLimitKey(rule, toolName, category);
        const { allowed } = this.rateLimiter.check(
          key,
          rule.match.rateLimit.maxCount,
          rule.match.rateLimit.windowMs,
        );
        // Rate limit rule only "matches" when the limit is exceeded
        if (allowed) continue;
      } else if (rule.match.rateLimit && !this.rateLimiter) {
        // No rate limiter available — skip rate limit criterion
        continue;
      }

      const decision = rule.decision;
      const enforced = decision === "deny" ? this.enforce : true;
      const reason = rule.reason ?? `Matched rule: ${rule.name}`;
      return {
        decision,
        matchedRule: rule,
        enforced,
        reason,
        constraints: [`policy:${decision}`, `rule:${rule.id}`],
      };
    }

    // No rule matched — apply default
    return {
      decision: this.defaultPolicy,
      enforced: true,
      reason: `Default policy: ${this.defaultPolicy}`,
      constraints: [`policy:${this.defaultPolicy}`, "rule:default"],
    };
  }

  /** Check if a tool call should be blocked (deny + enforce). */
  shouldBlock(
    toolName: string,
    category: ToolCategory,
    target: string | undefined,
  ): { blocked: boolean; evaluation: PolicyEvaluation } {
    const evaluation = this.evaluate(toolName, category, target);
    const blocked = evaluation.decision === "deny" && evaluation.enforced;
    return { blocked, evaluation };
  }

  /** Build rate limit key from rule + tool context. */
  private buildRateLimitKey(rule: PolicyRule, toolName: string, category: ToolCategory): string {
    // Use the most specific match criterion for the key
    if (rule.match.tools?.length) {
      return `ratelimit:${rule.id}:tool:${toolName}`;
    }
    if (rule.match.categories?.length) {
      return `ratelimit:${rule.id}:category:${category}`;
    }
    return `ratelimit:${rule.id}:global`;
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  get isEnforcing(): boolean {
    return this.enforce;
  }

  get defaultDecision(): PolicyDecision {
    return this.defaultPolicy;
  }

  /** Get all rules in evaluation order (priority ascending). */
  get sortedRules(): readonly PolicyRule[] {
    return this.rules;
  }
}
