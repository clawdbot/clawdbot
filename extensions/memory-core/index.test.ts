import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import { describe, expect, it } from "vitest";
import {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
import { buildPromptSection } from "./src/prompt-section.js";

describe("buildPromptSection", () => {
  it("returns empty when no memory tools are available", () => {
    expect(buildPromptSection({ availableTools: new Set() })).toEqual([]);
  });

  it("describes the two-step flow when both memory tools are available", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("then use memory_get");
    expect(result[1]).toContain("indexed session transcripts");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("limits the guidance to memory_search when only search is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("indexed session transcripts");
    expect(result[1]).not.toContain("then use memory_get");
  });

  it("limits the guidance to memory_get when only get is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_get"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_get");
    expect(result[1]).not.toContain("run memory_search");
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });
});

describe("buildMemoryFlushPlan", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store durable notes in memory/YYYY-MM-DD.md",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("memory/2026-02-16.md");
    expect(plan?.prompt).toContain(
      "Current time: Monday, February 16th, 2026 - 10:00 AM (America/New_York) / 2026-02-16 15:00 UTC",
    );
    expect(plan?.relativePath).toBe("memory/2026-02-16.md");
  });

  it("does not append a duplicate current time line", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store notes.\nCurrent time: already present",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("Current time: already present");
    expect((plan?.prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("defaults to safe prompts and gating values", () => {
    const plan = buildMemoryFlushPlan();
    expect(plan).not.toBeNull();
    expect(plan?.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(plan?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(plan?.prompt).toContain("memory/");
    expect(plan?.prompt).toContain("MEMORY.md");
    expect(plan?.systemPrompt).toContain("MEMORY.md");
  });

  it("respects disable flag", () => {
    expect(
      buildMemoryFlushPlan({
        cfg: {
          agents: {
            defaults: { compaction: { memoryFlush: { enabled: false } } },
          },
        },
      }),
    ).toBeNull();
  });

  it("falls back to defaults when numeric values are invalid", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: Number.NaN,
              memoryFlush: {
                softThresholdTokens: -100,
              },
            },
          },
        },
      },
    });

    expect(plan?.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(plan?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(plan?.reserveTokensFloor).toBe(20_000);
  });

  it("parses forceFlushTranscriptBytes from byte-size strings", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                forceFlushTranscriptBytes: "3mb",
              },
            },
          },
        },
      },
    });

    expect(plan?.forceFlushTranscriptBytes).toBe(3 * 1024 * 1024);
  });

  it("keeps overwrite guards in the default prompt", () => {
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toMatch(/APPEND/i);
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("do not overwrite");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("timestamped variant");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("YYYY-MM-DD.md");
  });
});
