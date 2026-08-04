import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  classifyQueryComplexity,
  describeComplexityReason,
  resolveTieredModel,
  resolveTieringConfig,
  type TieringConfig,
} from "./model-tiering.js";

describe("classifyQueryComplexity", () => {
  describe("simple queries", () => {
    it("classifies greetings as simple", () => {
      expect(classifyQueryComplexity("hi")).toBe("simple");
      expect(classifyQueryComplexity("hello")).toBe("simple");
      expect(classifyQueryComplexity("hey!")).toBe("simple");
      expect(classifyQueryComplexity("good morning")).toBe("simple");
      expect(classifyQueryComplexity("Good afternoon!")).toBe("simple");
    });

    it("classifies acknowledgments as simple", () => {
      expect(classifyQueryComplexity("thanks")).toBe("simple");
      expect(classifyQueryComplexity("thank you!")).toBe("simple");
      expect(classifyQueryComplexity("ok")).toBe("simple");
      expect(classifyQueryComplexity("got it")).toBe("simple");
      expect(classifyQueryComplexity("cool")).toBe("simple");
    });

    it("classifies yes/no responses as simple", () => {
      expect(classifyQueryComplexity("yes")).toBe("simple");
      expect(classifyQueryComplexity("no")).toBe("simple");
      expect(classifyQueryComplexity("yep")).toBe("simple");
      expect(classifyQueryComplexity("nope")).toBe("simple");
    });

    it("classifies empty/very short queries as simple", () => {
      expect(classifyQueryComplexity("")).toBe("simple");
      expect(classifyQueryComplexity("  ")).toBe("simple");
      expect(classifyQueryComplexity("hi")).toBe("simple");
    });

    it("classifies short non-matching queries as simple", () => {
      expect(classifyQueryComplexity("what's up")).toBe("simple");
      expect(classifyQueryComplexity("how are you")).toBe("simple");
    });
  });

  describe("complex queries", () => {
    it("classifies code writing requests as complex", () => {
      expect(classifyQueryComplexity("write a function to sort an array")).toBe("complex");
      expect(classifyQueryComplexity("create a class for handling user authentication")).toBe(
        "complex",
      );
      expect(classifyQueryComplexity("implement an API endpoint for user registration")).toBe(
        "complex",
      );
    });

    it("classifies debugging requests as complex", () => {
      expect(classifyQueryComplexity("debug this code and fix the error")).toBe("complex");
      expect(classifyQueryComplexity("fix the bug in the login function")).toBe("complex");
      expect(classifyQueryComplexity("refactor this code to be more efficient")).toBe("complex");
    });

    it("classifies multi-step reasoning as complex", () => {
      expect(classifyQueryComplexity("let's think step by step about this problem")).toBe(
        "complex",
      );
      expect(classifyQueryComplexity("break down the algorithm into smaller parts")).toBe(
        "complex",
      );
      expect(classifyQueryComplexity("what are the pros and cons of this approach")).toBe(
        "complex",
      );
    });

    it("classifies long-form content requests as complex", () => {
      expect(classifyQueryComplexity("write an essay about climate change")).toBe("complex");
      expect(classifyQueryComplexity("draft a proposal for the new feature")).toBe("complex");
      expect(classifyQueryComplexity("summarize this article about AI")).toBe("complex");
    });

    it("classifies system operations as complex", () => {
      expect(classifyQueryComplexity("run npm install")).toBe("complex");
      expect(classifyQueryComplexity("execute the tests")).toBe("complex");
      expect(classifyQueryComplexity("deploy to production")).toBe("complex");
      expect(classifyQueryComplexity("git commit the changes")).toBe("complex");
    });

    it("classifies queries with code blocks as complex", () => {
      const queryWithCode =
        "explain this code:\n```javascript\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\n```";
      expect(classifyQueryComplexity(queryWithCode)).toBe("complex");
    });

    it("classifies long queries as complex", () => {
      const longQuery = "a".repeat(501);
      expect(classifyQueryComplexity(longQuery)).toBe("complex");
    });

    it("classifies queries with multiple question words as complex", () => {
      expect(classifyQueryComplexity("what is the best way to explain how this works")).toBe(
        "complex",
      );
      expect(classifyQueryComplexity("why does this happen and how can we fix it")).toBe("complex");
    });
  });

  describe("with custom config", () => {
    it("respects custom length threshold", () => {
      const config: TieringConfig = {
        enabled: true,
        complexLengthThreshold: 100,
      };
      const query = "a".repeat(101);
      expect(classifyQueryComplexity(query, config)).toBe("complex");

      const shorterQuery = "a".repeat(50);
      expect(classifyQueryComplexity(shorterQuery, config)).toBe("simple");
    });

    it("respects custom complex patterns", () => {
      const config: TieringConfig = {
        enabled: true,
        complexPatterns: ["secret.*pattern", "magic.*word"],
      };
      expect(classifyQueryComplexity("this has a secret custom pattern", config)).toBe("complex");
      expect(classifyQueryComplexity("use the magic word please", config)).toBe("complex");
      expect(classifyQueryComplexity("normal query", config)).toBe("simple");
    });

    it("ignores invalid regex patterns", () => {
      const config: TieringConfig = {
        enabled: true,
        complexPatterns: ["[invalid(regex"],
      };
      // Should not throw, just skip the invalid pattern
      expect(classifyQueryComplexity("test query", config)).toBe("simple");
    });

    it("only scans the head of very long input for complex patterns", () => {
      // A high threshold keeps long input in the classifier; the pattern sweep
      // is still bounded, so a keyword past the scan limit is not detected.
      const config: TieringConfig = { enabled: true, complexLengthThreshold: 100_000 };
      const padding = "z ".repeat(3_000);
      expect(classifyQueryComplexity(`npm install ${padding}`, config)).toBe("complex");
      expect(classifyQueryComplexity(`${padding} npm install`, config)).toBe("simple");
    });
  });
});

describe("resolveTieringConfig", () => {
  it("returns null when model config is missing", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveTieringConfig(cfg)).toBeNull();
  });

  it("returns null when model config is a string", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-3",
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveTieringConfig(cfg)).toBeNull();
  });

  it("returns null when tiering is not enabled", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-3",
            tiering: {
              enabled: false,
              simple: "ollama/llama3.3",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveTieringConfig(cfg)).toBeNull();
  });

  it("returns tiering config when enabled", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-3",
            tiering: {
              enabled: true,
              simple: "ollama/llama3.3",
              complexLengthThreshold: 300,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveTieringConfig(cfg);
    expect(result).toEqual({
      enabled: true,
      simple: "ollama/llama3.3",
      complexLengthThreshold: 300,
    });
  });
});

function tieringCfg(tiering: unknown): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-3", tiering },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("resolveTieredModel", () => {
  it("returns null when tiering is disabled", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-3",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveTieredModel({
      cfg,
      query: "hello",
      defaultProvider: "anthropic",
    });
    expect(result).toBeNull();
  });

  it("returns simple model for simple queries", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-3",
            tiering: {
              enabled: true,
              simple: "ollama/llama3.3",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveTieredModel({
      cfg,
      query: "hello",
      defaultProvider: "anthropic",
    });
    expect(result).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("returns null for complex queries (use default)", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-3",
            tiering: {
              enabled: true,
              simple: "ollama/llama3.3",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveTieredModel({
      cfg,
      query: "write a function to implement binary search",
      defaultProvider: "anthropic",
    });
    expect(result).toBeNull();
  });

  it("returns null when no simple model is configured", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-3",
            tiering: {
              enabled: true,
              // No simple model configured
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveTieredModel({
      cfg,
      query: "hello",
      defaultProvider: "anthropic",
    });
    expect(result).toBeNull();
  });

  it("does not override a deliberately chosen model", () => {
    const result = resolveTieredModel({
      cfg: tieringCfg({ enabled: true, simple: "ollama/llama3.3" }),
      query: "hello",
      defaultProvider: "anthropic",
      explicitModel: true,
    });
    expect(result).toBeNull();
  });

  it("resolves the simple model through model aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: { "ollama/llama3.3": { alias: "cheap" } },
          model: {
            primary: "anthropic/claude-3",
            tiering: { enabled: true, simple: "cheap" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveTieredModel({
      cfg,
      query: "hello",
      defaultProvider: "anthropic",
    });
    expect(result).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("refuses a simple model outside the allowlist", () => {
    const result = resolveTieredModel({
      cfg: tieringCfg({ enabled: true, simple: "ollama/llama3.3" }),
      query: "hello",
      defaultProvider: "anthropic",
      allowedModelKeys: new Set(["anthropic/claude-3"]),
    });
    expect(result).toBeNull();
  });

  it("accepts a simple model inside the allowlist", () => {
    const result = resolveTieredModel({
      cfg: tieringCfg({ enabled: true, simple: "ollama/llama3.3" }),
      query: "hello",
      defaultProvider: "anthropic",
      allowedModelKeys: new Set(["anthropic/claude-3", "ollama/llama3.3"]),
    });
    expect(result).toEqual({ provider: "ollama", model: "llama3.3" });
  });
});

describe("per-agent tiering", () => {
  function cfgWithAgent(agentTiering: unknown, globalTiering?: unknown): OpenClawConfig {
    return {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-3",
            ...(globalTiering ? { tiering: globalTiering } : undefined),
          },
        },
        list: [{ id: "scribe", model: { tiering: agentTiering } }],
      },
    } as unknown as OpenClawConfig;
  }

  it("enables tiering for one agent without any global config", () => {
    const cfg = cfgWithAgent({ enabled: true, simple: "ollama/llama3.3" });
    expect(
      resolveTieredModel({ cfg, agentId: "scribe", query: "hi", defaultProvider: "anthropic" }),
    ).toEqual({ provider: "ollama", model: "llama3.3" });
    // Other agents are unaffected.
    expect(
      resolveTieredModel({ cfg, agentId: "other", query: "hi", defaultProvider: "anthropic" }),
    ).toBeNull();
  });

  it("merges per-agent fields over the global tiering config", () => {
    const cfg = cfgWithAgent(
      { simple: "ollama/mistral" },
      { enabled: true, simple: "ollama/llama3.3", complexLengthThreshold: 42 },
    );
    expect(resolveTieringConfig(cfg, "scribe")).toEqual({
      enabled: true,
      simple: "ollama/mistral",
      complexLengthThreshold: 42,
    });
  });

  it("lets an agent opt out of global tiering", () => {
    const cfg = cfgWithAgent({ enabled: false }, { enabled: true, simple: "ollama/llama3.3" });
    expect(resolveTieringConfig(cfg, "scribe")).toBeNull();
    expect(resolveTieringConfig(cfg)).not.toBeNull();
  });
});

describe("describeComplexityReason", () => {
  it("returns length reason for long queries", () => {
    const longQuery = "a".repeat(501);
    const reason = describeComplexityReason(longQuery);
    expect(reason).toBe("Query length exceeds 500 characters");
  });

  it("returns pattern match for code requests", () => {
    const reason = describeComplexityReason("write a function for authentication");
    expect(reason).toContain("Matches complex pattern");
  });

  it("returns question word count reason", () => {
    const reason = describeComplexityReason("what is the best way to explain something");
    expect(reason).toContain("question/explanation words");
  });

  it("returns null for simple queries", () => {
    const reason = describeComplexityReason("hello");
    expect(reason).toBeNull();
  });
});
