import { describe, expect, it } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import {
  formatSandboxToolPolicyBlockedMessage,
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "./sandbox.js";

describe("sandbox explain helpers", () => {
  it("prefers agent overrides > global > defaults (sandbox tool policy)", () => {
    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "work",
            workspace: "~/clawd-work",
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
    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "work",
            workspace: "~/clawd-work",
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
    const cfg: MoltbotConfig = {
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
    const cfg: MoltbotConfig = {
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
      sessionKey: "agent:main:whatsapp:group:g1",
      toolName: "browser",
    });
    expect(msg).toBeTruthy();
    expect(msg).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(msg).toContain("mode=non-main");
    expect(msg).toContain("tools.sandbox.tools.deny");
    expect(msg).toContain("agents.defaults.sandbox.mode=off");
    expect(msg).toContain("Use main session key (direct): agent:main:main");
  });
});
