import { describe, expect, it } from "vitest";
import {
  createPluginToolMatcherScope,
  normalizePluginToolMatcher,
  pluginToolMatcherCoversTool,
} from "./tool-hook-matcher.js";

describe("plugin tool hook matchers", () => {
  it("normalizes canonical OpenClaw tool ids without provider alias expansion", () => {
    expect(normalizePluginToolMatcher([" EXEC ", "apply_patch", "exec"])).toEqual([
      "apply_patch",
      "exec",
    ]);
    expect(pluginToolMatcherCoversTool(["exec"], "exec")).toBe(true);
    expect(pluginToolMatcherCoversTool(["exec"], "Bash")).toBe(false);
    expect(pluginToolMatcherCoversTool(["apply_patch"], "Write")).toBe(false);
    expect(pluginToolMatcherCoversTool(["spawn_agent"], "Agent")).toBe(false);
  });

  it.each(["Bash", "exec_command", "apply-patch", "Write", "Edit", "Agent"])(
    "rejects non-canonical provider spelling %s",
    (toolName) => {
      expect(() => normalizePluginToolMatcher([toolName])).toThrow(
        "tool hook matcher entries must use canonical OpenClaw tool ids",
      );
    },
  );

  it("keeps only an omitted matcher as match-all", () => {
    expect(pluginToolMatcherCoversTool(undefined, "web_search")).toBe(true);
    expect(createPluginToolMatcherScope([undefined])).toEqual({
      matchAll: true,
      toolNames: [],
    });
  });

  it("rejects non-array matchers with a registration-safe diagnostic", () => {
    for (const matcher of ["exec", null, false, 0, Number.NaN, ""] as const) {
      expect(() => normalizePluginToolMatcher(matcher as never)).toThrow(
        "tool hook matcher must be an array of tool names",
      );
    }
    expect(() => normalizePluginToolMatcher([])).toThrow(
      "tool hook matcher must contain at least one tool name",
    );
    expect(() => normalizePluginToolMatcher([42] as never)).toThrow(
      "tool hook matcher entries must be non-empty strings",
    );
    expect(() => normalizePluginToolMatcher([" "])).toThrow(
      "tool hook matcher entries must be non-empty strings",
    );
    expect(() => normalizePluginToolMatcher(["*"])).toThrow(
      "tool hook matcher wildcard entries are not supported",
    );
  });

  it("rejects sparse matchers instead of widening relay selection", () => {
    const sparseMatcher: string[] = [];
    sparseMatcher.length = 1;

    expect(() => normalizePluginToolMatcher(sparseMatcher)).toThrow(
      "tool hook matcher entries must be non-empty strings",
    );
    expect(() => createPluginToolMatcherScope([sparseMatcher])).toThrow(
      "tool hook matcher entries must be non-empty strings",
    );
  });
});
