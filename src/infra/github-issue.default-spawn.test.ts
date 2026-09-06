import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGithubIssue, submitGithubIssue } from "./github-issue.js";

describe("submitGithubIssue default GitHub CLI spawn", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a prefilled handoff when gh is absent from PATH", async () => {
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-gh-"));
    try {
      // This test intentionally reaches the real default spawn with a private empty PATH.
      // Every positive issue-creation test injects or mocks the transport instead.
      vi.stubEnv("VITEST", undefined);
      vi.stubEnv("NODE_ENV", undefined);
      vi.stubEnv("PATH", emptyPath);
      const title = "Update failure: test";
      const body = "sanitized body";
      const issue = prepareGithubIssue({ title, body });
      expect(issue.browserFallback.status).toBe("available");
      const result = await submitGithubIssue(issue);
      expect(result).toEqual({
        reason: "cli-unavailable",
        status: "browser-fallback",
        ...(issue.browserFallback.status === "available" ? { url: issue.browserFallback.url } : {}),
      });
    } finally {
      await fs.rm(emptyPath, { force: true, recursive: true });
    }
  });
});
