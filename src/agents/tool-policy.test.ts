import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { TOOL_POLICY_CONFORMANCE } from "./tool-policy.conformance.js";
import {
  applyOwnerOnlyToolPolicy,
  collectExplicitAllowlist,
  expandToolGroups,
  isOwnerOnlyToolName,
  normalizeToolName,
  resolveOwnerOnlyToolApprovalClass,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

function createOwnerPolicyTools() {
  return [
    {
      name: "read",
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "cron",
      ownerOnly: true,
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "gateway",
      ownerOnly: true,
      execute: async () => ({ content: [], details: {} }) as any,
    },
  ] as unknown as AnyAgentTool[];
}

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("read");
    expect(coding?.allow).toContain("cron");
    expect(coding?.allow).not.toContain("gateway");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("subagents");
    expect(group).toContain("session_status");
    expect(group).toContain("tts");
  });

  it("normalizes tool names and aliases", () => {
    expect(normalizeToolName(" BASH ")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName("READ")).toBe("read");
  });

  it("identifies owner-only tools", () => {
    expect(isOwnerOnlyToolName("cron")).toBe(true);
    expect(isOwnerOnlyToolName("gateway")).toBe(true);
    expect(isOwnerOnlyToolName("nodes")).toBe(true);
    expect(isOwnerOnlyToolName("read")).toBe(false);
  });

  it("exposes stable approval classes for shared owner-only fallbacks", () => {
    expect(resolveOwnerOnlyToolApprovalClass("cron")).toBe("control_plane");
    expect(resolveOwnerOnlyToolApprovalClass("gateway")).toBe("control_plane");
    expect(resolveOwnerOnlyToolApprovalClass("nodes")).toBe("exec_capable");
    expect(resolveOwnerOnlyToolApprovalClass("read")).toBeUndefined();
  });

  it("keeps ACP owner-only backstops aligned with the HTTP deny list", () => {
    const sharedBackstops = DEFAULT_GATEWAY_HTTP_TOOL_DENY.flatMap((name) => {
      const approvalClass = resolveOwnerOnlyToolApprovalClass(name);
      return approvalClass ? ([[name, approvalClass]] as const) : [];
    });

    expect(Object.fromEntries(sharedBackstops)).toEqual({
      cron: "control_plane",
      gateway: "control_plane",
      nodes: "exec_capable",
    });
  });

  it("strips owner-only tools for non-owner senders", async () => {
    const tools = createOwnerPolicyTools();
    const filtered = applyOwnerOnlyToolPolicy(tools, false);
    expect(filtered.map((t) => t.name)).toEqual(["read"]);
  });

  it("keeps owner-only tools for the owner sender", async () => {
    const tools = createOwnerPolicyTools();
    const filtered = applyOwnerOnlyToolPolicy(tools, true);
    expect(filtered.map((t) => t.name)).toEqual(["read", "cron", "gateway"]);
  });

  it("honors ownerOnly metadata for custom tool names", async () => {
    const tools = [
      {
        name: "custom_admin_tool",
        ownerOnly: true,
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];
    expect(applyOwnerOnlyToolPolicy(tools, false)).toEqual([]);
    expect(applyOwnerOnlyToolPolicy(tools, true)).toHaveLength(1);
  });

  it("preserves explicit alsoAllow hints when allow is empty", () => {
    expect(
      collectExplicitAllowlist([
        {
          allow: ["*", "optional-demo"],
        },
      ]),
    ).toContain("optional-demo");
  });

  it("strips nodes for non-owner senders via fallback policy", () => {
    const tools = [
      {
        name: "read",
        execute: async () => ({ content: [], details: {} }) as any,
      },
      {
        name: "nodes",
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];

    expect(applyOwnerOnlyToolPolicy(tools, false).map((tool) => tool.name)).toEqual(["read"]);
    expect(applyOwnerOnlyToolPolicy(tools, true).map((tool) => tool.name)).toEqual([
      "read",
      "nodes",
    ]);
  });
});

describe("TOOL_POLICY_CONFORMANCE", () => {
  it("matches exported TOOL_GROUPS exactly", () => {
    expect(TOOL_POLICY_CONFORMANCE.toolGroups).toEqual(TOOL_GROUPS);
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(TOOL_POLICY_CONFORMANCE)).not.toThrow();
  });
});

describe("sandbox tool policy", () => {
  it("allows all tools with * allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: [] };
    expect(isToolAllowed(policy, "browser")).toBe(true);
  });

  it("denies all tools with * deny", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["*"] };
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("supports wildcard patterns", () => {
    const policy: SandboxToolPolicy = { allow: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(true);
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("applies deny before allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("treats empty allowlist as allow-all (with deny exceptions)", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("expands tool groups + aliases in patterns", () => {
    const policy: SandboxToolPolicy = {
      allow: ["group:fs", "BASH"],
      deny: ["apply_*"],
    };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "exec")).toBe(true);
    expect(isToolAllowed(policy, "apply_patch")).toBe(false);
  });

  it("normalizes whitespace + case", () => {
    const policy: SandboxToolPolicy = { allow: [" WEB_* "] };
    expect(isToolAllowed(policy, "WEB_FETCH")).toBe(true);
  });
});

describe("resolveSandboxToolPolicyForAgent", () => {
  it("keeps allow-all semantics when allow is []", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: [], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.sources.allow).toEqual({
      source: "global",
      key: "tools.sandbox.tools.allow",
    });
    expect(resolved.allow).toEqual([]);
    expect(resolved.deny).toEqual(["browser"]);

    const policy: SandboxToolPolicy = { allow: resolved.allow, deny: resolved.deny };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "browser")).toBe(false);
  });

  it("auto-adds image to explicit allowlists unless denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read", "image"]);
    expect(resolved.deny).toEqual(["browser"]);
  });

  it("does not auto-add image when explicitly denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["image"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read"]);
    expect(resolved.deny).toEqual(["image"]);
  });
});
