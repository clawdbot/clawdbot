/**
 * Regression coverage for plugin-only tool allowlist analysis.
 * Confirms plugin group expansion and unknown allowlist reporting.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeAllowlistByToolType,
  buildPluginToolGroups,
  type PluginToolGroups,
} from "./tool-policy.js";

const pluginGroups: PluginToolGroups = {
  all: ["lobster", "workflow_tool"],
  byPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
};
const coreTools = new Set(["read", "write", "exec", "session_status"]);

describe("analyzeAllowlistByToolType", () => {
  it("preserves allowlist when it only targets plugin tools", () => {
    const input = { allow: ["lobster"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["lobster"] });
    expect(policy.pluginOnlyAllowlist).toBe(true);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("preserves allowlist when it only targets plugin groups", () => {
    const input = { allow: ["group:plugins"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["group:plugins"] });
    expect(policy.pluginOnlyAllowlist).toBe(true);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it('keeps allowlist when it uses "*"', () => {
    const input = { allow: ["*"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["*"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const input = { allow: ["lobster", "read"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["lobster", "read"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("preserves allowlist with unknown entries when no core tools match", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const input = { allow: ["lobster"] };
    const policy = analyzeAllowlistByToolType(input, emptyPlugins, coreTools);
    expect(input).toEqual({ allow: ["lobster"] });
    expect(policy.pluginOnlyAllowlist).toBe(false);
    expect(policy.unknownAllowlist).toEqual(["lobster"]);
  });

  it("keeps allowlist with core tools and reports unknown entries", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const input = { allow: ["read", "lobster"] };
    const policy = analyzeAllowlistByToolType(input, emptyPlugins, coreTools);
    expect(input).toEqual({ allow: ["read", "lobster"] });
    expect(policy.unknownAllowlist).toEqual(["lobster"]);
  });

  it("does not mark unavailable core entries as plugin-only", () => {
    const policy = analyzeAllowlistByToolType({ allow: ["apply_patch"] }, pluginGroups, coreTools);
    expect(policy.pluginOnlyAllowlist).toBe(false);
    expect(policy.unknownAllowlist).toEqual(["apply_patch"]);
  });

  it("recognizes declared plugin tools before they are materialized", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const input = { allow: ["llm-task"] };
    const policy = analyzeAllowlistByToolType(input, emptyPlugins, coreTools, {
      pluginToolNames: ["llm-task"],
    });
    expect(input).toEqual({ allow: ["llm-task"] });
    expect(policy.pluginOnlyAllowlist).toBe(true);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("recognizes declared MCP server namespace allowlists before tools are materialized", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = analyzeAllowlistByToolType(
      { allow: ["paperless__*", "home-assistant__search"] },
      emptyPlugins,
      coreTools,
      { mcpServerNames: ["paperless", "Home Assistant"] },
    );
    expect(policy.pluginOnlyAllowlist).toBe(true);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("still reports undeclared MCP namespace allowlist typos", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = analyzeAllowlistByToolType(
      { allow: ["papreless__*"] },
      emptyPlugins,
      coreTools,
      { mcpServerNames: ["paperless"] },
    );
    expect(policy.pluginOnlyAllowlist).toBe(false);
    expect(policy.unknownAllowlist).toStrictEqual(["papreless__*"]);
  });

  it("ignores empty plugin ids when building groups", () => {
    const groups = buildPluginToolGroups({
      tools: [{ name: "lobster" }],
      toolMeta: () => ({ pluginId: "" }),
    });
    expect(groups.all).toEqual(["lobster"]);
    expect(groups.byPlugin.size).toBe(0);
  });
});
