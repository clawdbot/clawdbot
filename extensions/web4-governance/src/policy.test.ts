import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PolicyEngine } from "./policy.js";
import type { PolicyConfig, PolicyRule } from "./policy-types.js";
import { RateLimiter } from "./rate-limiter.js";

function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, "id" | "match">): PolicyRule {
  return {
    name: overrides.id,
    priority: 50,
    decision: "deny",
    ...overrides,
  };
}

describe("PolicyEngine", () => {
  describe("constructor", () => {
    it("should use defaults when no config provided", () => {
      const engine = new PolicyEngine();
      expect(engine.ruleCount).toBe(0);
      expect(engine.isEnforcing).toBe(true);
    });

    it("should sort rules by priority ascending", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({ id: "low", priority: 100, match: { tools: ["Write"] } }),
          rule({ id: "high", priority: 1, match: { tools: ["Bash"] } }),
          rule({ id: "mid", priority: 50, match: { tools: ["Read"] } }),
        ],
      });
      // Bash (priority 1) should match before Write (priority 100)
      const evalBash = engine.evaluate("Bash", "command", "ls");
      expect(evalBash.matchedRule?.id).toBe("high");
    });
  });

  describe("evaluate", () => {
    it("should return default policy when no rules match", () => {
      const engine = new PolicyEngine({ defaultPolicy: "allow", rules: [] });
      const result = engine.evaluate("Read", "file_read", "/foo");
      expect(result.decision).toBe("allow");
      expect(result.matchedRule).toBeUndefined();
      expect(result.constraints).toEqual(["policy:allow", "rule:default"]);
    });

    it("should match deny rule by tool name", () => {
      const engine = new PolicyEngine({
        rules: [rule({ id: "no-bash", match: { tools: ["Bash"] } })],
      });
      const result = engine.evaluate("Bash", "command", "ls");
      expect(result.decision).toBe("deny");
      expect(result.matchedRule?.id).toBe("no-bash");
      expect(result.constraints).toEqual(["policy:deny", "rule:no-bash"]);
    });

    it("should match by category", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({ id: "no-network", decision: "warn", match: { categories: ["network"] } }),
        ],
      });
      const result = engine.evaluate("WebFetch", "network", "https://example.com");
      expect(result.decision).toBe("warn");
      expect(result.matchedRule?.id).toBe("no-network");
    });

    it("should match by target pattern (regex)", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({
            id: "no-rm-rf",
            match: { targetPatterns: ["rm\\s+-rf"], targetPatternsAreRegex: true },
          }),
        ],
      });
      expect(engine.evaluate("Bash", "command", "rm -rf /").decision).toBe("deny");
      expect(engine.evaluate("Bash", "command", "ls -la").decision).toBe("allow");
    });

    it("should match by target pattern (glob)", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({
            id: "no-env-files",
            match: { targetPatterns: ["**/.env*"] },
          }),
        ],
      });
      expect(engine.evaluate("Read", "file_read", "/project/.env").decision).toBe("deny");
      expect(engine.evaluate("Read", "file_read", "/project/.env.local").decision).toBe("deny");
      expect(engine.evaluate("Read", "file_read", "/project/src/index.ts").decision).toBe("allow");
    });

    it("should AND all match criteria", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({
            id: "bash-rm-only",
            match: {
              tools: ["Bash"],
              targetPatterns: ["rm\\s+-rf"],
              targetPatternsAreRegex: true,
            },
          }),
        ],
      });
      // Both match → deny
      expect(engine.evaluate("Bash", "command", "rm -rf /tmp").decision).toBe("deny");
      // Tool matches, target doesn't → allow (default)
      expect(engine.evaluate("Bash", "command", "ls").decision).toBe("allow");
      // Target matches, tool doesn't → allow (default)
      expect(engine.evaluate("Read", "file_read", "rm -rf").decision).toBe("allow");
    });

    it("should use first-match-wins (priority order)", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({ id: "allow-read", priority: 1, decision: "allow", match: { tools: ["Read"] } }),
          rule({ id: "deny-all-reads", priority: 10, decision: "deny", match: { categories: ["file_read"] } }),
        ],
      });
      // Read matches both, but allow-read has higher priority
      expect(engine.evaluate("Read", "file_read", "/foo").decision).toBe("allow");
      // Glob only matches deny-all-reads
      expect(engine.evaluate("Glob", "file_read", "/src").decision).toBe("deny");
    });

    it("should include reason from matched rule", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({ id: "x", reason: "Blocked for safety", match: { tools: ["Bash"] } }),
        ],
      });
      expect(engine.evaluate("Bash", "command", "ls").reason).toBe("Blocked for safety");
    });

    it("should use fallback reason when rule has none", () => {
      const engine = new PolicyEngine({
        rules: [rule({ id: "x", match: { tools: ["Bash"] } })],
      });
      expect(engine.evaluate("Bash", "command", "ls").reason).toBe("Matched rule: x");
    });

    it("should respect default policy of deny", () => {
      const engine = new PolicyEngine({ defaultPolicy: "deny", rules: [] });
      const result = engine.evaluate("Read", "file_read", "/foo");
      expect(result.decision).toBe("deny");
      expect(result.constraints).toContain("policy:deny");
    });
  });

  describe("shouldBlock", () => {
    it("should block when deny + enforce", () => {
      const engine = new PolicyEngine({
        enforce: true,
        rules: [rule({ id: "x", match: { tools: ["Bash"] } })],
      });
      const { blocked } = engine.shouldBlock("Bash", "command", "ls");
      expect(blocked).toBe(true);
    });

    it("should not block when deny + no enforce (dry-run)", () => {
      const engine = new PolicyEngine({
        enforce: false,
        rules: [rule({ id: "x", match: { tools: ["Bash"] } })],
      });
      const { blocked, evaluation } = engine.shouldBlock("Bash", "command", "ls");
      expect(blocked).toBe(false);
      expect(evaluation.decision).toBe("deny");
      expect(evaluation.enforced).toBe(false);
    });

    it("should not block on allow decisions", () => {
      const engine = new PolicyEngine({
        enforce: true,
        rules: [rule({ id: "x", decision: "allow", match: { tools: ["Bash"] } })],
      });
      expect(engine.shouldBlock("Bash", "command", "ls").blocked).toBe(false);
    });

    it("should not block on warn decisions", () => {
      const engine = new PolicyEngine({
        enforce: true,
        rules: [rule({ id: "x", decision: "warn", match: { tools: ["Bash"] } })],
      });
      expect(engine.shouldBlock("Bash", "command", "ls").blocked).toBe(false);
    });
  });

  describe("real-world policy scenarios", () => {
    const config: PolicyConfig = {
      defaultPolicy: "allow",
      enforce: true,
      rules: [
        {
          id: "deny-destructive-commands",
          name: "Block destructive shell commands",
          priority: 1,
          decision: "deny",
          reason: "Destructive command blocked",
          match: {
            tools: ["Bash"],
            targetPatterns: ["rm\\s+-rf", "mkfs\\."],
            targetPatternsAreRegex: true,
          },
        },
        {
          id: "warn-network",
          name: "Warn on network access",
          priority: 10,
          decision: "warn",
          match: { categories: ["network"] },
        },
        {
          id: "deny-secrets",
          name: "Block reading secret files",
          priority: 5,
          decision: "deny",
          reason: "Secret file access denied",
          match: {
            categories: ["file_read"],
            targetPatterns: ["**/.env", "**/.env.*", "**/credentials.*", "**/*secret*"],
          },
        },
      ],
    };

    const engine = new PolicyEngine(config);

    it("should block rm -rf", () => {
      const { blocked, evaluation } = engine.shouldBlock("Bash", "command", "rm -rf /tmp/data");
      expect(blocked).toBe(true);
      expect(evaluation.reason).toBe("Destructive command blocked");
    });

    it("should block mkfs", () => {
      const { blocked } = engine.shouldBlock("Bash", "command", "mkfs.ext4 /dev/sda1");
      expect(blocked).toBe(true);
    });

    it("should allow safe bash commands", () => {
      const { blocked } = engine.shouldBlock("Bash", "command", "ls -la /tmp");
      expect(blocked).toBe(false);
    });

    it("should warn on network access", () => {
      const eval1 = engine.evaluate("WebFetch", "network", "https://example.com");
      expect(eval1.decision).toBe("warn");
      expect(eval1.matchedRule?.id).toBe("warn-network");
    });

    it("should block .env file reads", () => {
      const { blocked } = engine.shouldBlock("Read", "file_read", "/project/.env");
      expect(blocked).toBe(true);
    });

    it("should block credentials file reads", () => {
      const { blocked } = engine.shouldBlock("Read", "file_read", "/home/user/credentials.json");
      expect(blocked).toBe(true);
    });

    it("should allow normal file reads", () => {
      const { blocked } = engine.shouldBlock("Read", "file_read", "/project/src/index.ts");
      expect(blocked).toBe(false);
    });

    it("should allow normal file writes", () => {
      const { blocked } = engine.shouldBlock("Write", "file_write", "/project/src/index.ts");
      expect(blocked).toBe(false);
    });
  });

  describe("rate limiting", () => {
    it("should allow when under rate limit", () => {
      const limiter = new RateLimiter();
      const engine = new PolicyEngine(
        {
          rules: [
            rule({
              id: "bash-rate",
              decision: "deny",
              reason: "Rate limit exceeded",
              match: {
                tools: ["Bash"],
                rateLimit: { maxCount: 3, windowMs: 60_000 },
              },
            }),
          ],
        },
        limiter,
      );

      // Under limit — rule should NOT match, default allow applies
      const result = engine.evaluate("Bash", "command", "ls");
      expect(result.decision).toBe("allow");
    });

    it("should deny when rate limit exceeded", () => {
      const limiter = new RateLimiter();
      const key = "ratelimit:bash-rate:tool:Bash";
      // Fill up the limiter
      for (let i = 0; i < 3; i++) limiter.record(key);

      const engine = new PolicyEngine(
        {
          rules: [
            rule({
              id: "bash-rate",
              decision: "deny",
              reason: "Rate limit exceeded",
              match: {
                tools: ["Bash"],
                rateLimit: { maxCount: 3, windowMs: 60_000 },
              },
            }),
          ],
        },
        limiter,
      );

      const result = engine.evaluate("Bash", "command", "ls");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("Rate limit exceeded");
    });

    it("should skip rate limit rules when no limiter provided", () => {
      const engine = new PolicyEngine({
        rules: [
          rule({
            id: "rate-no-limiter",
            decision: "deny",
            match: {
              tools: ["Bash"],
              rateLimit: { maxCount: 1, windowMs: 60_000 },
            },
          }),
        ],
      });

      // No limiter — rate limit rule is skipped
      const result = engine.evaluate("Bash", "command", "ls");
      expect(result.decision).toBe("allow");
    });

    it("should use category key for category-based rate limits", () => {
      const limiter = new RateLimiter();
      const key = "ratelimit:net-rate:category:network";
      for (let i = 0; i < 2; i++) limiter.record(key);

      const engine = new PolicyEngine(
        {
          rules: [
            rule({
              id: "net-rate",
              decision: "warn",
              match: {
                categories: ["network"],
                rateLimit: { maxCount: 2, windowMs: 60_000 },
              },
            }),
          ],
        },
        limiter,
      );

      const result = engine.evaluate("WebFetch", "network", "https://example.com");
      expect(result.decision).toBe("warn");
      expect(result.matchedRule?.id).toBe("net-rate");
    });

    it("should not match rate limit rule when tool does not match", () => {
      const limiter = new RateLimiter();
      const key = "ratelimit:bash-rate:tool:Bash";
      for (let i = 0; i < 5; i++) limiter.record(key);

      const engine = new PolicyEngine(
        {
          rules: [
            rule({
              id: "bash-rate",
              decision: "deny",
              match: {
                tools: ["Bash"],
                rateLimit: { maxCount: 3, windowMs: 60_000 },
              },
            }),
          ],
        },
        limiter,
      );

      // Read doesn't match the tool criterion
      const result = engine.evaluate("Read", "file_read", "/foo");
      expect(result.decision).toBe("allow");
    });
  });
});
