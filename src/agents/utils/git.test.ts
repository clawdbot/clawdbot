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

  it("parses refs from hosted, scp-style, and generic shorthand sources", () => {
    expect(parseGitUrl("git:https://github.com/openclaw/example-plugin.git@v1.2.3")).toMatchObject({
      host: "github.com",
      path: "openclaw/example-plugin",
      repo: "https://github.com/openclaw/example-plugin.git",
      ref: "v1.2.3",
      pinned: true,
    });
    expect(parseGitUrl("git:git@github.com:openclaw/example-plugin.git@feature/foo")).toMatchObject(
      {
        host: "github.com",
        path: "openclaw/example-plugin",
        repo: "git@github.com:openclaw/example-plugin.git",
        ref: "feature/foo",
        pinned: true,
      },
    );
    expect(parseGitUrl("git:example.com/openclaw/example-plugin@main")).toMatchObject({
      host: "example.com",
      path: "openclaw/example-plugin",
      repo: "https://example.com/openclaw/example-plugin",
      ref: "main",
      pinned: true,
    });
  });

  it("rejects repository paths that could escape managed checkout roots", () => {
    expect(parseGitUrl("git:https://example.com/openclaw/../outside")).toBeNull();
    expect(parseGitUrl("git:git@example.com:openclaw/../outside")).toBeNull();
    expect(parseGitUrl("git:example.com/openclaw/./outside")).toBeNull();
  });
});
