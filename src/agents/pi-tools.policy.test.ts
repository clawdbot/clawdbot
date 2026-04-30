import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicyName,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
  resolveSubagentToolPolicyForSession,
  resolveTrustedGroupId,
} from "./pi-tools.policy.js";
import { createStubTool } from "./test-helpers/pi-tool-stubs.js";
import { providerAliasCases } from "./test-helpers/provider-alias-cases.js";

describe("pi-tools.policy", () => {
  it("treats * in allow as allow-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { allow: ["*"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "exec"]);
  });

  it("treats * in deny as deny-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { deny: ["*"] });
    expect(filtered).toEqual([]);
  });

  it("supports wildcard allow/deny patterns", () => {
    expect(isToolAllowedByPolicyName("web_fetch", { allow: ["web_*"] })).toBe(true);
    expect(isToolAllowedByPolicyName("web_search", { deny: ["web_*"] })).toBe(false);
  });

  it("keeps apply_patch when write is allowlisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["write"] })).toBe(true);
  });

  it("blocks apply_patch when write is denylisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write"] })).toBe(false);
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
});

describe("resolveSubagentToolPolicy depth awareness", () => {
  const baseCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
  } as unknown as OpenClawConfig;

  const deepCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 3 } } },
  } as unknown as OpenClawConfig;

  const leafCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
  } as unknown as OpenClawConfig;

  it("applies subagent tools.alsoAllow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
  });

  it("applies subagent tools.allow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { allow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
  });

  it("merges subagent tools.alsoAllow into tools.allow when both are set", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: { tools: { allow: ["sessions_spawn"], alsoAllow: ["sessions_send"] } },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toEqual(["sessions_spawn", "sessions_send"]);
  });

  it("keeps configured deny precedence over allow and alsoAllow", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: {
          tools: {
            allow: ["sessions_send"],
            alsoAllow: ["sessions_send"],
            deny: ["sessions_send"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(false);
  });

  it("applies configured deny to memory tools even though they are allowed by default", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: {
          tools: {
            deny: ["memory_search", "memory_get"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(false);
  });

  it("does not create a restrictive allowlist when only alsoAllow is configured", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toBeUndefined();
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows subagents", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_list", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(true);
  });

  it("depth-1 orchestrator still denies gateway and cron but allows memory tools", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("gateway", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(true);
  });

  it("depth-2 leaf denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 orchestrator (maxSpawnDepth=3) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-3 leaf (maxSpawnDepth=3) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 3);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 leaf denies subagents", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(false);
  });

  it("depth-2 leaf denies sessions_list and sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_list", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
  });

  it("uses stored leaf role for flat depth-1 session keys", () => {
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-subagent-policy-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:subagent:flat-leaf": {
            sessionId: "flat-leaf",
            updatedAt: Date.now(),
            spawnDepth: 1,
            subagentRole: "leaf",
            subagentControlScope: "none",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const cfg = {
      ...baseCfg,
      session: {
        store: storePath,
      },
    } as unknown as OpenClawConfig;

    const policy = resolveSubagentToolPolicyForSession(cfg, "agent:main:subagent:flat-leaf");
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(true);
  });

  it("defaults to leaf behavior when no depth is provided", () => {
    const policy = resolveSubagentToolPolicy(baseCfg);
    // Default depth=1, maxSpawnDepth=2 → orchestrator
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("defaults to leaf behavior when depth is undefined and maxSpawnDepth is 1", () => {
    const policy = resolveSubagentToolPolicy(leafCfg);
    // Default depth=1, maxSpawnDepth=1 → leaf
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });
});

describe("resolveEffectiveToolPolicy", () => {
  it.each(providerAliasCases)(
    "matches provider alias %s to canonical tools.byProvider key %s",
    (alias, canonical) => {
      const cfg = {
        tools: {
          byProvider: {
            [canonical]: { deny: ["exec"] },
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveEffectiveToolPolicy({ config: cfg, modelProvider: alias });

      expect(result.globalProviderPolicy).toEqual({ deny: ["exec"] });
    },
  );

  it.each(providerAliasCases)(
    "matches provider alias %s to canonical model-scoped tools.byProvider key %s",
    (alias, canonical) => {
      const cfg = {
        tools: {
          byProvider: {
            [`${canonical}/claude-sonnet`]: { deny: ["exec"] },
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveEffectiveToolPolicy({
        config: cfg,
        modelProvider: alias,
        modelId: "claude-sonnet",
      });

      expect(result.globalProviderPolicy).toEqual({ deny: ["exec"] });
    },
  );

  it("prefers canonical tools.byProvider policy when alias keys collide after normalization", () => {
    const aliasFirst = {
      tools: {
        byProvider: {
          bedrock: { deny: ["read"] },
          "amazon-bedrock": { deny: ["exec"] },
        },
      },
    } as unknown as OpenClawConfig;
    const canonicalFirst = {
      tools: {
        byProvider: {
          "amazon-bedrock": { deny: ["exec"] },
          bedrock: { deny: ["read"] },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveEffectiveToolPolicy({ config: aliasFirst, modelProvider: "bedrock" })
        .globalProviderPolicy,
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveEffectiveToolPolicy({ config: canonicalFirst, modelProvider: "bedrock" })
        .globalProviderPolicy,
    ).toEqual({ deny: ["exec"] });
  });

  it("prefers canonical model-scoped tools.byProvider policy when alias keys collide", () => {
    const aliasFirst = {
      tools: {
        byProvider: {
          "bedrock/claude-sonnet": { deny: ["read"] },
          "amazon-bedrock/claude-sonnet": { deny: ["exec"] },
        },
      },
    } as unknown as OpenClawConfig;
    const canonicalFirst = {
      tools: {
        byProvider: {
          "amazon-bedrock/claude-sonnet": { deny: ["exec"] },
          "bedrock/claude-sonnet": { deny: ["read"] },
        },
      },
    } as unknown as OpenClawConfig;
    const params = { modelProvider: "bedrock", modelId: "claude-sonnet" };

    expect(
      resolveEffectiveToolPolicy({ config: aliasFirst, ...params }).globalProviderPolicy,
    ).toEqual({ deny: ["exec"] });
    expect(
      resolveEffectiveToolPolicy({ config: canonicalFirst, ...params }).globalProviderPolicy,
    ).toEqual({ deny: ["exec"] });
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

  it("implicitly re-exposes exec and process when tools.exec is configured", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        exec: { host: "sandbox" },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["exec", "process"]);
  });

  it("implicitly re-exposes read, write, and edit when tools.fs is configured", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["read", "write", "edit"]);
  });

  it("merges explicit alsoAllow with implicit tool-section exposure", () => {
    const cfg = {
      tools: {
        profile: "messaging",
        alsoAllow: ["web_search"],
        exec: { host: "sandbox" },
      },
    } as OpenClawConfig;
    const result = resolveEffectiveToolPolicy({ config: cfg });
    expect(result.profileAlsoAllow).toEqual(["web_search", "exec", "process"]);
  });

  it("uses agent tool sections when resolving implicit exposure", () => {
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
    expect(result.profileAlsoAllow).toEqual(["read", "write", "edit"]);
  });
});
