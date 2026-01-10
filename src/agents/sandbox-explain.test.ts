import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import {
  formatSandboxToolPolicyBlockedMessage,
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "./sandbox.js";

describe("sandbox explain helpers", () => {
  it("prefers agent overrides > global > defaults (sandbox tool policy)", () => {
    const cfg: ClawdbotConfig = {
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
    expect(resolved.tools.allow).toEqual(["write"]);
    expect(resolved.tools.deny).toEqual(["browser"]);

    const policy = resolveSandboxToolPolicyForAgent(cfg, "work");
    expect(policy.allow).toEqual(["write"]);
    expect(policy.sources.allow.source).toBe("agent");
    expect(policy.deny).toEqual(["browser"]);
    expect(policy.sources.deny.source).toBe("global");
  });

  it("includes config key paths + main-session hint for non-main mode", () => {
    const cfg: ClawdbotConfig = {
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
      sessionKey: "agent:main:whatsapp:group:G1",
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
