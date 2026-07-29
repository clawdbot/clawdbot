import { describe, expect, it } from "vitest";
import {
  buildCodexNativeToolMatcher,
  createPluginToolMatcherScope,
  normalizePluginToolMatcher,
  pluginToolMatcherCoversTool,
} from "./tool-hook-matcher.js";

describe("plugin tool hook matchers", () => {
  it("uses one canonical alias model for shell and patch tools", () => {
    expect(normalizePluginToolMatcher(["Bash", "exec", "exec_command"])).toEqual(["exec"]);
    expect(normalizePluginToolMatcher(["apply_patch", "Write", "Edit"])).toEqual(["apply_patch"]);
    expect(pluginToolMatcherCoversTool(["exec_command"], "Bash")).toBe(true);
    expect(pluginToolMatcherCoversTool(["Write"], "apply_patch")).toBe(true);
  });

  it("preserves omitted and empty matchers as match-all", () => {
    expect(pluginToolMatcherCoversTool(undefined, "web_search")).toBe(true);
    expect(pluginToolMatcherCoversTool([], "web_search")).toBe(true);
    expect(pluginToolMatcherCoversTool(["*"], "web_search")).toBe(true);
    expect(createPluginToolMatcherScope([undefined])).toEqual({
      matchAll: true,
      toolNames: [],
    });
  });

  it("rejects non-array matchers with a registration-safe diagnostic", () => {
    expect(() => normalizePluginToolMatcher("exec" as never)).toThrow(
      "tool hook matcher must be an array of tool names",
    );
    expect(() => normalizePluginToolMatcher([42] as never)).toThrow(
      "tool hook matcher entries must be non-empty strings",
    );
    expect(() => normalizePluginToolMatcher([" "])).toThrow(
      "tool hook matcher entries must be non-empty strings",
    );
  });

  it("rejects sparse matchers before native relay matcher construction", () => {
    const sparseMatcher: string[] = [];
    sparseMatcher.length = 1;

    expect(() => normalizePluginToolMatcher(sparseMatcher)).toThrow(
      "tool hook matcher entries must be non-empty strings",
    );
    expect(() =>
      buildCodexNativeToolMatcher(createPluginToolMatcherScope([sparseMatcher])),
    ).toThrow("tool hook matcher entries must be non-empty strings");
  });

  it("expands canonical tools to exact Codex matcher alternatives", () => {
    expect(
      buildCodexNativeToolMatcher(createPluginToolMatcherScope([["exec"], ["apply_patch"]])),
    ).toBe("Bash|Edit|Write|apply_patch|exec|exec_command");
  });

  it("anchors names that require a Codex regex", () => {
    expect(buildCodexNativeToolMatcher(createPluginToolMatcherScope([["mcp:tool"]]))).toBe(
      "(?i)^(?:mcp:tool)$",
    );
  });

  it("matches custom native tool names without case-sensitive policy gaps", () => {
    expect(buildCodexNativeToolMatcher(createPluginToolMatcherScope([["Deploy"]]))).toBe(
      "(?i)^(?:deploy)$",
    );
  });
});
