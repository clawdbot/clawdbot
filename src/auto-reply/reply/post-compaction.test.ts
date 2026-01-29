import { describe, expect, it } from "vitest";

import {
  DEFAULT_POST_COMPACTION_PROMPT,
  DEFAULT_POST_COMPACTION_SYSTEM_PROMPT,
  resolvePostCompactionSettings,
  shouldRunPostCompaction,
} from "./post-compaction.js";

describe("post-compaction settings", () => {
  it("defaults to enabled with fallback prompt and system prompt", () => {
    const settings = resolvePostCompactionSettings();
    expect(settings).not.toBeNull();
    expect(settings?.enabled).toBe(true);
    expect(settings?.prompt.length).toBeGreaterThan(0);
    expect(settings?.systemPrompt.length).toBeGreaterThan(0);
  });

  it("respects disable flag", () => {
    expect(
      resolvePostCompactionSettings({
        agents: {
          defaults: { compaction: { postCompaction: { enabled: false } } },
        },
      }),
    ).toBeNull();
  });

  it("uses default prompts when not configured", () => {
    const settings = resolvePostCompactionSettings();
    expect(settings?.prompt).toContain("Compaction completed");
    expect(settings?.systemPrompt).toContain("Post-compaction recovery turn");
  });

  it("appends NO_REPLY hint when missing", () => {
    const settings = resolvePostCompactionSettings({
      agents: {
        defaults: {
          compaction: {
            postCompaction: {
              prompt: "Recovery turn now.",
              systemPrompt: "Check memory.",
            },
          },
        },
      },
    });
    expect(settings?.prompt).toContain("NO_REPLY");
    expect(settings?.systemPrompt).toContain("NO_REPLY");
  });

  it("preserves NO_REPLY hint when already present", () => {
    const settings = resolvePostCompactionSettings({
      agents: {
        defaults: {
          compaction: {
            postCompaction: {
              prompt: "Recovery turn. Reply NO_REPLY if nothing needed.",
              systemPrompt: "Check memory. Use NO_REPLY when appropriate.",
            },
          },
        },
      },
    });
    // Should not double-append the hint
    const promptHintCount = (settings?.prompt.match(/NO_REPLY/g) || []).length;
    const systemHintCount = (settings?.systemPrompt.match(/NO_REPLY/g) || []).length;
    expect(promptHintCount).toBe(1);
    expect(systemHintCount).toBe(1);
  });
});

describe("shouldRunPostCompaction", () => {
  it("requires memoryCompactionCompleted to be true", () => {
    expect(
      shouldRunPostCompaction({
        entry: { compactionCount: 1 },
        memoryCompactionCompleted: false,
      }),
    ).toBe(false);
  });

  it("runs when compaction just completed", () => {
    expect(
      shouldRunPostCompaction({
        entry: { compactionCount: 1 },
        memoryCompactionCompleted: true,
      }),
    ).toBe(true);
  });

  it("skips when entry is missing but compaction completed", () => {
    expect(
      shouldRunPostCompaction({
        entry: undefined,
        memoryCompactionCompleted: true,
      }),
    ).toBe(true); // Should still run even without entry
  });

  it("skips when already ran for current compaction count", () => {
    expect(
      shouldRunPostCompaction({
        entry: {
          compactionCount: 2,
          postCompactionCompactionCount: 2,
        },
        memoryCompactionCompleted: true,
      }),
    ).toBe(false);
  });

  it("runs when compaction count increased since last post-compaction", () => {
    expect(
      shouldRunPostCompaction({
        entry: {
          compactionCount: 3,
          postCompactionCompactionCount: 2,
        },
        memoryCompactionCompleted: true,
      }),
    ).toBe(true);
  });

  it("runs on first compaction when postCompactionCompactionCount is undefined", () => {
    expect(
      shouldRunPostCompaction({
        entry: {
          compactionCount: 1,
        },
        memoryCompactionCompleted: true,
      }),
    ).toBe(true);
  });
});

describe("default prompts", () => {
  it("DEFAULT_POST_COMPACTION_PROMPT includes memory file reference", () => {
    expect(DEFAULT_POST_COMPACTION_PROMPT).toContain("memory/YYYY-MM-DD.md");
  });

  it("DEFAULT_POST_COMPACTION_SYSTEM_PROMPT mentions memory files", () => {
    expect(DEFAULT_POST_COMPACTION_SYSTEM_PROMPT).toContain("memory files");
  });
});
