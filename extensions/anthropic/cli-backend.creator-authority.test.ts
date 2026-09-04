import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

describe("Claude CLI cron creator authority", () => {
  it("projects native tools into canonical OpenClaw capabilities", () => {
    const project = buildAnthropicCliBackend().projectNativeToolAuthority;

    expect(project?.(undefined)).toEqual([
      "read",
      "write",
      "edit",
      "exec",
      "web_fetch",
      "web_search",
    ]);
    expect(project?.(["Read", "Grep", "Glob"])).toEqual(["read"]);
    expect(project?.(["Write"])).toEqual(["write"]);
    // Edit-family tools are file edits only; apply_patch is a distinct capability.
    expect(project?.(["Edit", "MultiEdit", "NotebookEdit"])).toEqual(["edit"]);
    // Background Bash is disallowed at launch, so Bash never yields process.
    expect(project?.(["Bash", "Bash(git:*)"])).toEqual(["exec"]);
    expect(project?.(["WebSearch", "WebFetch"])).toEqual(["web_fetch", "web_search"]);
    expect(project?.(["Task", "TodoWrite"])).toEqual([]);
    expect(project?.([])).toEqual([]);
  });
});
