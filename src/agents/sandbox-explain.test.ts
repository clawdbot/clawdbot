// Verifies sandbox tool-policy resolution and blocked-tool explanation text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { formatSandboxToolPolicyBlockedMessage } from "./sandbox/runtime-status.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditInfo: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    // Audit logging is asserted without touching the real subsystem logger.
    info: toolPolicyAuditInfo,
  }),
}));

describe("sandbox explain helpers", () => {
  beforeEach(() => {
    toolPolicyAuditInfo.mockClear();
  });

  it("prefers agent overrides > global > defaults (sandbox tool policy)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            tools: { sandbox: { tools: { allow: ["write"] } } },
          },
        ],
      },
      tools: { sandbox: { tools: { allow: ["read"], deny: ["browser"] } } },
    };

    const resolved = resolveSandboxConfigForAgent(cfg, "work");
    expect(resolved.tools.allow).toEqual(["write", "image"]);
    expect(resolved.tools.deny).toEqual(["browser"]);

    const policy = resolveSandboxToolPolicyForAgent(cfg, "work");
    expect(policy.allow).toEqual(["write", "image"]);
    expect(policy.sources.allow.source).toBe("agent");
    expect(policy.deny).toEqual(["browser"]);
    expect(policy.sources.deny.source).toBe("global");
  });

  it("expands group tool shorthands inside sandbox tool policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            tools: {
              sandbox: { tools: { allow: ["group:memory", "group:fs"] } },
            },
          },
        ],
      },
    };

    const policy = resolveSandboxToolPolicyForAgent(cfg, "work");
    expect(policy.allow).toEqual([
      "memory_search",
      "memory_get",
      "read",
      "write",
      "edit",
      "apply_patch",
      "image",
    ]);
  });

  it("denies still win after group expansion", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["group:memory"],
            deny: ["memory_get"],
          },
        },
      },
    };

    const policy = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(policy.allow).toContain("memory_search");
    expect(policy.allow).toContain("memory_get");
    expect(policy.deny).toContain("memory_get");
  });

  it("includes config key paths + main-session hint for non-main mode", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            deny: ["browser"],
          },
        },
      },
    };

    const msg = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey: "agent:main:mobilechat:group:g1",
      toolName: "browser",
      audit: true,
    });
    expect(msg).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(msg).toContain("mode=non-main");
    expect(msg).toContain("tools.sandbox.tools.deny");
    expect(msg).toContain("agents.defaults.sandbox.mode=off");
    expect(msg).toContain("Use the agent main session instead of a non-main session.");
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "sandbox tool policy blocked browser via tools.sandbox.tools.deny; matched browser",
      {
        tool: "browser",
        ruleKind: "deny",
        ruleSource: "global",
        configKey: "tools.sandbox.tools.deny",
        matchedRule: "browser",
        sandboxMode: "non-main",
      },
    );
  });

  it("does not audit sandbox tool-policy formatting unless requested", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            deny: ["browser"],
          },
        },
      },
    };

    const msg = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey: "agent:main:mobilechat:group:g1",
      toolName: "browser",
    });

    expect(msg).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });
});
