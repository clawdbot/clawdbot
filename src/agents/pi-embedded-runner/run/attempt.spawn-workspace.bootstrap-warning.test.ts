import { describe, expect, it } from "vitest";
import {
  analyzeBootstrapBudget,
  buildBootstrapPromptWarningNotice,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt bootstrap warning prompt assembly", () => {
  it("keeps bootstrap warnings in system context without raw diagnostics", () => {
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/openclaw-warning-workspace/AGENTS.md",
            content: "A".repeat(200),
            missing: false,
          },
        ],
        injectedFiles: [{ path: "AGENTS.md", content: "A".repeat(20) }],
      }),
      bootstrapMaxChars: 50,
      bootstrapTotalMaxChars: 50,
    });
    const warning = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const notice = buildBootstrapPromptWarningNotice(warning.lines);
    const systemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: "base system prompt",
      prependSystemContext: "hook context",
      appendSystemContext: notice,
    });

    expect(systemPrompt).toContain("hook context");
    expect(systemPrompt).toContain("[Bootstrap truncation warning]");
    expect(systemPrompt).toContain("Treat Project Context as partial");
    expect(systemPrompt).not.toContain("- AGENTS.md: 200 raw -> 20 injected");
    expect(systemPrompt).toContain("base system prompt");
  });
});
