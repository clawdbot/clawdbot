// Sandbox tool policy tests cover effective allow/deny merging and blocked-tool
// guidance for sandboxed agent sessions.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { migratePersistedImplicitMainRoster } from "../../config/legacy.roster.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSandboxConfigForAgent as resolveSandboxConfigForAgentBase } from "./config.js";
import {
  formatSandboxToolPolicyBlockedMessage as formatSandboxToolPolicyBlockedMessageBase,
  resolveSandboxRuntimeStatus as resolveSandboxRuntimeStatusBase,
} from "./runtime-status.js";
import {
  isToolAllowed,
  resolveSandboxToolPolicyForAgent as resolveSandboxToolPolicyForAgentBase,
} from "./tool-policy.js";

const sandboxStoreDirs = useAutoCleanupTempDirTracker(afterEach);

function loadedConfig(config: OpenClawConfig | undefined): OpenClawConfig {
  return migratePersistedImplicitMainRoster(config ?? {}).config as OpenClawConfig;
}

function resolveSandboxConfigForAgent(config: OpenClawConfig, agentId: string) {
  return resolveSandboxConfigForAgentBase(loadedConfig(config), agentId);
}

function resolveSandboxToolPolicyForAgent(config: OpenClawConfig, agentId: string) {
  return resolveSandboxToolPolicyForAgentBase(loadedConfig(config), agentId);
}

function resolveSandboxRuntimeStatus(
  params: Parameters<typeof resolveSandboxRuntimeStatusBase>[0],
) {
  return resolveSandboxRuntimeStatusBase({
    ...params,
    cfg: loadedConfig(params.cfg),
  });
}

function formatSandboxToolPolicyBlockedMessage(
  params: Parameters<typeof formatSandboxToolPolicyBlockedMessageBase>[0],
) {
  return formatSandboxToolPolicyBlockedMessageBase({
    ...params,
    cfg: loadedConfig(params.cfg),
  });
}

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
      key: "agents.entries.*.tools.sandbox.tools.alsoAllow",
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

  it.each([["image"], ["image*"]] as const)(
    "keeps legacy %s denies fail-closed for view_image until Doctor migrates them",
    (legacyDeny) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { sandbox: { mode: "all", scope: "agent" } } },
        tools: { sandbox: { tools: { allow: ["read"], deny: [legacyDeny] } } },
      };

      const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
      expect(resolved.deny).toContain("view_image");
      expect(isToolAllowed(resolved, "view_image")).toBe(false);
    },
  );

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    // An empty allowlist means allow all except denies; alsoAllow should only
    // remove matching default denies, not turn allow-all into allow-some.
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
    expect(resolved.deny).toContain("computer");
    expect(
      isToolAllowed(
        {
          allow: resolved.allow,
          deny: resolved.deny,
        },
        "computer",
      ),
    ).toBe(false);
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

  it("forces a persisted sandbox requirement even when the agent sandbox mode is off", async () => {
    const sessionKey = "agent:main:guest";
    const storePath = path.join(
      sandboxStoreDirs.make("openclaw-required-sandbox-"),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const entry = {
      sessionId: "guest-session",
      updatedAt: 1,
      sandbox: "required" as const,
      createdActor: { type: "human" as const, id: "guest-principal" },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        defaults: { sandbox: { mode: "off", scope: "session", workspaceAccess: "rw" } },
        list: [{ id: "main" }],
      },
    };

    expect(resolveSandboxRuntimeStatus({ cfg, sessionKey })).toMatchObject({
      sandboxRequired: true,
      sandboxPrincipalId: "guest-principal",
      sandboxed: true,
      workspaceAccess: "ro",
    });
    const blockedMessage = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      toolName: "browser",
    });
    expect(blockedMessage).toContain("create a new session under an authorized role");
    expect(blockedMessage).not.toContain("sandbox.mode=off");
  });

  it("does not apply guest isolation or cap writable access to unstamped sessions", async () => {
    const sessionKey = "agent:main:maintainer";
    const storePath = path.join(
      sandboxStoreDirs.make("openclaw-unstamped-sandbox-"),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "maintainer-session",
        updatedAt: 1,
        createdActor: { type: "human", id: "maintainer-principal" },
      },
    );
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        defaults: { sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" } },
        list: [{ id: "main" }],
      },
    };

    const runtime = resolveSandboxRuntimeStatus({ cfg, sessionKey });

    expect(runtime).toMatchObject({ sandboxRequired: false, sandboxed: true });
    expect(runtime.sandboxPrincipalId).toBeUndefined();
    expect(runtime.workspaceAccess).toBeUndefined();
  });

  it("classifies a borrowed runtime key under its own sandbox agent", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          worker: {
            sandbox: { mode: "non-main", scope: "agent" },
            tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
          },
        },
      },
    } satisfies OpenClawConfig;

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:main",
      agentId: "main",
      classificationSessionKey: "agent:worker:discord:default:direct:peer-42",
      classificationAgentId: "worker",
    });

    expect(runtime).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      classificationAgentId: "worker",
      classificationSessionKey: "agent:worker:discord:default:direct:peer-42",
      sandboxed: true,
    });
    expect(runtime.toolPolicy.deny).toContain("sessions_list");
  });

  it("recognizes the classification agent's main session in non-main mode", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          worker: { sandbox: { mode: "non-main", scope: "agent" } },
        },
      },
    } satisfies OpenClawConfig;

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:main",
      agentId: "main",
      classificationSessionKey: "agent:worker:main",
      classificationAgentId: "worker",
    });

    expect(runtime.agentId).toBe("main");
    expect(runtime.classificationAgentId).toBe("worker");
    expect(runtime.sandboxed).toBe(false);
  });

  it("rejects a classification agent that conflicts with its session key", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, worker: {} },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveSandboxRuntimeStatus({
        cfg,
        sessionKey: "agent:main:main",
        agentId: "main",
        classificationSessionKey: "agent:worker:main",
        classificationAgentId: "main",
      }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it("keeps the session identity as the sandbox classification when none is supplied", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: { sandbox: { mode: "non-main", scope: "agent" } } },
      },
    } satisfies OpenClawConfig;

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:telegram:default:direct:42",
      agentId: "main",
    });

    expect(runtime).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:telegram:default:direct:42",
      classificationAgentId: "main",
      classificationSessionKey: "agent:main:telegram:default:direct:42",
      sandboxed: true,
    });
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
    // The guidance embeds a copy-paste command; quote the real session key while
    // keeping the displayed session line compact and terminal-safe.
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

  it.each([
    {
      boundary: "prefix",
      sessionKey: `abcde\u{1f600}middle123456`,
      expectedLabel: "abcde…123456",
    },
    {
      boundary: "suffix",
      sessionKey: `abcdefmiddle\u{1f600}12345`,
      expectedLabel: "abcdef…12345",
    },
    {
      boundary: "both",
      sessionKey: `abcde\u{1f600}middle\u{1f600}12345`,
      expectedLabel: "abcde…12345",
    },
  ])(
    "keeps redacted session keys UTF-16 safe at the $boundary boundary",
    ({ sessionKey, expectedLabel }) => {
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
      const sessionLabel = sessionLine?.slice("Session: ".length);
      expect(sessionLabel).toBe(expectedLabel);
      expect(sessionLabel?.length).toBeLessThanOrEqual(13);
      expect(sessionLabel).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
      expect(message).toContain(`openclaw sandbox explain --session '${sessionKey}'`);
    },
  );

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
