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
  all: ["crab", "workflow_tool"],
  byPlugin: new Map([["crab", ["crab", "workflow_tool"]]]),
};
const coreTools = new Set(["read", "write", "exec", "session_status"]);

describe("analyzeAllowlistByToolType", () => {
  it("preserves allowlist when it only targets plugin tools", () => {
    const policy = analyzeAllowlistByToolType({ allow: ["crab"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toEqual(["crab"]);
    expect(policy.pluginOnlyAllowlist).toBe(true);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("preserves allowlist when it only targets plugin groups", () => {
    const policy = analyzeAllowlistByToolType(
      { allow: ["group:plugins"] },
      pluginGroups,
      coreTools,
    );
    expect(policy.policy?.allow).toEqual(["group:plugins"]);
    expect(policy.pluginOnlyAllowlist).toBe(true);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it('keeps allowlist when it uses "*"', () => {
    const policy = analyzeAllowlistByToolType({ allow: ["*"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toEqual(["*"]);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const policy = analyzeAllowlistByToolType({ allow: ["crab", "read"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toEqual(["crab", "read"]);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("preserves allowlist with unknown entries when no core tools match", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = analyzeAllowlistByToolType({ allow: ["crab"] }, emptyPlugins, coreTools);
    expect(policy.policy?.allow).toEqual(["crab"]);
    expect(policy.pluginOnlyAllowlist).toBe(false);
    expect(policy.unknownAllowlist).toEqual(["crab"]);
  });

  it("keeps allowlist with core tools and reports unknown entries", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = analyzeAllowlistByToolType({ allow: ["read", "crab"] }, emptyPlugins, coreTools);
    expect(policy.policy?.allow).toEqual(["read", "crab"]);
    expect(policy.unknownAllowlist).toEqual(["crab"]);
  });

  it("does not mark unavailable core entries as plugin-only", () => {
    const policy = analyzeAllowlistByToolType({ allow: ["apply_patch"] }, pluginGroups, coreTools);
    expect(policy.pluginOnlyAllowlist).toBe(false);
    expect(policy.unknownAllowlist).toEqual(["apply_patch"]);
  });

  it("recognizes declared plugin tools before they are materialized", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = analyzeAllowlistByToolType({ allow: ["llm-task"] }, emptyPlugins, coreTools, {
      pluginToolNames: ["llm-task"],
    });
    expect(policy.policy?.allow).toEqual(["llm-task"]);
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
      tools: [{ name: "crab" }],
      toolMeta: () => ({ pluginId: "" }),
    });
    expect(groups.all).toEqual(["crab"]);
    expect(groups.byPlugin.size).toBe(0);
  });
});
