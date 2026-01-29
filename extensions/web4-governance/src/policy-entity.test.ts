import { describe, it, expect, beforeEach } from "vitest";
import {
  PolicyEntity,
  PolicyRegistry,
  computePolicyHash,
  type PolicyEntityId,
} from "./policy-entity.js";
import type { PolicyConfig, PolicyRule, PolicyMatch } from "./policy-types.js";
import { RateLimiter } from "./rate-limiter.js";

describe("PolicyEntity", () => {
  let registry: PolicyRegistry;

  beforeEach(() => {
    registry = new PolicyRegistry();
  });

  describe("entity creation", () => {
    it("creates entity with preset", () => {
      const entity = registry.registerPolicy({
        name: "test",
        preset: "safety",
      });

      expect(entity.name).toBe("test");
      expect(entity.source).toBe("preset");
      expect(entity.entityId).toMatch(/^policy:test:\d+:[a-f0-9]+$/);
      expect(entity.contentHash).toHaveLength(16);
    });

    it("creates entity with custom config", () => {
      const config: PolicyConfig = {
        defaultPolicy: "allow",
        enforce: true,
        rules: [],
      };

      const entity = registry.registerPolicy({
        name: "custom",
        config,
      });

      expect(entity.source).toBe("custom");
      expect(entity.config).toEqual(config);
    });

    it("throws when neither config nor preset provided", () => {
      expect(() =>
        registry.registerPolicy({ name: "invalid" })
      ).toThrow("Must provide either config or preset");
    });

    it("throws when both config and preset provided", () => {
      expect(() =>
        registry.registerPolicy({
          name: "invalid",
          config: { defaultPolicy: "allow", enforce: true, rules: [] },
          preset: "safety",
        })
      ).toThrow("Cannot provide both config and preset");
    });
  });

  describe("hash uniqueness", () => {
    it("different configs produce different hashes", () => {
      const entity1 = registry.registerPolicy({
        name: "safety",
        preset: "safety",
      });
      const entity2 = registry.registerPolicy({
        name: "permissive",
        preset: "permissive",
      });

      expect(entity1.contentHash).not.toBe(entity2.contentHash);
      expect(entity1.entityId).not.toBe(entity2.entityId);
    });

    it("same config returns cached entity", () => {
      const entity1 = registry.registerPolicy({
        name: "safety",
        preset: "safety",
        version: "v1",
      });
      const entity2 = registry.registerPolicy({
        name: "safety",
        preset: "safety",
        version: "v1",
      });

      expect(entity1).toBe(entity2);
    });
  });

  describe("entity ID format", () => {
    it("follows policy:<name>:<version>:<hash> format", () => {
      const entity = registry.registerPolicy({
        name: "test",
        preset: "safety",
        version: "v1",
      });

      const parts = entity.entityId.split(":");
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe("policy");
      expect(parts[1]).toBe("test");
      expect(parts[2]).toBe("v1");
      expect(parts[3]).toBe(entity.contentHash);
    });

    it("auto-generates version as timestamp", () => {
      const entity = registry.registerPolicy({
        name: "test",
        preset: "safety",
      });

      const parts = entity.entityId.split(":");
      const version = parts[2];
      expect(version).toHaveLength(14);
      expect(version).toMatch(/^\d+$/);
    });
  });

  describe("serialization", () => {
    it("toJSON returns entity data", () => {
      const entity = registry.registerPolicy({
        name: "test",
        preset: "safety",
      });

      const json = entity.toJSON();
      expect(json.entityId).toBe(entity.entityId);
      expect(json.name).toBe("test");
      expect(json.contentHash).toBe(entity.contentHash);
      expect(json.config).toBeDefined();
    });
  });
});

describe("PolicyEntity evaluation", () => {
  let registry: PolicyRegistry;

  beforeEach(() => {
    registry = new PolicyRegistry();
  });

  it("allows by default with permissive preset", () => {
    const entity = registry.registerPolicy({
      name: "permissive",
      preset: "permissive",
    });

    const result = entity.evaluate("Read", "file_read", "/tmp/test.txt");

    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeUndefined();
    expect(result.reason).toContain("Default policy");
  });

  it("denies destructive commands with safety preset", () => {
    const entity = registry.registerPolicy({
      name: "safety",
      preset: "safety",
    });

    const result = entity.evaluate("Bash", "command", "rm -rf /");

    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.id).toBe("deny-destructive-commands");
    expect(result.enforced).toBe(true);
  });

  it("denies secret file reads with safety preset", () => {
    const entity = registry.registerPolicy({
      name: "safety",
      preset: "safety",
    });

    const result = entity.evaluate("Read", "file_read", "/app/.env");

    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.id).toBe("deny-secret-files");
  });

  it("warns on network with safety preset", () => {
    const entity = registry.registerPolicy({
      name: "safety",
      preset: "safety",
    });

    const result = entity.evaluate("WebFetch", "network", "https://example.com");

    expect(result.decision).toBe("warn");
    expect(result.matchedRule?.id).toBe("warn-network");
  });

  it("denies by default with strict preset", () => {
    const entity = registry.registerPolicy({
      name: "strict",
      preset: "strict",
    });

    const result = entity.evaluate("Bash", "command", "ls");

    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBeUndefined();
    expect(result.reason).toContain("Default policy");
  });

  it("allows read tools with strict preset", () => {
    const entity = registry.registerPolicy({
      name: "strict",
      preset: "strict",
    });

    for (const tool of ["Read", "Glob", "Grep", "TodoWrite"]) {
      const result = entity.evaluate(tool, "file_read", "/tmp/test.txt");
      expect(result.decision).toBe("allow");
      expect(result.matchedRule?.id).toBe("allow-read-tools");
    }
  });

  it("includes constraints in evaluation", () => {
    const entity = registry.registerPolicy({
      name: "safety",
      preset: "safety",
    });

    const result = entity.evaluate("Bash", "command", "rm -rf /");

    expect(result.constraints).toContain(`policy:${entity.entityId}`);
    expect(result.constraints).toContain("decision:deny");
    expect(result.constraints).toContain("rule:deny-destructive-commands");
  });
});

describe("PolicyEntity with rate limiting", () => {
  let registry: PolicyRegistry;

  beforeEach(() => {
    registry = new PolicyRegistry();
  });

  it("allows under rate limit threshold", () => {
    const config: PolicyConfig = {
      defaultPolicy: "allow",
      enforce: true,
      rules: [
        {
          id: "rate-bash",
          name: "Rate limit Bash",
          priority: 1,
          decision: "deny",
          match: {
            tools: ["Bash"],
            rateLimit: { maxCount: 5, windowMs: 60000 },
          },
        },
      ],
    };

    const entity = registry.registerPolicy({ name: "rate-test", config });
    const limiter = new RateLimiter();

    // Under limit - rule doesn't fire, falls through to default
    const result = entity.evaluate("Bash", "command", "ls", limiter);
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeUndefined();
  });

  it("denies when over rate limit threshold", () => {
    const config: PolicyConfig = {
      defaultPolicy: "allow",
      enforce: true,
      rules: [
        {
          id: "rate-bash",
          name: "Rate limit Bash",
          priority: 1,
          decision: "deny",
          match: {
            tools: ["Bash"],
            rateLimit: { maxCount: 2, windowMs: 60000 },
          },
        },
      ],
    };

    const entity = registry.registerPolicy({ name: "rate-test", config });
    const limiter = new RateLimiter();

    // Record actions to exceed limit
    const key = "ratelimit:rate-bash:tool:Bash";
    limiter.record(key);
    limiter.record(key);

    // Now at limit - rule fires
    const result = entity.evaluate("Bash", "command", "ls", limiter);
    expect(result.decision).toBe("deny");
    expect(result.matchedRule?.id).toBe("rate-bash");
  });
});

describe("PolicyRegistry", () => {
  let registry: PolicyRegistry;

  beforeEach(() => {
    registry = new PolicyRegistry();
  });

  describe("listing policies", () => {
    it("lists all registered policies", () => {
      registry.registerPolicy({ name: "safety", preset: "safety" });
      registry.registerPolicy({ name: "strict", preset: "strict" });

      const policies = registry.listPolicies();

      expect(policies).toHaveLength(2);
      const names = policies.map((p) => p.name);
      expect(names).toContain("safety");
      expect(names).toContain("strict");
    });
  });

  describe("retrieval", () => {
    it("gets policy by entity ID", () => {
      const entity = registry.registerPolicy({
        name: "test",
        preset: "safety",
      });

      const found = registry.getPolicy(entity.entityId);

      expect(found).toBe(entity);
    });

    it("returns undefined for unknown entity ID", () => {
      const found = registry.getPolicy("policy:unknown:v1:abc123" as PolicyEntityId);
      expect(found).toBeUndefined();
    });

    it("gets policy by content hash", () => {
      const entity = registry.registerPolicy({
        name: "test",
        preset: "safety",
      });

      const found = registry.getPolicyByHash(entity.contentHash);

      expect(found).toBe(entity);
    });
  });
});

describe("PolicyRegistry witnessing", () => {
  let registry: PolicyRegistry;

  beforeEach(() => {
    registry = new PolicyRegistry();
  });

  it("records session witnessing policy", () => {
    const entity = registry.registerPolicy({
      name: "safety",
      preset: "safety",
    });

    registry.witnessSession(entity.entityId, "session-123");

    const witnessedBy = registry.getWitnessedBy(entity.entityId);
    expect(witnessedBy).toContain("session:session-123");
  });

  it("records policy witnessing decision", () => {
    const entity = registry.registerPolicy({
      name: "safety",
      preset: "safety",
    });

    registry.witnessDecision(
      entity.entityId,
      "session-123",
      "Read",
      "allow",
      true
    );

    const hasWitnessed = registry.getHasWitnessed(entity.entityId);
    expect(hasWitnessed).toContain("session:session-123");
  });
});

describe("computePolicyHash", () => {
  it("computes consistent hash for same config", () => {
    const config: PolicyConfig = {
      defaultPolicy: "allow",
      enforce: true,
      rules: [],
    };

    const hash1 = computePolicyHash(config);
    const hash2 = computePolicyHash(config);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
  });

  it("computes different hash for different configs", () => {
    const config1: PolicyConfig = {
      defaultPolicy: "allow",
      enforce: true,
      rules: [],
    };
    const config2: PolicyConfig = {
      defaultPolicy: "deny",
      enforce: true,
      rules: [],
    };

    const hash1 = computePolicyHash(config1);
    const hash2 = computePolicyHash(config2);

    expect(hash1).not.toBe(hash2);
  });
});
