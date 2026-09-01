// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  extractQueryTerms,
  filterSessionsByQuery,
  parseToolSummary,
  toUsageErrorMessage,
} from "./helpers.ts";

function requireFirstTool(tools: Array<[string, number]>): [string, number] {
  const tool = tools[0];
  if (!tool) {
    throw new Error("expected parsed tool summary entry");
  }
  return tool;
}

describe("usage-helpers", () => {
  it("redacts secrets in displayed usage failures", () => {
    expect(toUsageErrorMessage(new Error("OPENAI_API_KEY=sk-1234567890abcdef"))).toBe(
      "OPENAI_API_KEY=sk-123...cdef",
    );
  });

  it("tokenizes query terms including quoted strings", () => {
    const terms = extractQueryTerms(
      'agent:main "model:gpt-5.2" label:"Team Planning" "free phrase" has:errors',
    );
    expect(terms).toEqual([
      { key: "agent", value: "main", raw: "agent:main" },
      { key: "model", value: "gpt-5.2", raw: "model:gpt-5.2" },
      { key: "label", value: "Team Planning", raw: 'label:"Team Planning"' },
      { value: "free phrase", raw: '"free phrase"' },
      { key: "has", value: "errors", raw: "has:errors" },
    ]);
  });

  it("matches quoted multi-word session labels", () => {
    const session = { key: "planning", label: "Team Planning", usage: null };

    expect(filterSessionsByQuery([session], 'label:"Team Planning"').sessions).toEqual([session]);
    expect(filterSessionsByQuery([session], '"Team Planning"').sessions).toEqual([session]);
  });

  it("unions categorical values while intersecting categories and other constraints", () => {
    const sessions = [
      {
        key: "openai",
        channel: "discord",
        modelProvider: "openai",
        model: "gpt",
        usage: {
          totalTokens: 100,
          messageCounts: { errors: 1 },
          toolUsage: { totalCalls: 1, tools: [{ name: "read" }] },
        },
      },
      {
        key: "anthropic",
        channel: "slack",
        modelProvider: "anthropic",
        model: "claude",
        usage: {
          totalTokens: 80,
          messageCounts: { errors: 0 },
          toolUsage: { totalCalls: 1, tools: [{ name: "write" }] },
        },
      },
      {
        key: "google",
        channel: "discord",
        modelProvider: "google",
        model: "gemini",
        usage: {
          totalTokens: 60,
          messageCounts: { errors: 1 },
          toolUsage: { totalCalls: 1, tools: [{ name: "read" }] },
        },
      },
    ];
    const cases: Array<[query: string, keys: string[]]> = [
      ["provider:openai provider:anthropic", ["openai", "anthropic"]],
      ["provider: provider:openai", ["openai"]],
      ["channel:discord channel:slack", ["openai", "anthropic", "google"]],
      ["model:gpt model:claude", ["openai", "anthropic"]],
      ["tool:read tool:write", ["openai", "anthropic", "google"]],
      ["provider:openai provider:anthropic channel:discord", ["openai"]],
      ["provider:openai provider:anthropic minTokens:90 has:errors has:tools", ["openai"]],
      ["minTokens:50 minTokens:90", ["openai"]],
      ["has:errors has:tools", ["openai", "google"]],
    ];

    for (const [query, keys] of cases) {
      expect(filterSessionsByQuery(sessions, query).sessions.map((session) => session.key)).toEqual(
        keys,
      );
    }
  });

  it("matches key: glob filters against session keys", () => {
    const session = {
      key: "agent:main:cron:16234bc?token=dev-token",
      label: "agent:main:cron:16234bc?token=dev-token",
      usage: { totalTokens: 100, totalCost: 0 },
    };
    const matches = filterSessionsByQuery([session], "key:agent:main:cron*");
    expect(matches.sessions).toEqual([session]);
  });

  it("supports numeric filters like minTokens/maxTokens", () => {
    const a = {
      key: "a",
      usage: { totalTokens: 100, totalCost: 20, messageCounts: { total: 30 } },
    };
    const b = {
      key: "b",
      usage: { totalTokens: 5, totalCost: 2, messageCounts: { total: 3 } },
    };
    const filters = [
      "minTokens:10",
      "minCost:10",
      "minMessages:10",
      "maxTokens:10",
      "maxCost:10",
      "maxMessages:10",
    ];

    for (const filter of filters.slice(0, 3)) {
      const result = filterSessionsByQuery([a, b], filter);
      expect(result.sessions).toEqual([a]);
      expect(result.warnings).toEqual([]);
    }
    for (const filter of filters.slice(3)) {
      const result = filterSessionsByQuery([a, b], filter);
      expect(result.sessions).toEqual([b]);
      expect(result.warnings).toEqual([]);
    }
  });

  it("supports every has predicate and warns on unknown values", () => {
    const populated = {
      key: "populated",
      hasContextWeight: true,
      modelProvider: "openai",
      model: "gpt-5.2",
      usage: {
        messageCounts: { errors: 1 },
        toolUsage: { totalCalls: 1 },
      },
    };
    const empty = { key: "empty", usage: null };

    for (const value of ["tools", "errors", "context", "usage", "model", "provider"]) {
      const result = filterSessionsByQuery([populated, empty], `has:${value}`);
      expect(result.sessions).toEqual([populated]);
      expect(result.warnings).toEqual([]);
    }
    expect(filterSessionsByQuery([populated, empty], "has:__proto__")).toEqual({
      sessions: [populated, empty],
      warnings: ["Unknown has:__proto__"],
    });
  });

  it("rejects non-decimal numeric filter values", () => {
    const session = { key: "a", usage: { totalTokens: 10_000, totalCost: 0 } };

    expect(filterSessionsByQuery([session], "minTokens:1k").sessions).toEqual([session]);
    expect(filterSessionsByQuery([session], "minTokens:1e3").warnings).toEqual([
      "Invalid number for minTokens",
    ]);
    expect(filterSessionsByQuery([session], "minTokens:0x1000").warnings).toEqual([
      "Invalid number for minTokens",
    ]);
    expect(filterSessionsByQuery([session], "minTokens:9007199254740993").warnings).toEqual([
      "Invalid number for minTokens",
    ]);
  });

  it("warns on unknown keys and invalid numbers", () => {
    const session = { key: "a", usage: { totalTokens: 10, totalCost: 0 } };
    const res = filterSessionsByQuery([session], "__proto__:1 minTokens:wat");
    expect(res.warnings).toEqual(["Unknown filter: __proto__", "Invalid number for minTokens"]);
  });

  it("parses tool summaries from compact session logs", () => {
    const res = parseToolSummary(
      "[Tool: read]\n[Tool Result]\n[Tool: exec]\n[Tool: read]\n[Tool Result]",
    );
    expect(res.summary).toBe("Tools: read×2, exec×1 (3 calls)");
    expect(res.cleanContent).toBe("");
    const firstTool = requireFirstTool(res.tools);
    expect(firstTool[0]).toBe("read");
    expect(firstTool[1]).toBe(2);
  });
});
