import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
  it("includes promised-work policy in the default prompt only", () => {
    const prompt = buildSystemPrompt({ cwd: "/tmp/workspace" });

    expect(prompt).toContain("## Promised Work");
    expect(prompt).toContain("Progress such as `running` is not completion.");
    expect(prompt.match(/## Promised Work/g)).toHaveLength(1);

    expect(
      buildSystemPrompt({
        cwd: "/tmp/workspace",
        customPrompt: "Custom replacement prompt",
      }),
    ).not.toContain("## Promised Work");
  });
});
