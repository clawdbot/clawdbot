/**
 * Regression coverage for core tool allow/deny policy helpers.
 * Verifies sandbox policy resolution, explicit lists, and tool matching.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import {
  isRuntimeToolAllowed,
  createRuntimeToolMatcher,
  isToolAllowedByPolicyName,
} from "./tool-policy-match.js";
import {
  collectExplicitAllowlist,
  couldNormalizeToolNamePrefixToAllowedTool,
  DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  expandToolGroups,
  hasRestrictiveAllowPolicy,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";

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
    expect(coding?.allow).toContain("automations");
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
    expect(normalizeToolPolicyName(" BASH ")).toBe("exec");
    expect(normalizeToolPolicyName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolPolicyName("READ")).toBe("read");
    // Pre-rename scheduler tool name from persisted config (RFC 0026).
    expect(normalizeToolPolicyName("cron")).toBe("automations");
    expect(normalizeToolPolicyName("automations")).toBe("automations");
  });

  it.each(["constructor", "__proto__"])(
    "preserves the literal tool name %s in aliases and groups",
    (name) => {
      expect(normalizeToolPolicyName(name)).toBe(name);
      expect(expandToolGroups([name])).toEqual([name]);
    },
  );

  it.each(["constructor", "__proto__"])("matches literal %s prefixes only when allowed", (name) => {
    expect(couldNormalizeToolNamePrefixToAllowedTool(name.slice(0, 3), new Set([name]))).toBe(true);
    expect(couldNormalizeToolNamePrefixToAllowedTool("other", new Set([name]))).toBe(false);
    expect(couldNormalizeToolNamePrefixToAllowedTool(name, new Set(["other"]))).toBe(false);
  });

  it.each(["ba", "bash", "apply-", "cron"])("retains declared alias prefix %s", (prefix) => {
    expect(
      couldNormalizeToolNamePrefixToAllowedTool(
        prefix,
        new Set(["exec", "apply_patch", "automations"]),
      ),
    ).toBe(true);
  });

  it("collects explicit allowlist entries", () => {
    expect(
      collectExplicitAllowlist([
        {
          allow: ["*", "optional-demo"],
        },
      ]),
    ).toContain("optional-demo");
  });

  it("uses alsoAllow entries for plugin discovery without the synthetic allow-all", () => {
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: ["lobster"] })])).toEqual([
      "lobster",
      DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
    ]);
    expect(
      collectExplicitAllowlist([pickSandboxToolPolicy({ allow: [], alsoAllow: ["lobster"] })]),
    ).toEqual(["*", "lobster"]);
  });

  it("preserves explicit alsoAllow wildcards for plugin discovery", () => {
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: ["*"] })])).toEqual(["*"]);
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: [" * "] })])).toEqual([
      "*",
    ]);
  });

  it("does not treat additive allow-all policies as restrictive", () => {
    expect(hasRestrictiveAllowPolicy(pickSandboxToolPolicy({ alsoAllow: ["optional-demo"] }))).toBe(
      false,
    );
    expect(
      hasRestrictiveAllowPolicy(pickSandboxToolPolicy({ allow: [], alsoAllow: ["optional-demo"] })),
    ).toBe(false);
  });

  it("still treats explicit bounded allowlists as restrictive", () => {
    expect(hasRestrictiveAllowPolicy(pickSandboxToolPolicy({ allow: ["read"] }))).toBe(true);
  });
});

describe("sandbox tool policy", () => {
  it.each(["constructor", "__proto__"])("applies allow and deny to literal %s", (name) => {
    const allow = { allow: [` ${name.toUpperCase()} `] };
    const deny = { allow: ["*"], deny: [` ${name.toUpperCase()} `] };
    for (const matches of [
      (policy: SandboxToolPolicy, tool: string) => isToolAllowed(policy, tool),
      (policy: SandboxToolPolicy, tool: string) => isToolAllowedByPolicyName(tool, policy),
    ]) {
      expect(matches(allow, name)).toBe(true);
      expect(matches(allow, "other")).toBe(false);
      expect(matches(deny, name)).toBe(false);
      expect(matches(deny, "other")).toBe(true);
    }
  });

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
    expect(resolved.allow).toStrictEqual([]);
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
    expect(resolved.allow).toEqual(["read", "view_image"]);
    expect(resolved.deny).toEqual(["browser"]);
  });

  it("does not auto-add view_image when explicitly denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["view_image"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read"]);
    expect(resolved.deny).toEqual(["view_image"]);
  });
});

describe("isToolAllowedByPolicyName — legacy scheduler tool name (RFC 0026)", () => {
  it("allows the renamed tool through persisted legacy allow lists", () => {
    expect(isToolAllowedByPolicyName("automations", { allow: ["cron"] })).toBe(true);
  });

  it("denies the renamed tool through persisted legacy deny lists", () => {
    expect(isToolAllowedByPolicyName("automations", { deny: ["cron"] })).toBe(false);
  });
});

describe("isToolAllowedByPolicyName — apply_patch / write deny decoupling (#76749)", () => {
  it("does not deny apply_patch when write is denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write"] })).toBe(true);
  });

  it("still denies apply_patch when apply_patch is explicitly denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["apply_patch"] })).toBe(false);
  });

  it("still allows apply_patch via write in the allow list", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["write"], deny: [] })).toBe(true);
  });

  it("denies apply_patch when both write and apply_patch are denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write", "apply_patch"] })).toBe(
      false,
    );
  });

  it("keeps runtime write compatibility out of construction planning", () => {
    expect(isRuntimeToolAllowed("apply_patch", ["write"])).toBe(true);
    expect(createRuntimeToolMatcher(["write"], false)("apply_patch")).toBe(false);
    expect(isRuntimeToolAllowed("apply_patch", ["apply-patch"])).toBe(true);
    expect(isRuntimeToolAllowed("apply_patch", ["apply_*"])).toBe(true);
    expect(isRuntimeToolAllowed("apply_patch", ["group:fs"])).toBe(true);
  });
});
