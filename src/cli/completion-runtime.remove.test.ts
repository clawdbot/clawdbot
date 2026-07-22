import { describe, expect, it } from "vitest";
import { removeCompletionBlockFromProfile } from "./completion-runtime.js";

const CACHE = "/home/kng/.openclaw/completions/openclaw.bash";

describe("removeCompletionBlockFromProfile (#112625)", () => {
  it("removes the header + source line block, preserving surrounding user content", () => {
    const content = [
      "# my prompt",
      'export PS1="$ "',
      "",
      "# OpenClaw Completion",
      `[ -f "${CACHE}" ] && source "${CACHE}"`,
      "",
      "alias ll='ls -la'",
    ].join("\n");
    const { next, changed } = removeCompletionBlockFromProfile(content, "openclaw", CACHE);
    expect(changed).toBe(true);
    expect(next).not.toContain("# OpenClaw Completion");
    expect(next).not.toContain(CACHE);
    expect(next).toContain("# my prompt");
    expect(next).toContain("alias ll='ls -la'");
  });

  it("removes a stray completion source line even without the header", () => {
    const content = ["# user", `source "${CACHE}"`, "# more"].join("\n");
    const { next, changed } = removeCompletionBlockFromProfile(content, "openclaw", CACHE);
    expect(changed).toBe(true);
    expect(next).not.toContain(CACHE);
    expect(next).toContain("# user");
    expect(next).toContain("# more");
  });

  it("removes a dynamic `openclaw completion` source line", () => {
    const content = ["setup", 'source <(openclaw completion bash)', "done"].join("\n");
    const { next, changed } = removeCompletionBlockFromProfile(content, "openclaw", null);
    expect(changed).toBe(true);
    expect(next).not.toContain("openclaw completion");
    expect(next).toContain("setup");
    expect(next).toContain("done");
  });

  it("is a no-op when there is no OpenClaw block", () => {
    const content = ["# just a user file", 'export PATH="$HOME/bin:$PATH"'].join("\n");
    const { next, changed } = removeCompletionBlockFromProfile(content, "openclaw", CACHE);
    expect(changed).toBe(false);
    expect(next).toBe(content);
  });

  it("does not touch a user comment that merely mentions openclaw", () => {
    const content = ["# reminder: install openclaw later", "echo hi"].join("\n");
    const { next, changed } = removeCompletionBlockFromProfile(content, "openclaw", CACHE);
    expect(changed).toBe(false);
    expect(next).toBe(content);
  });

  it("empties a profile that held only the completion block", () => {
    const content = ["# OpenClaw Completion", `[ -f "${CACHE}" ] && source "${CACHE}"`, ""].join(
      "\n",
    );
    const { next } = removeCompletionBlockFromProfile(content, "openclaw", CACHE);
    expect(next).toBe("");
  });

  it("is idempotent", () => {
    const content = ["a", "# OpenClaw Completion", `source "${CACHE}"`, "b"].join("\n");
    const once = removeCompletionBlockFromProfile(content, "openclaw", CACHE).next;
    const twice = removeCompletionBlockFromProfile(once, "openclaw", CACHE);
    expect(twice.changed).toBe(false);
    expect(twice.next).toBe(once);
  });
});
