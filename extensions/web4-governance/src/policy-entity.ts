/**
 * Policy Entity - Policy as a first-class participant in the trust network.
 *
 * Policy isn't just configuration - it's society's law. It has identity,
 * can be witnessed, and is hash-tracked in the audit chain.
 *
 * Key concepts:
 * - Policy is immutable once registered (changing = new entity)
 * - Sessions witness operating under a policy
 * - Policy witnesses agent decisions (allow/deny)
 * - R6 records reference the policyHash in effect
 */

import { createHash } from "crypto";
import type {
  PolicyConfig,
  PolicyRule,
  PolicyMatch,
  PolicyDecision,
  PolicyEvaluation,
} from "./policy-types.js";
import type { ToolCategory } from "./r6.js";
import { resolvePreset } from "./presets.js";
import type { RateLimiter } from "./rate-limiter.js";

export type PolicyEntityId = `policy:${string}:${string}:${string}`;

export type PolicyEntityData = {
  entityId: PolicyEntityId;
  name: string;
  version: string;
  contentHash: string;
  createdAt: string;
  source: "preset" | "custom";
  config: PolicyConfig;
};

/**
 * A policy as a first-class entity in the trust network.
 *
 * Properties:
 * - entityId: Unique identifier (policy:<name>:<version>:<hash>)
 * - contentHash: SHA-256 of the policy document (first 16 chars)
 * - config: The actual policy configuration
 */
export class PolicyEntity {
  readonly entityId: PolicyEntityId;
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly source: "preset" | "custom";
  readonly config: PolicyConfig;

  /** Rules sorted by priority (ascending) for evaluation */
  private sortedRules: PolicyRule[];

  constructor(data: PolicyEntityData) {
    this.entityId = data.entityId;
    this.name = data.name;
    this.version = data.version;
    this.contentHash = data.contentHash;
    this.createdAt = data.createdAt;
    this.source = data.source;
    this.config = data.config;

    // Sort rules by priority (lower = evaluated first)
    this.sortedRules = [...data.config.rules].sort(
      (a, b) => a.priority - b.priority
    );
  }

  /**
   * Evaluate a tool call against this policy.
   */
  evaluate(
    toolName: string,
    category: string,
    target?: string,
    rateLimiter?: RateLimiter
  ): PolicyEvaluation {
    for (const rule of this.sortedRules) {
      if (this.matchesRule(toolName, category, target, rule.match)) {
        // Check rate limit if specified
        if (rule.match.rateLimit && rateLimiter) {
          const key = this.rateLimitKey(rule, toolName, category);
          const result = rateLimiter.check(
            key,
            rule.match.rateLimit.maxCount,
            rule.match.rateLimit.windowMs
          );
          if (result.allowed) {
            continue; // Under limit, rule doesn't fire
          }
        }

        const enforced = rule.decision !== "deny" || this.config.enforce;
        return {
          decision: rule.decision,
          matchedRule: rule,
          enforced,
          reason: rule.reason ?? `Matched rule: ${rule.name}`,
          constraints: [
            `policy:${this.entityId}`,
            `decision:${rule.decision}`,
            `rule:${rule.id}`,
          ],
        };
      }
    }

    // No rule matched - default policy
    return {
      decision: this.config.defaultPolicy,
      matchedRule: undefined,
      enforced: true,
      reason: `Default policy: ${this.config.defaultPolicy}`,
      constraints: [
        `policy:${this.entityId}`,
        `decision:${this.config.defaultPolicy}`,
        "rule:default",
      ],
    };
  }

  private matchesRule(
    toolName: string,
    category: string,
    target: string | undefined,
    match: PolicyMatch
  ): boolean {
    // Tool match
    if (match.tools && !match.tools.includes(toolName)) {
      return false;
    }

    // Category match
    if (match.categories && !match.categories.includes(category as ToolCategory)) {
      return false;
    }

    // Target pattern match
    if (match.targetPatterns) {
      if (!target) {
        return false;
      }
      let matched = false;
      for (const pattern of match.targetPatterns) {
        if (match.targetPatternsAreRegex) {
          if (new RegExp(pattern).test(target)) {
            matched = true;
            break;
          }
        } else {
          // Simple glob matching (convert * to .*)
          const regexPattern = pattern
            .replace(/\*\*/g, ".*")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, ".");
          if (new RegExp(`^${regexPattern}$`).test(target)) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        return false;
      }
    }

    return true;
  }

  private rateLimitKey(
    rule: PolicyRule,
    toolName: string,
    category: string
  ): string {
    if (rule.match.tools) {
      return `ratelimit:${rule.id}:tool:${toolName}`;
    }
    if (rule.match.categories) {
      return `ratelimit:${rule.id}:category:${category}`;
    }
    return `ratelimit:${rule.id}:global`;
  }

  toJSON(): PolicyEntityData {
    return {
      entityId: this.entityId,
      name: this.name,
      version: this.version,
      contentHash: this.contentHash,
      createdAt: this.createdAt,
      source: this.source,
      config: this.config,
    };
  }
}

/**
 * Registry of policy entities with hash-tracking.
 *
 * Policies are registered once and become immutable. Changing a policy
 * creates a new entity with a new hash.
 */
export class PolicyRegistry {
  /** In-memory cache of loaded policies */
  private cache = new Map<PolicyEntityId, PolicyEntity>();

  /** Witnessing records: entity -> set of witnesses */
  private witnessedBy = new Map<string, Set<string>>();

  /** Witnessing records: entity -> set of entities witnessed */
  private hasWitnessed = new Map<string, Set<string>>();

  /**
   * Register a policy and create its entity.
   */
  registerPolicy(options: {
    name: string;
    config?: PolicyConfig;
    preset?: string;
    version?: string;
  }): PolicyEntity {
    const { name, config: providedConfig, preset, version } = options;

    if (!providedConfig && !preset) {
      throw new Error("Must provide either config or preset");
    }
    if (providedConfig && preset) {
      throw new Error("Cannot provide both config and preset");
    }

    // Resolve config
    let config: PolicyConfig;
    let source: "preset" | "custom";
    if (preset) {
      config = resolvePreset(preset);
      source = "preset";
    } else {
      config = providedConfig!;
      source = "custom";
    }

    // Generate version if not provided
    const versionStr = version ?? new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);

    // Compute content hash
    const contentStr = JSON.stringify(config, Object.keys(config).sort());
    const contentHash = createHash("sha256")
      .update(contentStr)
      .digest("hex")
      .slice(0, 16);

    // Build entity ID
    const entityId: PolicyEntityId = `policy:${name}:${versionStr}:${contentHash}`;

    // Check cache
    if (this.cache.has(entityId)) {
      return this.cache.get(entityId)!;
    }

    // Create entity
    const entity = new PolicyEntity({
      entityId,
      name,
      version: versionStr,
      contentHash,
      createdAt: new Date().toISOString(),
      source,
      config,
    });

    // Cache
    this.cache.set(entityId, entity);

    return entity;
  }

  /**
   * Get a policy by entity ID.
   */
  getPolicy(entityId: PolicyEntityId): PolicyEntity | undefined {
    return this.cache.get(entityId);
  }

  /**
   * Get a policy by content hash.
   */
  getPolicyByHash(contentHash: string): PolicyEntity | undefined {
    for (const entity of this.cache.values()) {
      if (entity.contentHash === contentHash) {
        return entity;
      }
    }
    return undefined;
  }

  /**
   * List all registered policies.
   */
  listPolicies(): PolicyEntity[] {
    return [...this.cache.values()];
  }

  /**
   * Record that a session is operating under this policy.
   *
   * Creates bidirectional witnessing:
   * - Session witnesses the policy (I operate under these rules)
   * - Policy witnesses the session (this session uses me)
   */
  witnessSession(policyEntityId: PolicyEntityId, sessionId: string): void {
    const sessionEntity = `session:${sessionId}`;

    // Policy is witnessed by session
    if (!this.witnessedBy.has(policyEntityId)) {
      this.witnessedBy.set(policyEntityId, new Set());
    }
    this.witnessedBy.get(policyEntityId)!.add(sessionEntity);

    // Session has witnessed policy
    if (!this.hasWitnessed.has(sessionEntity)) {
      this.hasWitnessed.set(sessionEntity, new Set());
    }
    this.hasWitnessed.get(sessionEntity)!.add(policyEntityId);
  }

  /**
   * Record a policy decision in the witnessing chain.
   */
  witnessDecision(
    policyEntityId: PolicyEntityId,
    sessionId: string,
    _toolName: string,
    _decision: PolicyDecision,
    _success: boolean
  ): void {
    const sessionEntity = `session:${sessionId}`;

    // Policy has witnessed the session's action
    if (!this.hasWitnessed.has(policyEntityId)) {
      this.hasWitnessed.set(policyEntityId, new Set());
    }
    this.hasWitnessed.get(policyEntityId)!.add(sessionEntity);
  }

  /**
   * Get entities that have witnessed a policy.
   */
  getWitnessedBy(entityId: string): string[] {
    return [...(this.witnessedBy.get(entityId) ?? [])];
  }

  /**
   * Get entities that a policy has witnessed.
   */
  getHasWitnessed(entityId: string): string[] {
    return [...(this.hasWitnessed.get(entityId) ?? [])];
  }
}

/**
 * Compute a policy content hash.
 */
export function computePolicyHash(config: PolicyConfig): string {
  const contentStr = JSON.stringify(config, Object.keys(config).sort());
  return createHash("sha256").update(contentStr).digest("hex").slice(0, 16);
}
