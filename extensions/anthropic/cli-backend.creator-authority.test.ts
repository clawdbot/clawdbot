import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

describe("Claude CLI cron creator authority", () => {
  it("projects native tools into canonical OpenClaw capabilities", () => {
    const project = buildAnthropicCliBackend().projectNativeToolAuthority;

    expect(project?.(["Read", "Write", "Edit", "Bash", "WebFetch", "WebSearch"])).toEqual([
      "read",
      "write",
      "edit",
      "exec",
      "web_fetch",
      "web_search",
    ]);
    expect(project?.(["Read", "Grep"])).toEqual(["read"]);
    expect(project?.(["Write"])).toEqual(["write"]);
    // General file edits do not imply the distinct apply_patch capability.
    expect(project?.(["Edit"])).toEqual(["edit"]);
    // Background Bash is disallowed at launch, so Bash never yields process.
    expect(project?.(["Bash", "Bash(git:*)"])).toEqual(["exec"]);
    expect(project?.(["WebSearch", "WebFetch"])).toEqual(["web_fetch", "web_search"]);
    expect(project?.(["Task", "TodoWrite"])).toEqual([]);
    expect(project?.([])).toEqual([]);
  });

  it.each(["Glob", "NotebookEdit", "Bash(git:*)", "MultiEdit"])(
    "does not project a general capability from non-equivalent native entry %s",
    (nativeTool) => {
      expect(buildAnthropicCliBackend().projectNativeToolAuthority?.([nativeTool])).toEqual([]);
    },
  );
});
