import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../../plugins/tools.js";
import type { AnyAgentTool } from "../tools/common.js";
import { applyFinalEffectiveToolPolicy } from "./effective-tool-policy.js";

function makeTool(name: string, ownerOnly = false): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    ownerOnly,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

describe("applyFinalEffectiveToolPolicy", () => {
  it("filters bundled tools through the configured allowlist", () => {
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__fs_delete"), makeTool("mcp__bundle__fs_read")],
      config: { tools: { allow: ["mcp__bundle__fs_read"] } },
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__fs_read"]);
  });

  it("applies owner-only filtering to bundled tools", () => {
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read"), makeTool("mcp__bundle__admin", true)],
      senderIsOwner: false,
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__read"]);
  });

  it("returns the empty array unchanged when there are no bundled tools", () => {
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: [],
      config: { tools: { allow: ["message"] } },
      warn: () => {},
    });

    expect(filtered).toEqual([]);
  });

  it("drops caller-provided groupId when it disagrees with session-derived group context", () => {
    const warnings: string[] = [];
    applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      // Session key encodes a concrete group (discord room 111); caller tries
      // to override with a different group id so a more permissive group
      // policy for group 222 could be consulted.
      sessionKey: "agent:alice:discord:group:111",
      groupId: "222",
      groupChannel: "#different",
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  });

  it("drops caller-provided groupId when session encodes no group context (fail-closed)", () => {
    const warnings: string[] = [];
    applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      // Direct/non-group session key: no session-derived group ids. A caller
      // supplying a groupId here has no server-verified ground truth; it
      // must be dropped so a spoofed group cannot reach a permissive policy.
      sessionKey: "agent:alice:main",
      groupId: "admin-group",
      groupChannel: "#admin",
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  });

  it("leaves groupId untouched when caller did not supply one", () => {
    const warnings: string[] = [];
    applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      sessionKey: "agent:alice:main",
      warn: (message) => warnings.push(message),
    });

    expect(warnings).not.toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  });

  it("does not emit unknown-entry warnings for core tool allowlists in the bundled pass", () => {
    const warnings: string[] = [];
    applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      // Core tool names like `read` and `exec` are not in the bundled-only
      // input here, but they are valid core tools resolved by the first
      // pass. The bundled pass must not warn about them as "unknown".
      config: { tools: { allow: ["read", "exec", "mcp__bundle__read"] } },
      warn: (message) => warnings.push(message),
    });

    expect(warnings.some((w) => w.includes("unknown entries"))).toBe(false);
  });

  it("still warns on genuinely unknown entries in the bundled pass", () => {
    const warnings: string[] = [];
    applyFinalEffectiveToolPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      config: { tools: { allow: ["mcp__bundle__read", "totally-made-up-tool"] } },
      warn: (message) => warnings.push(message),
    });

    expect(warnings.some((w) => w.includes("totally-made-up-tool"))).toBe(true);
  });

  it("keeps bundle MCP tools in the coding profile via plugin metadata", () => {
    const mcpTool = makeTool("bundleProbe__bundle_probe");
    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });

    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: [mcpTool],
      config: { tools: { profile: "coding" } },
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
  });

  it("lets explicit deny entries override the profile bundle MCP allowlist", () => {
    const mcpTool = makeTool("bundleProbe__bundle_probe");
    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });

    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: [mcpTool],
      config: { tools: { profile: "coding", deny: ["bundle-mcp"] } },
      warn: () => {},
    });

    expect(filtered).toEqual([]);
  });
});
