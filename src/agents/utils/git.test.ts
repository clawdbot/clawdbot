import { describe, expect, it } from "vitest";
import { parseGitUrl } from "./git.js";

describe("parseGitUrl", () => {
  it("parses ordinary hosted git sources", () => {
    expect(parseGitUrl("git:github.com/openclaw/example-plugin")).toMatchObject({
      type: "git",
      host: "github.com",
      path: "openclaw/example-plugin",
      repo: "https://github.com/openclaw/example-plugin",
    });
  });

  it("rejects repository paths that could escape managed checkout roots", () => {
    expect(parseGitUrl("git:https://example.com/openclaw/../outside")).toBeNull();
    expect(parseGitUrl("git:git@example.com:openclaw/../outside")).toBeNull();
    expect(parseGitUrl("git:example.com/openclaw/./outside")).toBeNull();
  });
});
