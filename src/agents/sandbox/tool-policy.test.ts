import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  formatSandboxToolPolicyBlockedMessage,
  resolveSandboxRuntimeStatus,
} from "./runtime-status.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./tool-policy.js";

describe("sandbox/tool-policy", () => {
  it("merges sandbox alsoAllow into the default sandbox allowlist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
    };

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "tavern");
    expect(resolved.allow).toContain("message");
    expect(resolved.allow).toContain("tts");
    expect(resolved.sources.allow).toEqual({
      source: "agent",
      key: "agents.list[].tools.sandbox.tools.alsoAllow",
    });
  });

  it("lets explicit sandbox allow remove entries from the default sandbox denylist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
    };

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.allow).toContain("browser");
    expect(resolved.deny).not.toContain("browser");
    expect(
      isToolAllowed(
        {
          allow: resolved.allow,
          deny: resolved.deny,
        },
        "browser",
      ),
    ).toBe(true);
  });

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            allow: [],
            alsoAllow: ["browser"],
          },
        },
      },
    };

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.allow).toStrictEqual([]);
    expect(resolved.deny).not.toContain("browser");
    expect(
      isToolAllowed(
        {
          allow: resolved.allow,
          deny: resolved.deny,
        },
        "read",
      ),
    ).toBe(true);
    expect(
      isToolAllowed(
        {
          allow: resolved.allow,
          deny: resolved.deny,
        },
        "browser",
      ),
    ).toBe(true);
  });

  it("keeps canonical sandbox config and runtime status aligned with the effective resolver", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "tavern");
    expect(sandbox.tools.allow).toContain("browser");
    expect(sandbox.tools.allow).toContain("message");
    expect(sandbox.tools.allow).toContain("tts");
    expect(sandbox.tools.deny).not.toContain("browser");

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:tavern:main",
    });
    expect(runtime.toolPolicy.allow).toContain("browser");
    expect(runtime.toolPolicy.allow).toContain("message");
    expect(runtime.toolPolicy.allow).toContain("tts");
    expect(runtime.toolPolicy.deny).not.toContain("browser");
  });

  it("treats channel direct sessions as sandboxed in non-main mode", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "agent" },
        },
        list: [{ id: "main" }],
      },
    };

    expect(
      resolveSandboxRuntimeStatus({
        cfg,
        sessionKey: "agent:main:main",
      }).sandboxed,
    ).toBe(false);
    expect(
      resolveSandboxRuntimeStatus({
        cfg,
        sessionKey: "agent:main:telegram:default:direct:42",
      }).sandboxed,
    ).toBe(true);
  });

  it("keeps the agent main session sandboxed in all mode", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [{ id: "main" }],
      },
    };

    expect(
      resolveSandboxRuntimeStatus({
        cfg,
        sessionKey: "agent:main:main",
      }).sandboxed,
    ).toBe(true);
  });

  it("keeps explicit sandbox deny precedence over allow and alsoAllow", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
            alsoAllow: ["message"],
            deny: ["browser", "message"],
          },
        },
      },
    };

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.deny).toContain("browser");
    expect(resolved.deny).toContain("message");
    expect(
      isToolAllowed(
        {
          allow: resolved.allow,
          deny: resolved.deny,
        },
        "browser",
      ),
    ).toBe(false);
    expect(
      isToolAllowed(
        {
          allow: resolved.allow,
          deny: resolved.deny,
        },
        "message",
      ),
    ).toBe(false);
  });

  it("uses the effective sandbox policy when formatting blocked-tool guidance", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            alsoAllow: ["message"],
          },
        },
      },
    };

    const browserMessage = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey: "agent:main:main",
      toolName: "browser",
    });
    expect(browserMessage).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(browserMessage).toContain("tools.sandbox.tools.deny");

    const messageToolMessage = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey: "agent:main:main",
      toolName: "message",
    });
    expect(messageToolMessage).toBeUndefined();
  });

  it("keeps blocked-tool guidance glob-aware and shell-safe", () => {
    const sessionKey = "agent:main:weird session;rm -rf /";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            deny: ["WEB_*"],
          },
        },
      },
    };

    const message = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      toolName: "web_fetch",
    });

    expect(message).toContain('Tool "web_fetch" blocked by sandbox tool policy');
    expect(message).toContain("tools.sandbox.tools.deny");
    expect(message).not.toContain(`Session: ${sessionKey}`);
    expect(message).toContain("Session: agent:… -rf /");
    expect(message).toContain(
      "openclaw sandbox explain --session 'agent:main:weird session;rm -rf /'",
    );
  });

  it("avoids terminal injection for control-character session keys", () => {
    const sessionKey = "agent:main:abcde\n12345";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
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

    const message = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      toolName: "browser",
    });

    const sessionLine = message?.split("\n").find((line) => line.startsWith("Session: "));
    expect(sessionLine).toBe("Session: agent:…\\n12345");
    expect(sessionLine).not.toContain(sessionKey);
    expect(sessionLine).toContain("\\n");
    expect(message).toContain("openclaw sandbox explain --agent main");
    expect(message).not.toContain("--session");
  });
});
