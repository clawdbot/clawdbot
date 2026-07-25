import { describe, expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../config/sessions/types.ts";
import { buildContextUsageBreakdown } from "./context-usage-breakdown.ts";
import { countTextTokens, resolveTokenEncoding } from "./token-counter.ts";

describe("resolveTokenEncoding", () => {
  it("maps openai gpt-5 family to o200k", () => {
    expect(resolveTokenEncoding({ provider: "openai", model: "gpt-5.5" }).encoding).toBe(
      "o200k_base",
    );
  });

  it("marks custom/qwen models approximate", () => {
    const resolved = resolveTokenEncoding({
      provider: "custom-llm-api-vdineapp-com",
      model: "Qwen3.6-27b",
    });
    expect(resolved.encoding).toBe("o200k_base");
    expect(resolved.approximate).toBe(true);
  });
});

describe("countTextTokens", () => {
  it("counts a stable hello-world string", () => {
    const counted = countTextTokens("hello world", { encoding: "o200k_base" });
    expect(counted.tokens).toBeGreaterThan(0);
    expect(counted.approximate).toBe(false);
  });
});

describe("buildContextUsageBreakdown", () => {
  const report: SessionSystemPromptReport = {
    source: "run",
    generatedAt: 1,
    provider: "custom",
    model: "Qwen3.6-27b",
    bootstrapMaxChars: 20_000,
    systemPrompt: {
      chars: 12_000,
      projectContextChars: 4_000,
      nonProjectContextChars: 8_000,
    },
    injectedWorkspaceFiles: [
      {
        name: "AGENTS.md",
        path: "/tmp/AGENTS.md",
        missing: false,
        rawChars: 3_000,
        injectedChars: 3_000,
        truncated: false,
      },
    ],
    skills: {
      promptChars: 1_000,
      entries: [{ name: "demo", blockChars: 1_000 }],
    },
    tools: {
      listChars: 0,
      schemaChars: 2_000,
      entries: [
        { name: "read", summaryChars: 10, schemaChars: 1_500 },
        { name: "mcp_search", summaryChars: 10, schemaChars: 500, source: "mcp" },
      ],
    },
    promptTokenEstimate: {
      encoding: "o200k_base",
      approximate: true,
      system: 1_500,
      tools: 400,
      mcpTools: 120,
      rules: 700,
      skills: 250,
    },
  };

  it("uses promptTokenEstimate buckets and conversation overrides", () => {
    const breakdown = buildContextUsageBreakdown({
      report,
      conversation: {
        user: 100,
        assistant: 100,
        toolResults: 0,
        summaries: 50,
        other: 0,
        runtimeContext: 0,
        modelOnlyPrompt: 0,
      },
      conversationTokenOverrides: { conversation: 2_000, summaries: 300 },
    });
    expect(breakdown.categories.find((c) => c.id === "system")?.tokens).toBe(1_500);
    expect(breakdown.categories.find((c) => c.id === "mcpTools")?.tokens).toBe(120);
    expect(breakdown.categories.find((c) => c.id === "conversation")?.tokens).toBe(2_000);
    expect(breakdown.categories.find((c) => c.id === "summaries")?.tokens).toBe(300);
    expect(breakdown.totalTokens).toBeGreaterThan(2_000);
    expect(breakdown.approximate).toBe(true);
  });
});
