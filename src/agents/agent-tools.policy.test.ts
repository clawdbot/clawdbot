/**
 * Tests layered tool policy resolution.
 * Covers wildcard matching, sub-agent inheritance, provider overrides, and
 * trusted group context checks.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
  resolveTrustedGroupId,
} from "./agent-tools.policy.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { filterToolsByPolicy, isToolAllowedByPolicyName } from "./tool-policy-match.js";

vi.mock("../channels/plugins/session-conversation.js", () => ({
  resolveSessionConversation: ({ rawId }: { rawId: string }) => ({
    id: rawId,
    threadId: undefined,
    baseConversationId: rawId,
    parentConversationCandidates: [],
  }),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: () => ({
    config: {
      listAccountIds: (config: OpenClawConfig) => [
        "default",
        ...Object.keys(
          (config.channels?.whatsapp as { accounts?: Record<string, unknown> } | undefined)
            ?.accounts ?? {},
        ),
      ],
    },
  }),
}));

async function writeSessionEntries(
  storePath: string,
  entries: Record<string, unknown>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry as SessionEntry);
  }
}

function createSessionStorePath(prefix: string, agentId = "main"): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "agents",
    agentId,
    "sessions",
    "sessions.json",
  );
}

describe("agent-tools.policy", () => {
  it("treats * in allow as allow-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { allow: ["*"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "exec"]);
  });

  it("treats * in deny as deny-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { deny: ["*"] });
    expect(filtered).toStrictEqual([]);
  });

  it("supports wildcard allow/deny patterns", () => {
    expect(isToolAllowedByPolicyName("web_fetch", { allow: ["web_*"] })).toBe(true);
    expect(isToolAllowedByPolicyName("web_search", { deny: ["web_*"] })).toBe(false);
  });

  it("keeps apply_patch when write is allowlisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["write"] })).toBe(true);
  });
});

describe("resolveGroupToolPolicy group context validation", () => {
  const cfg: OpenClawConfig = {
    channels: {
      whatsapp: {
        groups: {
          "safe-room": {
            tools: { allow: ["read"] },
          },
          "trusted-group": {
            tools: { allow: ["exec", "read", "write", "edit"] },
          },
        },
      },
    },
    tools: { allow: ["read"] },
  };

  it("rejects forged groupId when the session has no group context", () => {
    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:main",
        messageProvider: "whatsapp",
        groupId: "trusted-group",
        groupChannel: "whatsapp",
      }),
    ).toBeUndefined();
  });

  it("uses session-derived group policy when caller groupId disagrees", () => {
    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:whatsapp:group:safe-room",
        messageProvider: "whatsapp",
        groupId: "trusted-group",
        groupChannel: "whatsapp",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("accepts caller groupId when it matches session-derived group context", () => {
    expect(
      resolveTrustedGroupId({
        sessionKey: "agent:main:whatsapp:group:trusted-group",
        groupId: "trusted-group",
      }),
    ).toEqual({ groupId: "trusted-group", dropped: false });
    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:whatsapp:group:trusted-group",
        messageProvider: "whatsapp",
        groupId: "trusted-group",
        groupChannel: "whatsapp",
      }),
    ).toEqual({ allow: ["exec", "read", "write", "edit"] });
  });

  it("accepts caller groupId when spawnedBy provides the trusted group context", () => {
    expect(
      resolveTrustedGroupId({
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:whatsapp:group:trusted-group",
        groupId: "trusted-group",
      }),
    ).toEqual({ groupId: "trusted-group", dropped: false });
    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:whatsapp:group:trusted-group",
        messageProvider: "whatsapp",
        groupId: "trusted-group",
      }),
    ).toEqual({ allow: ["exec", "read", "write", "edit"] });
  });

  it("keeps specific session group policy ahead of trusted parent caller groupId", () => {
    const scopedCfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            room: {
              tools: { allow: ["exec", "read"] },
            },
            "room:sender:alice": {
              tools: { allow: ["read"] },
            },
          },
        },
      },
    };

    expect(
      resolveGroupToolPolicy({
        config: scopedCfg,
        sessionKey: "agent:main:whatsapp:group:room:sender:alice",
        messageProvider: "whatsapp",
        groupId: "room",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("prefers the session-derived channel over caller-supplied messageProvider", () => {
    const channelCfg = {
      channels: {
        discord: {
          groups: {
            C123: { tools: { allow: ["exec"] } },
          },
        },
        slack: {
          groups: {
            C123: { tools: { allow: ["read"] } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const policy = resolveGroupToolPolicy({
      config: channelCfg,
      sessionKey: "agent:main:slack:group:C123",
      messageProvider: "discord",
      groupId: "C123",
    });

    expect(policy).toEqual({ allow: ["read"] });
  });

  it("fails closed when scheduled authority names a removed account", () => {
    expect(
      resolveGroupToolPolicy({
        config: cfg,
        sessionKey: "agent:main:whatsapp:group:safe-room",
        accountId: "removed",
        requireConfiguredAccount: true,
      }),
    ).toEqual({ allow: [], deny: ["*"] });
  });

  it("denies every tool when scheduled authority names a removed account", () => {
    const policy = resolveGroupToolPolicy({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:safe-room",
      accountId: "removed",
      requireConfiguredAccount: true,
    });
    const tools = [
      createStubTool("read"),
      createStubTool("write"),
      createStubTool("exec"),
      createStubTool("apply_patch"),
    ];
    expect(filterToolsByPolicy(tools, policy)).toStrictEqual([]);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("apply_patch", policy)).toBe(false);
  });

  it("fails closed when scheduled authority names a removed account without channel context", () => {
    const policy = resolveGroupToolPolicy({
      config: cfg,
      sessionKey: "agent:main:main",
      accountId: "removed",
      requireConfiguredAccount: true,
    });
    expect(policy).toEqual({ allow: [], deny: ["*"] });
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
  });

  it("resolves scheduled group policy for a still-configured named account", () => {
    const accountCfg = {
      ...cfg,
      channels: {
        whatsapp: {
          ...cfg.channels?.whatsapp,
          accounts: { work: {} },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGroupToolPolicy({
        config: accountCfg,
        sessionKey: "agent:main:whatsapp:group:safe-room",
        accountId: "work",
        requireConfiguredAccount: true,
      }),
    ).toEqual({ allow: ["read"] });
  });
});

describe("resolveSubagentToolPolicyForSession", () => {
  const baseCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
  } as unknown as OpenClawConfig;

  it("recomputes a persisted leaf as an orchestrator under the recursive default", async () => {
    const storePath = createSessionStorePath("openclaw-subagent-policy-recursive");
    const sessionKey = "agent:main:subagent:formerly-leaf";
    await writeSessionEntries(storePath, {
      [sessionKey]: {
        sessionId: "formerly-leaf",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "leaf",
        subagentControlScope: "none",
      },
    });

    const policy = resolveSubagentToolPolicyForSession(
      { session: { store: storePath } } as OpenClawConfig,
      sessionKey,
    );

    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("keeps flat depth-1 sessions as leaves under an explicit finite cap", async () => {
    const storePath = createSessionStorePath("openclaw-subagent-policy");
    await writeSessionEntries(storePath, {
      "agent:main:subagent:flat-leaf": {
        sessionId: "flat-leaf",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "leaf",
        subagentControlScope: "none",
      },
    });
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
      session: { store: storePath },
    } as unknown as OpenClawConfig;

    const policy = resolveSubagentToolPolicyForSession(cfg, "agent:main:subagent:flat-leaf");
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(true);
  });

  it.each(["allow", "alsoAllow"] as const)(
    "does not let configured %s entries re-enable hard-denied tools",
    async (allowField) => {
      const storePath = createSessionStorePath(`openclaw-subagent-hard-deny-${allowField}`);
      const sessionKeys = {
        leaf: "agent:main:subagent:hard-deny-leaf",
        orchestrator: "agent:main:subagent:hard-deny-orchestrator",
      } as const;
      await writeSessionEntries(storePath, {
        [sessionKeys.leaf]: {
          sessionId: "hard-deny-leaf",
          updatedAt: Date.now(),
          spawnDepth: 2,
          subagentRole: "leaf",
          subagentControlScope: "none",
        },
        [sessionKeys.orchestrator]: {
          sessionId: "hard-deny-orchestrator",
          updatedAt: Date.now(),
          spawnDepth: 1,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
        },
      });
      const hardDeniedTools = [
        "gateway",
        "agents_list",
        "openclaw",
        "session_status",
        "progress_card",
        "automations",
        "cron",
        "message",
        "sessions_send",
        "conversations_list",
        "conversations_send",
        "conversations_turn",
      ];
      const cfg = {
        ...baseCfg,
        session: { store: storePath },
        tools: {
          subagents: {
            tools: {
              [allowField]: [...hardDeniedTools, "update_plan", "memory_search"],
            },
          },
        },
      } as unknown as OpenClawConfig;

      for (const sessionKey of Object.values(sessionKeys)) {
        const policy = resolveSubagentToolPolicyForSession(cfg, sessionKey);
        for (const toolName of hardDeniedTools) {
          expect(isToolAllowedByPolicyName(toolName, policy), toolName).toBe(false);
        }
        expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(true);
      }
    },
  );

  it("resolves inherited tool denies from stored subagent sessions", async () => {
    const storePath = createSessionStorePath("openclaw-subagent-inherited-deny");
    await writeSessionEntries(storePath, {
      "agent:main:subagent:limited": {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolDeny: ["bash", "memory_get"],
      },
    });
    const cfg = {
      ...baseCfg,
      session: {
        store: storePath,
      },
    } as unknown as OpenClawConfig;

    const policy = resolveInheritedToolPolicyForSession(cfg, "agent:main:subagent:limited");
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("resolves inherited tool allows from stored subagent sessions", async () => {
    const storePath = createSessionStorePath("openclaw-subagent-inherited-allow");
    await writeSessionEntries(storePath, {
      "agent:main:subagent:limited": {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolAllow: ["sessions_spawn", "memory_search"],
      },
    });
    const cfg = {
      ...baseCfg,
      session: {
        store: storePath,
      },
    } as unknown as OpenClawConfig;

    const policy = resolveInheritedToolPolicyForSession(cfg, "agent:main:subagent:limited");
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
  });

  it("keeps configured plugin allows separate from inherited tool allows", async () => {
    const storePath = createSessionStorePath("openclaw-subagent-inherited-allow-separate");
    await writeSessionEntries(storePath, {
      "agent:main:subagent:limited": {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolAllow: ["plugin_tool"],
      },
    });
    const cfg = {
      ...baseCfg,
      tools: {
        subagents: {
          tools: {
            allow: ["plugin-id"],
          },
        },
      },
      session: {
        store: storePath,
      },
    } as unknown as OpenClawConfig;

    const subagentPolicy = resolveSubagentToolPolicyForSession(cfg, "agent:main:subagent:limited");
    const inheritedPolicy = resolveInheritedToolPolicyForSession(
      cfg,
      "agent:main:subagent:limited",
    );
    expect(subagentPolicy.allow).toEqual(["plugin-id"]);
    expect(inheritedPolicy?.allow).toEqual(["plugin_tool"]);
  });

  it("applies inherited tool policy from stored ACP sessions without subagent metadata", async () => {
    const storePath = createSessionStorePath("openclaw-acp-inherited-deny");
    await writeSessionEntries(storePath, {
      "agent:main:acp:limited": {
        sessionId: "limited-acp-session",
        updatedAt: Date.now(),
        inheritedToolAllow: ["custom_plugin_tool"],
        inheritedToolDeny: ["custom_denied_tool"],
      },
    });
    const cfg = {
      ...baseCfg,
      session: {
        store: storePath,
      },
    } as unknown as OpenClawConfig;

    const policy = resolveInheritedToolPolicyForSession(cfg, "agent:main:acp:limited");
    expect(isToolAllowedByPolicyName("custom_plugin_tool", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("custom_denied_tool", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(false);
  });
});

describe("resolveEffectiveToolPolicy", () => {
  it("applies implicit-main defaults tool restrictions to a pre-roster config", () => {
    const cfg = {
      agents: { defaults: { tools: { deny: ["exec"] } } },
    } as unknown as OpenClawConfig;

    const result = resolveEffectiveToolPolicy({ config: cfg });

    expect(result.agentId).toBe("main");
    expect(result.agentPolicy).toEqual({ deny: ["exec"] });
  });

  it("uses the configured default agent policy for an unscoped session alias", () => {
    const cfg = {
      agents: {
        entries: {
          ops: { default: true, tools: { deny: ["exec"] } },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveEffectiveToolPolicy({ config: cfg, sessionKey: "main" });

    expect(result.agentId).toBe("ops");
    expect(result.agentPolicy).toEqual({ deny: ["exec"] });
  });

  it("uses the retained legacy owner policy when no session scope is provided", () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          entries: {
            ops: { tools: { deny: ["read"] } },
            research: { tools: { deny: ["exec"] } },
          },
        },
      },
      "research",
    );

    const result = resolveEffectiveToolPolicy({ config: cfg });

    expect(result.agentId).toBe("research");
    expect(result.agentPolicy).toEqual({ deny: ["exec"] });
  });

  it("uses the configured fixed-store owner policy for an unscoped session key", () => {
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "research" } },
        entries: {
          ops: { tools: { deny: ["read"] } },
          research: { tools: { deny: ["exec"] } },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveEffectiveToolPolicy({ config: cfg, sessionKey: "global" });

    expect(result.agentId).toBe("research");
    expect(result.agentPolicy).toEqual({ deny: ["exec"] });
    expect(() =>
      resolveEffectiveToolPolicy({ config: cfg, agentId: "ops", sessionKey: "global" }),
    ).toThrow(/belongs to "research"/);
  });

  it("keeps slash-containing modelId scoped to the selected provider", () => {
    const cfg = {
      tools: {
        byProvider: {
          "anthropic/claude-sonnet": { deny: ["exec"] },
          "openrouter/anthropic/claude-sonnet": { deny: ["read"] },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveEffectiveToolPolicy({
        config: cfg,
        modelProvider: "openrouter",
        modelId: "anthropic/claude-sonnet",
      }).globalProviderPolicy,
    ).toEqual({ deny: ["read"] });
  });

  it("does not let slash-containing modelId select another provider policy", () => {
    const cfg = {
      tools: {
        byProvider: {
          "anthropic/claude-sonnet": { deny: ["exec"] },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveEffectiveToolPolicy({
        config: cfg,
        modelProvider: "openrouter",
        modelId: "anthropic/claude-sonnet",
      }).globalProviderPolicy,
    ).toBeUndefined();
  });

  it("does not implicitly re-expose exec when tools.exec is configured (#47487)", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        exec: { host: "sandbox" },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toBeUndefined();
  });

  it("does not implicitly re-expose fs tools when tools.fs is configured (#47487)", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toBeUndefined();
  });

  it("explicit alsoAllow works without implicit widening (#47487)", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        alsoAllow: ["web_search"],
        exec: { host: "sandbox" },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["web_search"]);
  });

  it("does not implicitly re-expose fs tools from agent tool sections (#47487)", () => {
    const cfg = {
      tools: {
        profile: "messaging",
      },
      agents: {
        list: [
          {
            id: "coder",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg, agentId: "coder" });
    expect(result.profileAlsoAllow).toBeUndefined();
  });

  it("global tools.exec does not widen agent messaging profile (#47487)", () => {
    const cfg = {
      tools: {
        exec: { mode: "allowlist" },
      },
      agents: {
        list: [
          {
            id: "messenger",
            tools: {
              profile: "messaging",
              alsoAllow: ["view_image"],
            },
          },
        ],
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg, agentId: "messenger" });
    expect(result.profileAlsoAllow).toEqual(["view_image"]);
    expect(result.profileAlsoAllow).not.toContain("exec");
    expect(result.profileAlsoAllow).not.toContain("process");
  });

  it("does not warn an agent profile about inherited global tool sections (#47487)", async () => {
    const warnLogs = createWarnLogCapture("openclaw-agent-tools-policy-test");
    try {
      const cfg = {
        tools: {
          exec: { mode: "allowlist" },
          fs: { workspaceOnly: true },
        },
        agents: {
          list: [
            {
              id: "sage",
              tools: {
                profile: "messaging",
                alsoAllow: ["view_image"],
              },
            },
          ],
        },
      } as OpenClawConfig;

      resolveEffectiveToolPolicy({ config: cfg, agentId: "sage" });

      expect(await warnLogs.findText('tools policy: profile "messaging"')).toBeUndefined();
    } finally {
      warnLogs.cleanup();
    }
  });

  it("still warns when an agent profile has its own configured exec section (#47487)", async () => {
    const warnLogs = createWarnLogCapture("openclaw-agent-tools-policy-test");
    try {
      const cfg = {
        agents: {
          list: [
            {
              id: "sage",
              tools: {
                profile: "messaging",
                exec: { mode: "allowlist" },
              },
            },
          ],
        },
      } as OpenClawConfig;

      resolveEffectiveToolPolicy({ config: cfg, agentId: "sage" });

      const warning = await warnLogs.findText('tools policy: profile "messaging"');
      expect(warning).toContain('(agent "sage")');
      expect(warning).toContain("configured tool sections (tools.exec)");
      expect(warning).toContain('Add alsoAllow: ["exec", "process"]');
    } finally {
      warnLogs.cleanup();
    }
  });

  it.each<{
    name: string;
    tools?: OpenClawConfig["tools"];
    agentTools?: AgentToolsConfig;
    warning?: string;
  }>([
    { name: "global deny", tools: { deny: ["process"] } },
    {
      name: "global provider wildcard deny",
      tools: { byProvider: { fixture: { deny: ["pro*"] } } },
    },
    { name: "agent group deny", agentTools: { deny: ["group:runtime"] } },
    { name: "agent provider deny", agentTools: { byProvider: { fixture: { deny: ["process"] } } } },
    { name: "global allow restriction", tools: { allow: ["exec"] } },
    {
      name: "provider profile",
      tools: { byProvider: { fixture: { profile: "minimal" as const } } },
    },
    {
      name: "provider profile alsoAllow",
      tools: { byProvider: { fixture: { profile: "minimal" as const, alsoAllow: ["process"] } } },
      warning: 'Add alsoAllow: ["process"]',
    },
    {
      name: "unselected provider deny",
      tools: { byProvider: { other: { deny: ["*"] } } },
      warning: 'Add alsoAllow: ["process"]',
    },
  ])("warns only about actionable grants with $name", async ({ tools, agentTools, warning }) => {
    const warnLogs = createWarnLogCapture("openclaw-agent-tools-policy-test");
    try {
      const config: OpenClawConfig = {
        tools,
        agents: {
          entries: {
            ops: {
              tools: {
                profile: "messaging",
                alsoAllow: ["exec"],
                exec: { host: "gateway" },
                ...agentTools,
              },
            },
          },
        },
      };
      const result = resolveEffectiveToolPolicy({
        config,
        agentId: "ops",
        modelProvider: "fixture",
      });
      const logged = await warnLogs.findText('tools policy: profile "messaging"');
      if (warning) {
        expect(logged).toContain(warning);
      } else {
        expect(logged).toBeUndefined();
      }
      expect(result.profileAlsoAllow).toEqual(["exec"]);
    } finally {
      warnLogs.cleanup();
    }
  });

  it("only lists configured sections whose grants are still missing (#47487)", async () => {
    const warnLogs = createWarnLogCapture("openclaw-agent-tools-policy-test");
    try {
      const cfg = {
        agents: {
          list: [
            {
              id: "echo",
              tools: {
                profile: "messaging",
                alsoAllow: ["read", "write", "edit"],
                exec: { mode: "allowlist" },
                fs: { workspaceOnly: true },
              },
            },
          ],
        },
      } as OpenClawConfig;

      resolveEffectiveToolPolicy({ config: cfg, agentId: "echo" });

      const warning = await warnLogs.findText('tools policy: profile "messaging"');
      expect(warning).toContain('(agent "echo")');
      expect(warning).toContain("configured tool sections (tools.exec)");
      expect(warning).not.toContain("tools.exec / tools.fs");
      expect(warning).toContain('Add alsoAllow: ["exec", "process"]');
      expect(warning).not.toContain('"read"');
      expect(warning).not.toContain('"write"');
      expect(warning).not.toContain('"edit"');
    } finally {
      warnLogs.cleanup();
    }
  });

  it("explicit alsoAllow with exec still grants exec under messaging profile", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        alsoAllow: ["exec", "process"],
        exec: { host: "sandbox" },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["exec", "process"]);
  });
});
