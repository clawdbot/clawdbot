import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("model tiering config schema", () => {
  it("accepts tiering under agents.defaults.model", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            tiering: {
              enabled: true,
              simple: "ollama/llama3.3",
              complexPatterns: ["\\bspecial\\b.*\\bkeyword\\b"],
              complexLengthThreshold: 300,
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts per-agent tiering under agents.list[].model", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        list: [
          {
            id: "scribe",
            model: {
              primary: "anthropic/claude-sonnet-4-5",
              tiering: { enabled: true, simple: "ollama/llama3.3" },
            },
          },
        ],
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects an uncompilable complexPatterns entry", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          model: {
            tiering: { enabled: true, complexPatterns: ["ok", "[invalid(regex"] },
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((entry) => entry.path.includes("complexPatterns"));
      expect(issue?.path).toEqual(["agents", "defaults", "model", "tiering", "complexPatterns", 1]);
      expect(issue?.message).toContain("Invalid regular expression");
    }
  });

  it("rejects unknown tiering fields", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          model: { tiering: { enabled: true, simpel: "ollama/llama3.3" } },
        },
      },
    });

    expect(res.success).toBe(false);
  });
});
