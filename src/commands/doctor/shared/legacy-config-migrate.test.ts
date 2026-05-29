import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { normalizeCompatibilityConfigValues } from "./legacy-config-core-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

function migrateLegacyConfigForTest(raw: unknown): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { config: null, changes: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }
  return changes.length === 0
    ? { config: null, changes }
    : { config: next as OpenClawConfig, changes };
}

function expectMigrationChangesToIncludeFragments(changes: string[], fragments: string[]): void {
  const unmatchedFragments = fragments.filter((fragment) =>
    changes.every((change) => !change.includes(fragment)),
  );
  expect(unmatchedFragments).toStrictEqual([]);
}

describe("compatibility binding repair migrate", () => {
  it("prunes bindings for missing agents when agents.list is valid", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        list: [{ id: "alpha" }],
      },
      bindings: [
        { agentId: "alpha", match: { channel: "discord" } },
        { agentId: "ghost", match: { channel: "discord" } },
      ],
    } as OpenClawConfig);

    expect(res.config.bindings).toEqual([{ agentId: "alpha", match: { channel: "discord" } }]);
    expect(res.changes).toContain("Removed 1 binding that referenced missing agents.list ids.");
  });

  it("leaves bindings untouched when agents.list has malformed entries", () => {
    const cfg = {
      agents: {
        list: [null, { id: 1 }, { id: "alpha" }],
      },
      bindings: [
        { agentId: "ghost", match: { channel: "discord" } },
        { agentId: "alpha", match: { channel: "discord" } },
      ],
    } as unknown as OpenClawConfig;

    const res = normalizeCompatibilityConfigValues(cfg);

    expect(res.config.bindings).toEqual(cfg.bindings);
    expect(res.changes).not.toContain("Removed 1 binding that referenced missing agents.list ids.");
  });
});

describe("legacy memory search config migrate", () => {
  it("rewrites top-level legacy auto provider after moving memorySearch into agent defaults", () => {
    const raw = {
      memorySearch: {
        provider: "auto",
        model: "text-embedding-3-small",
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual([
      "memorySearch",
      "memorySearch.provider",
    ]);

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.defaults?.memorySearch).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(res.config).not.toHaveProperty("memorySearch");
    expect(res.changes).toEqual([
      "Moved memorySearch → agents.defaults.memorySearch.",
      'Moved agents.defaults.memorySearch.provider from legacy "auto" to "openai".',
    ]);
  });

  it("rewrites default and per-agent legacy auto memory providers", () => {
    const raw = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "auto",
          },
        },
        list: [
          {
            id: "local",
            memorySearch: {
              provider: " auto ",
            },
          },
          {
            id: "custom",
            memorySearch: {
              provider: "openai-compatible",
            },
          },
        ],
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual([
      "agents.defaults.memorySearch.provider",
      "agents.list",
    ]);

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.defaults?.memorySearch?.provider).toBe("openai");
    expect(res.config?.agents?.list?.[0]?.memorySearch?.provider).toBe("openai");
    expect(res.config?.agents?.list?.[1]?.memorySearch?.provider).toBe("openai-compatible");
    expect(res.changes).toEqual([
      'Moved agents.defaults.memorySearch.provider from legacy "auto" to "openai".',
      'Moved agents.list.0.memorySearch.provider from legacy "auto" to "openai".',
    ]);
  });
});

describe("legacy silent reply config migrate", () => {
  it("removes silent reply rewrite and direct-chat silent reply config", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          silentReply: {
            direct: "allow",
            group: "allow",
            internal: "allow",
          },
          silentReplyRewrite: {
            direct: true,
            group: false,
          },
        },
      },
      surfaces: {
        telegram: {
          silentReply: {
            direct: "disallow",
            group: "allow",
          },
          silentReplyRewrite: {
            direct: true,
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.silentReply).toEqual({
      group: "allow",
      internal: "allow",
    });
    expect(res.config?.agents?.defaults).not.toHaveProperty("silentReplyRewrite");
    expect(res.config?.surfaces?.telegram?.silentReply).toEqual({ group: "allow" });
    expect(res.config?.surfaces?.telegram).not.toHaveProperty("silentReplyRewrite");
    expectMigrationChangesToIncludeFragments(res.changes, [
      "Removed agents.defaults.silentReply.direct",
      "Removed agents.defaults.silentReplyRewrite",
      "Removed surfaces.telegram.silentReply.direct",
      "Removed surfaces.telegram.silentReplyRewrite",
    ]);
  });

  it("removes malformed silent reply rewrite keys by presence", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          silentReplyRewrite: true,
        },
      },
      surfaces: {
        telegram: {
          silentReplyRewrite: false,
        },
      },
    });

    expect(res.config?.agents?.defaults).not.toHaveProperty("silentReplyRewrite");
    expect(res.config?.surfaces?.telegram).not.toHaveProperty("silentReplyRewrite");
    expectMigrationChangesToIncludeFragments(res.changes, [
      "Removed agents.defaults.silentReplyRewrite",
      "Removed surfaces.telegram.silentReplyRewrite",
    ]);
  });
});

describe("legacy agent system prompt override config migrate", () => {
  it("removes default and per-agent system prompt overrides", () => {
    const raw = {
      agents: {
        defaults: {
          systemPromptOverride: "old default prompt",
          model: {
            primary: "openai/gpt-5.5",
          },
        },
        list: [
          {
            id: "alpha",
            systemPromptOverride: "old alpha prompt",
          },
          {
            id: "beta",
          },
        ],
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual([
      "agents.defaults.systemPromptOverride",
      "agents.list",
    ]);

    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.agents?.defaults).not.toHaveProperty("systemPromptOverride");
    expect(res.config?.agents?.list?.[0]).not.toHaveProperty("systemPromptOverride");
    expect(res.config?.agents?.list?.[1]).toEqual({ id: "beta" });
    expect(res.changes).toEqual([
      "Removed agents.defaults.systemPromptOverride.",
      "Removed agents.list.0.systemPromptOverride.",
    ]);
  });
});

describe("profile configured tool section migrate", () => {
  it("does not add grants when configured sections are the only signal", () => {
    const raw = {
      tools: {
        profile: "messaging",
        alsoAllow: ["read", "write"],
        exec: { security: "allowlist" },
        fs: { workspaceOnly: true },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: { security: "allowlist" },
            },
          },
        ],
      },
    };
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config).toBeNull();
    expect(res.changes).toEqual([]);
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).not.toContain("tools");
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).not.toContain("agents.list");
  });

  it("does not add missing grants to an unrelated allowlist", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["message"],
        exec: { security: "allowlist" },
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toEqual([]);
  });

  it("sets profile full when an allowlist already contains configured-section grants", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["message", "exec", "process"],
        exec: { security: "allowlist" },
      },
    });

    expect(res.config?.tools?.allow).toEqual(["message", "exec", "process"]);
    expect(res.config?.tools?.profile).toBe("full");
    expect(res.config?.tools).not.toHaveProperty("alsoAllow");
    expect(res.changes).toEqual([
      'Replaced tools.allow entries with profile "messaging" grants plus explicit configured-section grants.',
      'Set tools.profile to "full" so tools.allow controls explicit configured-section grants directly.',
    ]);
  });

  it("merges same-scope alsoAllow when it contains explicit configured-section grants", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["message"],
        alsoAllow: ["exec"],
        exec: { security: "allowlist" },
      },
    });

    expect(res.config?.tools?.allow).toEqual(["message", "exec"]);
    expect(res.config?.tools?.profile).toBe("full");
    expect(res.config?.tools).not.toHaveProperty("alsoAllow");
    expect(res.changes).toContain("Merged tools.alsoAllow into tools.allow.");
    expect(res.config?.tools?.allow).not.toContain("process");
  });

  it("repairs configured-section grants held in allow when alsoAllow is also present", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["message", "exec", "process"],
        alsoAllow: ["browser"],
        exec: { security: "allowlist" },
      },
    });

    expect(res.config?.tools?.allow).toEqual(["message", "browser", "exec", "process"]);
    expect(res.config?.tools?.profile).toBe("full");
    expect(res.config?.tools).not.toHaveProperty("alsoAllow");
  });

  it("narrows broad allowlists before making them authoritative", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["*"],
        exec: { security: "allowlist" },
      },
    });

    expect(res.config?.tools?.profile).toBe("full");
    expect(res.config?.tools?.allow).toContain("message");
    expect(res.config?.tools?.allow).toContain("exec");
    expect(res.config?.tools?.allow).toContain("process");
    expect(res.config?.tools?.allow).not.toContain("*");
    expect(res.config?.tools?.allow).not.toContain("read");
    expect(res.changes).toContain(
      'Replaced tools.allow entries with profile "messaging" grants plus explicit configured-section grants.',
    );
  });

  it("does not treat unrelated globs or plugin allow entries as configured-section grants", () => {
    const glob = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["sessions_*"],
        exec: { security: "allowlist" },
      },
    });
    const plugin = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
        allow: ["gmail_search"],
        exec: { security: "allowlist" },
      },
    });

    expect(glob.config).toBeNull();
    expect(plugin.config).toBeNull();
  });

  it("repairs agent allowlists with explicit configured-section grants under an inherited profile", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        profile: "messaging",
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              allow: ["message", "exec", "process"],
              exec: { security: "allowlist" },
            },
          },
        ],
      },
    });

    expect(res.config?.agents?.list?.[0]?.tools?.profile).toBe("full");
    expect(res.config?.agents?.list?.[0]?.tools?.allow).toEqual(["message", "exec", "process"]);
  });

  it("does not materialize provider grants when no provider grant intent is explicit", () => {
    const raw = {
      tools: {
        exec: { security: "allowlist" },
        byProvider: {
          openai: {
            profile: "messaging",
          },
        },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: { security: "allowlist" },
            },
          },
        ],
      },
    };
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config).toBeNull();
    expect(res.changes).toEqual([]);
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).not.toContain("agents.list");
  });

  it("does not report inherited top-level profile provider allowlists as fixable", () => {
    const raw = {
      tools: {
        profile: "messaging",
        exec: { security: "allowlist" },
        byProvider: {
          openai: {
            allow: ["message", "exec", "process"],
          },
        },
      },
    };
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config).toBeNull();
    expect(res.changes).toEqual([]);
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).not.toContain("tools");
  });

  it("sets provider profile full when provider allow already contains configured-section grants", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        exec: { security: "allowlist" },
        byProvider: {
          openai: {
            profile: "messaging",
            allow: ["message", "exec", "process"],
          },
        },
      },
    });

    expect(res.config?.tools?.byProvider?.openai?.allow).toEqual(["message", "exec", "process"]);
    expect(res.config?.tools?.byProvider?.openai?.profile).toBe("full");
    expect(res.changes).toContain(
      'Set tools.byProvider.openai.profile to "full" so tools.byProvider.openai.allow controls explicit configured-section grants directly.',
    );
  });

  it("repairs model-scoped provider allowlists with inherited provider profiles", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        byProvider: {
          qwen: {
            profile: "messaging",
          },
        },
      },
      agents: {
        list: [
          {
            id: "sage",
            tools: {
              exec: { security: "allowlist" },
              byProvider: {
                "qwen/qwen-plus": {
                  allow: ["message", "exec", "process"],
                },
              },
            },
          },
        ],
      },
    });

    expect(res.config?.agents?.list?.[0]?.tools?.byProvider?.["qwen/qwen-plus"]?.allow).toEqual([
      "message",
      "exec",
      "process",
    ]);
    expect(res.config?.agents?.list?.[0]?.tools?.byProvider?.["qwen/qwen-plus"]?.profile).toBe(
      "full",
    );
  });

  it("ignores blocked inherited provider keys while resolving provider repairs", () => {
    const raw = JSON.parse(
      '{"tools":{"byProvider":{"__proto__":{"profile":"messaging"},"qwen":{"profile":"messaging"}}},"agents":{"list":[{"id":"sage","tools":{"exec":{"security":"allowlist"},"byProvider":{"qwen/qwen-plus":{"allow":["message","exec","process"]}}}}]}}',
    );
    const res = migrateLegacyConfigForTest(raw);

    expect(Object.prototype).not.toHaveProperty("profile");
    expect(res.config?.agents?.list?.[0]?.tools?.byProvider?.["qwen/qwen-plus"]?.profile).toBe(
      "full",
    );
  });
});

describe("legacy agent model timeout migrate", () => {
  it("removes ignored timeoutMs from agent and subagent model selection config", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
            timeoutMs: 30_000,
          },
          subagents: {
            model: {
              primary: "openai/gpt-5.4",
              timeoutMs: 10_000,
            },
          },
          imageGenerationModel: {
            primary: "openrouter/openai/gpt-5.4-image-2",
            timeoutMs: 180_000,
          },
          pdfModel: {
            primary: "openai/gpt-5.5",
            timeoutMs: 45_000,
          },
        },
        list: [
          {
            id: "worker",
            model: {
              primary: "openai/gpt-5.4",
              timeoutMs: 20_000,
            },
            subagents: {
              model: {
                primary: "openai/gpt-5.4-mini",
                timeoutMs: 5_000,
              },
            },
          },
        ],
      },
    });

    const root = res.config as Record<string, unknown> | null;
    const agents = root?.agents as Record<string, unknown>;
    const defaults = agents.defaults as Record<string, unknown>;
    const defaultSubagents = defaults.subagents as Record<string, unknown>;
    const list = agents.list as Array<Record<string, unknown>>;
    const firstAgent = list[0];
    const firstSubagents = firstAgent.subagents as Record<string, unknown>;

    expect(defaults.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(defaultSubagents.model).toEqual({
      primary: "openai/gpt-5.4",
    });
    expect(defaults.imageGenerationModel).toEqual({
      primary: "openrouter/openai/gpt-5.4-image-2",
      timeoutMs: 180_000,
    });
    expect(defaults.pdfModel).toEqual({
      primary: "openai/gpt-5.5",
      timeoutMs: 45_000,
    });
    expect(firstAgent.model).toEqual({
      primary: "openai/gpt-5.4",
    });
    expect(firstSubagents.model).toEqual({
      primary: "openai/gpt-5.4-mini",
    });
    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.model.timeoutMs; agent model config only selects models.",
      "Removed agents.defaults.subagents.model.timeoutMs; agent model config only selects models.",
      "Removed agents.list.0.model.timeoutMs; agent model config only selects models.",
      "Removed agents.list.0.subagents.model.timeoutMs; agent model config only selects models.",
    ]);
  });
});

describe("legacy session maintenance migrate", () => {
  it("removes deprecated session.maintenance.rotateBytes", () => {
    const res = migrateLegacyConfigForTest({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 500,
          rotateBytes: "10mb",
        },
      },
    });

    expect(res.config?.session?.maintenance).toEqual({
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
    });
    expect(res.changes).toStrictEqual(["Removed deprecated session.maintenance.rotateBytes."]);
  });
});

describe("legacy session parent fork migrate", () => {
  it("removes legacy session.parentForkMaxTokens", () => {
    const res = migrateLegacyConfigForTest({
      session: {
        store: "sessions.json",
        parentForkMaxTokens: 200_000,
      },
    });

    expect(res.config?.session).toEqual({
      store: "sessions.json",
    });
    expect(res.changes).toStrictEqual([
      "Removed session.parentForkMaxTokens; parent fork sizing is automatic.",
    ]);
  });
});

describe("legacy diagnostics memory pressure snapshot migrate", () => {
  it("renames the boolean toggle", () => {
    const res = migrateLegacyConfigForTest({
      diagnostics: {
        enabled: true,
        memoryPressureBundle: false,
      },
    });

    expect(res.config?.diagnostics).toEqual({
      enabled: true,
      memoryPressureSnapshot: false,
    });
    expect(res.changes).toStrictEqual([
      "Moved diagnostics.memoryPressureBundle → memoryPressureSnapshot.",
    ]);
  });

  it("preserves the renamed toggle when both keys are present", () => {
    const res = migrateLegacyConfigForTest({
      diagnostics: {
        memoryPressureBundle: false,
        memoryPressureSnapshot: true,
      },
    });

    expect(res.config?.diagnostics).toEqual({
      memoryPressureSnapshot: true,
    });
    expect(res.changes).toStrictEqual([
      "Removed diagnostics.memoryPressureBundle (memoryPressureSnapshot already set).",
    ]);
  });

  it("moves nested enabled to the renamed boolean", () => {
    const res = migrateLegacyConfigForTest({
      diagnostics: {
        enabled: true,
        memoryPressureBundle: {
          enabled: false,
        },
      },
    });

    expect(res.config?.diagnostics).toEqual({
      enabled: true,
      memoryPressureSnapshot: false,
    });
    expect(res.changes).toStrictEqual([
      "Moved diagnostics.memoryPressureBundle → memoryPressureSnapshot.",
    ]);
  });

  it("moves empty object form to the renamed default boolean", () => {
    const res = migrateLegacyConfigForTest({
      diagnostics: {
        memoryPressureBundle: {},
      },
    });

    expect(res.config?.diagnostics).toEqual({
      memoryPressureSnapshot: true,
    });
    expect(res.changes).toStrictEqual([
      "Moved diagnostics.memoryPressureBundle → memoryPressureSnapshot.",
    ]);
  });
});

describe("legacy thread binding spawn migrate", () => {
  it("moves matching split spawn flags to unified spawnSessions", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnSubagentSessions: true,
            spawnAcpSessions: true,
          },
        },
      },
    });

    expect(res.config?.channels?.discord?.threadBindings).toEqual({
      enabled: true,
      spawnSessions: true,
    });
    expect(res.changes).toStrictEqual([
      "Moved channels.discord.threadBindings.spawnSubagentSessions/spawnAcpSessions → channels.discord.threadBindings.spawnSessions (true).",
    ]);
  });

  it("collapses conflicting split spawn flags conservatively", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        discord: {
          accounts: {
            work: {
              threadBindings: {
                spawnSubagentSessions: true,
                spawnAcpSessions: false,
              },
            },
          },
        },
      },
    });

    expect(
      res.config?.channels?.discord?.accounts?.work?.threadBindings as Record<string, unknown>,
    ).toEqual({
      spawnSessions: false,
    });
    expect(res.changes).toStrictEqual([
      "Collapsed conflicting channels.discord.accounts.work.threadBindings.spawnSubagentSessions/spawnAcpSessions → channels.discord.accounts.work.threadBindings.spawnSessions (false).",
    ]);
  });
});

describe("legacy Feishu account bot name migrate", () => {
  it("moves legacy account botName to name", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        feishu: {
          accounts: {
            main: {
              appId: "cli_xxx",
              appSecret: "redacted",
              botName: "Legacy Feishu Bot",
              domain: "feishu",
            },
          },
        },
      },
    });

    expect(res.config?.channels?.feishu?.accounts?.main).toEqual({
      appId: "cli_xxx",
      appSecret: "redacted",
      name: "Legacy Feishu Bot",
      domain: "feishu",
    });
    expect(res.changes).toStrictEqual([
      "Moved channels.feishu.accounts.main.botName → channels.feishu.accounts.main.name.",
    ]);
  });

  it("removes legacy account botName when name is already set", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        feishu: {
          accounts: {
            main: {
              name: "Current Feishu Bot",
              botName: "Legacy Feishu Bot",
            },
          },
        },
      },
    });

    expect(res.config?.channels?.feishu?.accounts?.main).toEqual({
      name: "Current Feishu Bot",
    });
    expect(res.changes).toStrictEqual([
      "Removed channels.feishu.accounts.main.botName (channels.feishu.accounts.main.name already set).",
    ]);
  });
});

describe("legacy message queue mode migrate", () => {
  it("moves retired queue steering modes to followup mode", () => {
    const res = migrateLegacyConfigForTest({
      messages: {
        queue: {
          mode: "queue",
          byChannel: {
            discord: "steer-backlog",
            telegram: "collect",
            slack: "steer",
          },
        },
      },
    });

    expect(res.config?.messages?.queue).toEqual({
      mode: "steer",
      byChannel: {
        discord: "followup",
        telegram: "collect",
        slack: "steer",
      },
    });
    expect(res.changes).toContain(
      'Moved deprecated messages.queue.mode "queue" → "steer"; use "steer" for default active-run steering.',
    );
    expect(res.changes).toContain(
      'Moved deprecated messages.queue.byChannel.discord "steer-backlog" → "followup"; use "steer" for default active-run steering.',
    );
  });
});

describe("legacy migrate audio transcription", () => {
  it("does not rewrite removed routing.transcribeAudio migrations", () => {
    const res = migrateLegacyConfigForTest({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "base"],
          timeoutSeconds: 2,
        },
      },
    });

    expect(res.changes).toStrictEqual([]);
    expect(res.config).toBeNull();
  });

  it("does not rewrite removed routing.transcribeAudio migrations when new config exists", () => {
    const res = migrateLegacyConfigForTest({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "tiny"],
        },
      },
      tools: {
        media: {
          audio: {
            models: [{ command: "existing", type: "cli" }],
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([]);
    expect(res.config).toBeNull();
  });

  it("drops invalid audio.transcription payloads", () => {
    const res = migrateLegacyConfigForTest({
      audio: {
        transcription: {
          command: [{}],
        },
      },
    });

    expect(res.changes).toStrictEqual(["Removed audio.transcription (invalid or empty command)."]);
    expect(res.config?.audio).toBeUndefined();
    expect(res.config?.tools?.media?.audio).toBeUndefined();
  });

  it("rewrites legacy audio {input} placeholders to media templates", () => {
    const res = migrateLegacyConfigForTest({
      audio: {
        transcription: {
          command: ["whisper-cli", "--model", "small", "{input}", "--input={input}"],
          timeoutSeconds: 30,
        },
      },
    });

    expect(res.changes).toStrictEqual(["Moved audio.transcription → tools.media.audio.models."]);
    expect(res.config?.audio).toBeUndefined();
    expect(res.config?.tools?.media?.audio?.models).toEqual([
      {
        type: "cli",
        command: "whisper-cli",
        args: ["--model", "small", "{{MediaPath}}", "--input={{MediaPath}}"],
        timeoutSeconds: 30,
      },
    ]);
  });
});

describe("legacy migrate mention routing", () => {
  it("moves legacy routing group chat settings into current channel and message config", () => {
    const res = migrateLegacyConfigForTest({
      routing: {
        allowFrom: ["+15550001111"],
        groupChat: {
          requireMention: false,
          historyLimit: 12,
          mentionPatterns: ["@openclaw"],
        },
      },
      channels: {
        whatsapp: {},
        telegram: {
          groups: {
            "*": { requireMention: true },
          },
        },
        imessage: {},
      },
    });

    const migratedConfig = res.config as Record<string, unknown> | null;
    expect(migratedConfig?.routing).toBeUndefined();
    expect(res.config?.channels?.whatsapp?.allowFrom).toEqual(["+15550001111"]);
    expect(res.config?.channels?.whatsapp?.groups).toEqual({
      "*": { requireMention: false },
    });
    expect(res.config?.channels?.telegram?.groups).toEqual({
      "*": { requireMention: true },
    });
    expect(res.config?.channels?.imessage?.groups).toEqual({
      "*": { requireMention: false },
    });
    expect(res.config?.messages?.groupChat).toEqual({
      historyLimit: 12,
      mentionPatterns: ["@openclaw"],
    });
    expect(res.changes).toStrictEqual([
      "Moved routing.allowFrom → channels.whatsapp.allowFrom.",
      'Moved routing.groupChat.requireMention → channels.whatsapp.groups."*".requireMention.',
      'Removed routing.groupChat.requireMention (channels.telegram.groups."*" already set).',
      'Moved routing.groupChat.requireMention → channels.imessage.groups."*".requireMention.',
      "Moved routing.groupChat.historyLimit → messages.groupChat.historyLimit.",
      "Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.",
    ]);
  });

  it("removes legacy routing requireMention when no compatible channel exists", () => {
    const res = migrateLegacyConfigForTest({
      routing: {
        groupChat: {
          requireMention: true,
        },
      },
    });

    const migratedConfig = res.config as Record<string, unknown> | null;
    expect(migratedConfig?.routing).toBeUndefined();
    expect(res.changes).toEqual([
      "Removed routing.groupChat.requireMention (no configured WhatsApp, Telegram, or iMessage channel found).",
    ]);
  });

  it("moves channels.telegram.requireMention into the wildcard group default", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        telegram: {
          requireMention: false,
        },
      },
    });

    expect(res.config?.channels?.telegram).toEqual({
      groups: {
        "*": { requireMention: false },
      },
    });
    expect(res.changes).toStrictEqual([
      'Moved channels.telegram.requireMention → channels.telegram.groups."*".requireMention.',
    ]);
  });
});

describe("legacy migrate sandbox scope aliases", () => {
  it("removes legacy agents.defaults.llm timeout config", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          llm: {
            idleTimeoutSeconds: 120,
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds within the agent/run timeout ceiling.",
    ]);
    expect(res.config?.agents?.defaults).toEqual({
      model: { primary: "openai/gpt-5.4" },
    });
  });

  it("removes ignored agent-wide runtime policy", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          embeddedHarness: {
            runtime: "claude-cli",
            fallback: "none",
          },
        },
        list: [
          {
            id: "reviewer",
            agentRuntime: { fallback: "openclaw" },
            embeddedHarness: {
              runtime: "codex",
              fallback: "none",
            },
          },
        ],
      },
    });

    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.embeddedHarness; runtime is now provider/model scoped.",
      "Removed agents.list.0.embeddedHarness; runtime is now provider/model scoped.",
      "Removed agents.list.0.agentRuntime; runtime is now provider/model scoped.",
    ]);
    expect(res.config?.agents?.defaults).toStrictEqual({});
    expect(res.config?.agents?.list?.[0]).toEqual({
      id: "reviewer",
    });
  });

  it("moves recoverable whole-agent Claude CLI runtime policy before removing stale pins", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
          },
          models: {
            "anthropic/claude-opus-4-7": { alias: "Opus" },
          },
        },
        list: [
          {
            id: "paige",
            agentRuntime: { id: "claude-cli" },
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved agents.defaults.agentRuntime.id claude-cli to matching anthropic model runtime policy.",
      "Removed agents.defaults.agentRuntime; runtime is now provider/model scoped.",
      "Moved agents.list.0.agentRuntime.id claude-cli to matching anthropic model runtime policy.",
      "Removed agents.list.0.agentRuntime; runtime is now provider/model scoped.",
    ]);
    expect(res.config?.agents?.defaults).toEqual({
      model: {
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
      },
      models: {
        "anthropic/claude-opus-4-7": {
          alias: "Opus",
          agentRuntime: { id: "claude-cli" },
        },
        "anthropic/claude-sonnet-4-6": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    });
    expect(res.config?.agents?.list?.[0]).toEqual({
      id: "paige",
      model: "anthropic/claude-sonnet-4-6",
      models: {
        "anthropic/claude-sonnet-4-6": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    });
  });

  it("does not overwrite explicit model runtime when removing stale whole-agent policy", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          model: "anthropic/claude-opus-4-7",
          models: {
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.agentRuntime; runtime is now provider/model scoped.",
    ]);
    expect(res.config?.agents?.defaults).toEqual({
      model: "anthropic/claude-opus-4-7",
      models: {
        "anthropic/claude-opus-4-7": { agentRuntime: { id: "openclaw" } },
      },
    });
  });

  it("moves legacy embeddedPi config into embeddedAgent", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          embeddedPi: {
            projectSettingsPolicy: "sanitize",
            executionContract: "strict-agentic",
          },
        },
        list: [
          {
            id: "worker",
            embeddedPi: {
              executionContract: "strict-agentic",
            },
          },
        ],
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved agents.defaults.embeddedPi → agents.defaults.embeddedAgent.",
      "Moved agents.list.0.embeddedPi → agents.list.0.embeddedAgent.",
    ]);
    expect(res.config?.agents?.defaults).toEqual({
      embeddedAgent: {
        projectSettingsPolicy: "sanitize",
        executionContract: "strict-agentic",
      },
    });
    expect(res.config?.agents?.list?.[0]).toEqual({
      id: "worker",
      embeddedAgent: {
        executionContract: "strict-agentic",
      },
    });
  });

  it("merges legacy embeddedPi config without overwriting embeddedAgent", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          embeddedAgent: {
            executionContract: "default",
          },
          embeddedPi: {
            projectSettingsPolicy: "sanitize",
            executionContract: "strict-agentic",
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Merged agents.defaults.embeddedPi → agents.defaults.embeddedAgent (filled missing fields from legacy; kept explicit embeddedAgent values).",
    ]);
    expect(res.config?.agents?.defaults).toEqual({
      embeddedAgent: {
        executionContract: "default",
        projectSettingsPolicy: "sanitize",
      },
    });
  });

  it("moves agents.defaults.sandbox.perSession into scope", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          sandbox: {
            perSession: true,
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved agents.defaults.sandbox.perSession → agents.defaults.sandbox.scope (session).",
    ]);
    expect(res.config?.agents?.defaults?.sandbox).toEqual({
      scope: "session",
    });
  });

  it("moves agents.list[].sandbox.perSession into scope", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        list: [
          {
            id: "openclaw",
            sandbox: {
              perSession: false,
            },
          },
        ],
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved agents.list.0.sandbox.perSession → agents.list.0.sandbox.scope (shared).",
    ]);
    expect(res.config?.agents?.list?.[0]?.sandbox).toEqual({
      scope: "shared",
    });
  });

  it("drops legacy sandbox perSession when scope is already set", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          sandbox: {
            scope: "agent",
            perSession: true,
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.sandbox.perSession (agents.defaults.sandbox.scope already set).",
    ]);
    expect(res.config?.agents?.defaults?.sandbox).toEqual({
      scope: "agent",
    });
  });

  it("does not migrate invalid sandbox perSession values", () => {
    const raw = {
      agents: {
        defaults: {
          sandbox: {
            perSession: "yes",
          },
        },
      },
    };

    const res = migrateLegacyConfigForTest(raw);

    expect(res.changes).toStrictEqual([]);
    expect(res.config).toBeNull();
  });
});

describe("legacy migrate MCP server type aliases", () => {
  it("moves CLI-native http type to OpenClaw streamable HTTP transport", () => {
    const res = migrateLegacyConfigForTest({
      mcp: {
        servers: {
          silo: {
            type: "http",
            url: "https://example.com/mcp",
          },
          legacySse: {
            type: "sse",
            url: "https://example.com/sse",
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      'Moved mcp.servers.silo.type "http" → transport "streamable-http".',
      'Moved mcp.servers.legacySse.type "sse" → transport "sse".',
    ]);
    expect(res.config?.mcp?.servers?.silo).toEqual({
      url: "https://example.com/mcp",
      transport: "streamable-http",
    });
    expect(res.config?.mcp?.servers?.legacySse).toEqual({
      url: "https://example.com/sse",
      transport: "sse",
    });
  });

  it("removes CLI-native type when canonical transport is already set", () => {
    const res = migrateLegacyConfigForTest({
      mcp: {
        servers: {
          mixed: {
            type: "http",
            transport: "sse",
            url: "https://example.com/mcp",
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      'Removed mcp.servers.mixed.type (transport "sse" already set).',
    ]);
    expect(res.config?.mcp?.servers?.mixed).toEqual({
      url: "https://example.com/mcp",
      transport: "sse",
    });
  });
});

describe("legacy migrate x_search auth", () => {
  it("moves only legacy x_search auth into plugin-owned xai config", () => {
    const res = migrateLegacyConfigForTest({
      tools: {
        web: {
          x_search: {
            apiKey: "xai-legacy-key",
            enabled: true,
            model: "grok-4-1-fast",
          },
        },
      },
    });

    expect((res.config?.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(res.config?.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-legacy-key",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.",
    ]);
  });
});

describe("legacy bundled provider discovery migrate", () => {
  it("sets compat mode for existing restrictive plugin allowlists", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        allow: ["telegram"],
      },
    });

    expect(res.config?.plugins?.bundledDiscovery).toBe("compat");
    expect(res.changes).toStrictEqual([
      'Set plugins.bundledDiscovery="compat" to preserve legacy bundled provider discovery for this restrictive plugins.allow config.',
    ]);
  });

  it("does not override explicit bundled discovery mode", () => {
    const res = migrateLegacyConfigForTest({
      plugins: {
        allow: ["telegram"],
        bundledDiscovery: "allowlist",
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });
});

describe("legacy migrate heartbeat config", () => {
  it("moves top-level heartbeat into agents.defaults.heartbeat", () => {
    const res = migrateLegacyConfigForTest({
      heartbeat: {
        model: "anthropic/claude-3-5-haiku-20241022",
        every: "30m",
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved heartbeat → agents.defaults.heartbeat.",
      'Upgraded config.agents.defaults.heartbeat.model from "anthropic/claude-3-5-haiku-20241022" to "anthropic/claude-sonnet-4-6".',
    ]);
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      every: "30m",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("moves top-level heartbeat visibility into channels.defaults.heartbeat", () => {
    const res = migrateLegacyConfigForTest({
      heartbeat: {
        showOk: true,
        showAlerts: false,
        useIndicator: false,
      },
    });

    expect(res.changes).toStrictEqual([
      "Moved heartbeat visibility → channels.defaults.heartbeat.",
    ]);
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({
      showOk: true,
      showAlerts: false,
      useIndicator: false,
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("keeps explicit agents.defaults.heartbeat values when merging top-level heartbeat", () => {
    const res = migrateLegacyConfigForTest({
      heartbeat: {
        model: "anthropic/claude-3-5-haiku-20241022",
        every: "30m",
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            target: "telegram",
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Merged heartbeat → agents.defaults.heartbeat (filled missing fields from legacy; kept explicit agents.defaults values).",
      'Upgraded config.agents.defaults.heartbeat.model from "anthropic/claude-3-5-haiku-20241022" to "anthropic/claude-sonnet-4-6".',
    ]);
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
      target: "telegram",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("keeps explicit channels.defaults.heartbeat values when merging top-level heartbeat visibility", () => {
    const res = migrateLegacyConfigForTest({
      heartbeat: {
        showOk: true,
        showAlerts: true,
      },
      channels: {
        defaults: {
          heartbeat: {
            showOk: false,
            useIndicator: false,
          },
        },
      },
    });

    expect(res.changes).toStrictEqual([
      "Merged heartbeat visibility → channels.defaults.heartbeat (filled missing fields from legacy; kept explicit channels.defaults values).",
    ]);
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: false,
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("preserves agents.defaults.heartbeat precedence over top-level heartbeat legacy key", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            target: "telegram",
          },
        },
      },
      heartbeat: {
        every: "30m",
        target: "discord",
        model: "anthropic/claude-3-5-haiku-20241022",
      },
    });

    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
      target: "telegram",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("drops blocked prototype keys when migrating top-level heartbeat", () => {
    const res = migrateLegacyConfigForTest(
      JSON.parse(
        '{"heartbeat":{"every":"30m","__proto__":{"polluted":true},"showOk":true}}',
      ) as Record<string, unknown>,
    );

    const heartbeat = res.config?.agents?.defaults?.heartbeat as
      | Record<string, unknown>
      | undefined;
    expect(heartbeat?.every).toBe("30m");
    expect((heartbeat as { polluted?: unknown } | undefined)?.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(heartbeat ?? {}, "__proto__")).toBe(false);
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({ showOk: true });
  });

  it("records a migration change when removing empty top-level heartbeat", () => {
    const res = migrateLegacyConfigForTest({
      heartbeat: {},
    });

    expect(res.changes).toStrictEqual(["Removed empty top-level heartbeat."]);
    if (res.config === null) {
      throw new Error("Expected migrated config");
    }
    expect((res.config as { heartbeat?: unknown }).heartbeat).toBeUndefined();
  });
});

describe("legacy migrate controlUi.allowedOrigins seed (issue #29385)", () => {
  it("seeds allowedOrigins for bind=lan with no existing controlUi config", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(res.changes).toStrictEqual([
      'Seeded gateway.controlUi.allowedOrigins ["http://localhost:18789","http://127.0.0.1:18789"] for bind=lan. Required since v2026.2.26. Add other machine origins to gateway.controlUi.allowedOrigins if needed.',
    ]);
  });

  it("seeds allowedOrigins using configured port", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "lan",
        port: 9000,
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:9000",
      "http://127.0.0.1:9000",
    ]);
  });

  it("seeds allowedOrigins including custom bind host for bind=custom", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.100",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
      "http://192.168.1.100:18789",
    ]);
  });

  it("does not overwrite existing allowedOrigins — returns null (no migration needed)", () => {
    // When allowedOrigins already exists, the migration is a no-op.
    // applyLegacyDoctorMigrations returns next=null when changes.length===0, so config is null.
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { allowedOrigins: ["https://control.example.com"] },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });

  it("does not migrate when dangerouslyAllowHostHeaderOriginFallback is set — returns null", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });

  it("seeds allowedOrigins when existing entries are blank strings", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { allowedOrigins: ["", "   "] },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(res.changes).toStrictEqual([
      'Seeded gateway.controlUi.allowedOrigins ["http://localhost:18789","http://127.0.0.1:18789"] for bind=lan. Required since v2026.2.26. Add other machine origins to gateway.controlUi.allowedOrigins if needed.',
    ]);
  });

  it("does not migrate loopback bind — returns null", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });

  it("preserves existing controlUi fields when seeding allowedOrigins", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { basePath: "/app" },
      },
    });
    expect(res.config?.gateway?.controlUi?.basePath).toBe("/app");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });

  it("seeds allowedOrigins for non-loopback host aliases before normalizing bind", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "0.0.0.0",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.bind).toBe("lan");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(res.changes).toStrictEqual([
      'Seeded gateway.controlUi.allowedOrigins ["http://localhost:18789","http://127.0.0.1:18789"] for bind=lan. Required since v2026.2.26. Add other machine origins to gateway.controlUi.allowedOrigins if needed.',
      'Normalized gateway.bind "0.0.0.0" → "lan".',
    ]);
  });

  it("does not seed allowedOrigins for loopback host aliases", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "localhost",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.bind).toBe("loopback");
    expect(res.config?.gateway?.controlUi).toBeUndefined();
    expect(res.changes).toStrictEqual(['Normalized gateway.bind "localhost" → "loopback".']);
  });
});

describe("legacy model compat migrate", () => {
  it("upgrades retired model refs", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          workspace: "/tmp/claude-3-sonnet",
          imageModel: "anthropic/claude-haiku-4-5",
          imageGenerationModel: {
            primary: "github-copilot/claude-sonnet-4",
            fallbacks: ["github-copilot/grok-code-fast-1"],
          },
          musicGenerationModel: "vercel-ai-gateway/anthropic/claude-opus-4-5",
          pdfModel: "anthropic/claude-3-5-sonnet",
          videoGenerationModel: "anthropic/claude-opus-4-10",
          model: {
            primary: "anthropic/claude-opus-4-5@anthropic:work",
            fallbacks: [
              "anthropic/claude-sonnet-4-20250514",
              "github-copilot/claude-sonnet-4",
              "github-copilot/grok-code-fast-1@github:work",
              "venice/claude-opus-4-5",
              "vercel-ai-gateway/anthropic/claude-opus-4-5",
              "anthropic/claude-opus-5-0",
              "anthropic/claude-sonnet-4-7",
              "anthropic/claude-opus-4-10",
              "kilocode/anthropic/claude-sonnet-4",
              "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
              "openai/gpt-5.5",
              "openai/gpt-4o",
              "openai/gpt-4.1-mini",
              "openai/gpt-5.1-codex-mini",
              "openai/gpt-5.2-codex",
              "openai-codex/gpt-5.2",
              "openai-codex/gpt-5.1-codex-mini",
              "github-copilot/gpt-4.1",
              "github-copilot/gpt-5.2",
              "github-copilot/gpt-5.2-codex",
              "groq/llama3-70b-8192",
              "groq/gemma2-9b-it",
              "groq/moonshotai/kimi-k2-instruct-0905",
              "xai/grok-code-fast-1",
              "xai/grok-4-fast-reasoning",
              "openai/gpt-4o-transcribe",
              "openai/gpt-4o-mini-tts",
            ],
          },
          models: {
            "anthropic/claude-haiku-4-5": { alias: "haiku" },
            "anthropic/claude-sonnet-4-6": { alias: "current-sonnet" },
            "github-copilot/claude-opus-4.5": { alias: "copilot-opus" },
            "openai/gpt-5.2-pro": { alias: "old-pro" },
            "github-copilot/gpt-5-mini": { alias: "old-mini" },
          },
        },
      },
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryModel: "anthropic/claude-3-5-sonnet",
              dataPath: "/tmp/claude-opus-4-5",
            },
            subagent: {
              allowedModels: ["anthropic/claude-haiku-4-5", "*"],
            },
          },
        },
      },
      channels: {
        modelByChannel: {
          telegram: {
            "*": "anthropic/claude-opus-4-5",
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.imageModel).toBe("anthropic/claude-haiku-4-5");
    expect(res.config?.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "github-copilot/claude-sonnet-4.6",
      fallbacks: ["github-copilot/gpt-5.4-mini"],
    });
    expect(res.config?.agents?.defaults?.musicGenerationModel).toBe(
      "vercel-ai-gateway/anthropic/claude-opus-4-6",
    );
    expect(res.config?.agents?.defaults?.pdfModel).toBe("anthropic/claude-sonnet-4-6");
    expect(res.config?.agents?.defaults?.videoGenerationModel).toBe("anthropic/claude-opus-4-10");
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-7@anthropic:work",
      fallbacks: [
        "anthropic/claude-sonnet-4-6",
        "github-copilot/claude-sonnet-4.6",
        "github-copilot/gpt-5.4-mini@github:work",
        "venice/claude-opus-4-6",
        "vercel-ai-gateway/anthropic/claude-opus-4-6",
        "anthropic/claude-opus-5-0",
        "anthropic/claude-sonnet-4-7",
        "anthropic/claude-opus-4-10",
        "kilocode/anthropic/claude-sonnet-4",
        "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
        "openai/gpt-5.5",
        "openai/gpt-5.5",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.3-codex",
        "openai-codex/gpt-5.5",
        "openai-codex/gpt-5.4-mini",
        "github-copilot/gpt-5.5",
        "github-copilot/gpt-5.5",
        "github-copilot/gpt-5.3-codex",
        "groq/llama-3.3-70b-versatile",
        "groq/llama-3.1-8b-instant",
        "groq/openai/gpt-oss-120b",
        "xai/grok-build-0.1",
        "xai/grok-4.3",
        "openai/gpt-4o-transcribe",
        "openai/gpt-4o-mini-tts",
      ],
    });
    expect(res.config?.agents?.defaults?.workspace).toBe("/tmp/claude-3-sonnet");
    expect(res.config?.agents?.defaults?.models).toEqual({
      "anthropic/claude-haiku-4-5": { alias: "haiku" },
      "anthropic/claude-sonnet-4-6": { alias: "current-sonnet" },
      "github-copilot/claude-opus-4.7": { alias: "copilot-opus" },
      "openai/gpt-5.5-pro": { alias: "old-pro" },
      "github-copilot/gpt-5.4-mini": { alias: "old-mini" },
    });
    expect(
      (res.config?.plugins?.entries?.["lossless-claw"] as { config?: { summaryModel?: string } })
        ?.config?.summaryModel,
    ).toBe("anthropic/claude-sonnet-4-6");
    expect(
      (res.config?.plugins?.entries?.["lossless-claw"] as { config?: { dataPath?: string } })
        ?.config?.dataPath,
    ).toBe("/tmp/claude-opus-4-5");
    expect(
      (
        res.config?.plugins?.entries?.["lossless-claw"] as {
          subagent?: { allowedModels?: string[] };
        }
      )?.subagent?.allowedModels,
    ).toEqual(["anthropic/claude-haiku-4-5", "*"]);
    expect(res.config?.channels?.modelByChannel?.telegram?.["*"]).toBe("anthropic/claude-opus-4-7");
    expectMigrationChangesToIncludeFragments(res.changes, [
      'config.agents.defaults.imageGenerationModel.primary from "github-copilot/claude-sonnet-4" to "github-copilot/claude-sonnet-4.6"',
      'config.agents.defaults.imageGenerationModel.fallbacks.0 from "github-copilot/grok-code-fast-1" to "github-copilot/gpt-5.4-mini"',
      'config.agents.defaults.musicGenerationModel from "vercel-ai-gateway/anthropic/claude-opus-4-5" to "vercel-ai-gateway/anthropic/claude-opus-4-6"',
      'config.agents.defaults.pdfModel from "anthropic/claude-3-5-sonnet" to "anthropic/claude-sonnet-4-6"',
      'config.agents.defaults.model.primary from "anthropic/claude-opus-4-5@anthropic:work" to "anthropic/claude-opus-4-7@anthropic:work"',
      'config.agents.defaults.model.fallbacks.2 from "github-copilot/grok-code-fast-1@github:work" to "github-copilot/gpt-5.4-mini@github:work"',
      'config.agents.defaults.model.fallbacks.3 from "venice/claude-opus-4-5" to "venice/claude-opus-4-6"',
      'config.agents.defaults.model.fallbacks.4 from "vercel-ai-gateway/anthropic/claude-opus-4-5" to "vercel-ai-gateway/anthropic/claude-opus-4-6"',
      'config.agents.defaults.model.fallbacks.11 from "openai/gpt-4o" to "openai/gpt-5.5"',
      'config.agents.defaults.model.fallbacks.12 from "openai/gpt-4.1-mini" to "openai/gpt-5.4-mini"',
      'config.agents.defaults.model.fallbacks.13 from "openai/gpt-5.1-codex-mini" to "openai/gpt-5.4-mini"',
      'config.agents.defaults.model.fallbacks.14 from "openai/gpt-5.2-codex" to "openai/gpt-5.3-codex"',
      'config.agents.defaults.model.fallbacks.15 from "openai-codex/gpt-5.2" to "openai-codex/gpt-5.5"',
      'config.agents.defaults.model.fallbacks.16 from "openai-codex/gpt-5.1-codex-mini" to "openai-codex/gpt-5.4-mini"',
      'config.agents.defaults.model.fallbacks.17 from "github-copilot/gpt-4.1" to "github-copilot/gpt-5.5"',
      'config.agents.defaults.model.fallbacks.18 from "github-copilot/gpt-5.2" to "github-copilot/gpt-5.5"',
      'config.agents.defaults.model.fallbacks.19 from "github-copilot/gpt-5.2-codex" to "github-copilot/gpt-5.3-codex"',
      'config.agents.defaults.model.fallbacks.20 from "groq/llama3-70b-8192" to "groq/llama-3.3-70b-versatile"',
      'config.agents.defaults.model.fallbacks.21 from "groq/gemma2-9b-it" to "groq/llama-3.1-8b-instant"',
      'config.agents.defaults.model.fallbacks.22 from "groq/moonshotai/kimi-k2-instruct-0905" to "groq/openai/gpt-oss-120b"',
      'config.agents.defaults.model.fallbacks.23 from "xai/grok-code-fast-1" to "xai/grok-build-0.1"',
      'config.agents.defaults.model.fallbacks.24 from "xai/grok-4-fast-reasoning" to "xai/grok-4.3"',
      'config.agents.defaults.models key from "github-copilot/claude-opus-4.5" to "github-copilot/claude-opus-4.7"',
      'config.agents.defaults.models key from "openai/gpt-5.2-pro" to "openai/gpt-5.5-pro"',
      'config.agents.defaults.models key from "github-copilot/gpt-5-mini" to "github-copilot/gpt-5.4-mini"',
      'config.plugins.entries.lossless-claw.config.summaryModel from "anthropic/claude-3-5-sonnet" to "anthropic/claude-sonnet-4-6"',
      'config.channels.modelByChannel.telegram.* from "anthropic/claude-opus-4-5" to "anthropic/claude-opus-4-7"',
    ]);
  });

  it("removes unrecognized model compat thinkingFormat values", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          bailian: {
            models: [
              {
                id: "qwen-legacy",
                name: "Qwen Legacy",
                compat: {
                  thinkingFormat: "bailian-legacy",
                  supportsTools: true,
                },
              },
            ],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.bailian?.models?.[0]?.compat).toEqual({
      supportsTools: true,
    });
    expect(res.changes).toStrictEqual([
      'Removed models.providers.bailian.models.0.compat.thinkingFormat (unrecognized value "bailian-legacy"; runtime default applies).',
    ]);
  });

  it("moves legacy vLLM Qwen thinking params to model compat", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {
              params: {
                qwenThinkingFormat: "chat-template",
                temperature: 0.2,
              },
            },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            models: [{ id: "Qwen/Qwen3-8B", name: "Qwen3 8B" }],
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.models?.["vllm/Qwen/Qwen3-8B"]?.params).toEqual({
      temperature: 0.2,
    });
    expect(res.config?.models?.providers?.vllm?.models?.[0]?.compat).toEqual({
      thinkingFormat: "qwen-chat-template",
    });
    expect(res.config?.models?.providers?.vllm?.models?.[0]?.reasoning).toBe(true);
    expect(res.changes).toStrictEqual([
      'Moved agents.defaults.models."vllm/Qwen/Qwen3-8B".params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("moves legacy vLLM Qwen thinking params from normalized agent model refs", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "VLLM/Qwen/Qwen3-8B": {
              params: {
                qwenThinkingFormat: "chat-template",
              },
            },
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.models?.["VLLM/Qwen/Qwen3-8B"]).not.toHaveProperty(
      "params",
    );
    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved agents.defaults.models."VLLM/Qwen/Qwen3-8B".params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("creates a vLLM model row for legacy Qwen top-level thinking params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {
              params: {
                qwen_thinking_format: "enable_thinking",
              },
            },
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.models?.["vllm/Qwen/Qwen3-8B"]).not.toHaveProperty(
      "params",
    );
    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved agents.defaults.models."vllm/Qwen/Qwen3-8B".params.qwen_thinking_format to models.providers.vllm.models[0].compat.thinkingFormat ("qwen").',
    ]);
  });

  it("preserves existing vLLM model compat when removing legacy Qwen thinking params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {
              params: {
                qwenThinkingFormat: "top-level",
              },
            },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            models: [
              {
                id: "Qwen/Qwen3-8B",
                compat: { thinkingFormat: "qwen-chat-template" },
              },
            ],
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.models?.["vllm/Qwen/Qwen3-8B"]).not.toHaveProperty(
      "params",
    );
    expect(res.config?.models?.providers?.vllm?.models?.[0]?.compat).toEqual({
      thinkingFormat: "qwen-chat-template",
    });
    expect(res.config?.models?.providers?.vllm?.models?.[0]?.reasoning).toBe(true);
    expect(res.changes).toStrictEqual([
      'Removed agents.defaults.models."vllm/Qwen/Qwen3-8B".params.qwenThinkingFormat; models.providers.vllm.models[0].compat.thinkingFormat is already "qwen-chat-template".',
    ]);
  });

  it("moves legacy vLLM Qwen thinking params onto provider-qualified model rows", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {
              params: {
                qwenThinkingFormat: "chat-template",
              },
            },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            models: [{ id: "vllm/Qwen/Qwen3-8B", name: "Qwen3 8B" }],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "vllm/Qwen/Qwen3-8B",
        name: "Qwen3 8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved agents.defaults.models."vllm/Qwen/Qwen3-8B".params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("moves legacy vLLM Qwen model-row params to model compat", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          vllm: {
            models: [
              {
                id: "Qwen/Qwen3-8B",
                name: "Qwen3 8B",
                params: {
                  qwenThinkingFormat: "chat-template",
                  temperature: 0.2,
                },
              },
            ],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm?.models?.[0]).toEqual({
      id: "Qwen/Qwen3-8B",
      name: "Qwen3 8B",
      reasoning: true,
      params: { temperature: 0.2 },
      compat: { thinkingFormat: "qwen-chat-template" },
    });
    expect(res.changes).toStrictEqual([
      'Moved models.providers.vllm.models[0].params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("moves legacy vLLM Qwen provider params to model compat rows", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          vllm: {
            params: {
              qwen_thinking_format: "enable_thinking",
              temperature: 0.2,
            },
            models: [
              { id: "Qwen/Qwen3-8B", name: "Qwen3 8B" },
              { id: "Qwen/Qwen3-14B", name: "Qwen3 14B" },
            ],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm?.params).toEqual({ temperature: 0.2 });
    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen3 8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen" },
      },
      {
        id: "Qwen/Qwen3-14B",
        name: "Qwen3 14B",
        reasoning: true,
        compat: { thinkingFormat: "qwen" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved models.providers.vllm.params.qwen_thinking_format to models.providers.vllm.models[0].compat.thinkingFormat ("qwen").',
      'Moved models.providers.vllm.params.qwen_thinking_format to models.providers.vllm.models[1].compat.thinkingFormat ("qwen").',
    ]);
  });

  it("moves legacy vLLM Qwen provider params to existing and selected model rows", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "vllm/Qwen/Qwen3-8B" },
        },
      },
      models: {
        providers: {
          vllm: {
            params: {
              qwenThinkingFormat: "chat-template",
            },
            models: [{ id: "Qwen/Qwen3-14B", name: "Qwen3 14B" }],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-14B",
        name: "Qwen3 14B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved models.providers.vllm.params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
      'Moved models.providers.vllm.params.qwenThinkingFormat to models.providers.vllm.models[1].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("removes untargeted legacy vLLM Qwen provider params", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:8000/v1",
            params: {
              qwenThinkingFormat: "chat-template",
              temperature: 0.2,
            },
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm).toEqual({
      baseUrl: "http://localhost:8000/v1",
      params: { temperature: 0.2 },
    });
    expect(res.changes).toStrictEqual([
      "Removed models.providers.vllm.params.qwenThinkingFormat; no concrete vLLM model row or agent model ref exists, so configure models.providers.vllm.models[].compat.thinkingFormat on each Qwen model that needs it.",
    ]);
  });

  it("moves legacy vLLM Qwen provider params using the default selected model", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "vllm/Qwen/Qwen3-8B" },
        },
      },
      models: {
        providers: {
          vllm: {
            params: {
              qwenThinkingFormat: "chat-template",
              temperature: 0.2,
            },
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm?.params).toEqual({ temperature: 0.2 });
    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved models.providers.vllm.params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("preserves normalized vLLM provider keys when moving provider params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "vllm/Qwen/Qwen3-8B" },
        },
      },
      models: {
        providers: {
          VLLM: {
            baseUrl: "http://localhost:8000/v1",
            params: {
              qwenThinkingFormat: "chat-template",
              temperature: 0.2,
            },
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm).toBeUndefined();
    expect(res.config?.models?.providers?.VLLM).toEqual({
      baseUrl: "http://localhost:8000/v1",
      params: { temperature: 0.2 },
      models: [
        {
          id: "Qwen/Qwen3-8B",
          name: "Qwen/Qwen3-8B",
          reasoning: true,
          compat: { thinkingFormat: "qwen-chat-template" },
        },
      ],
    });
    expect(res.changes).toStrictEqual([
      'Moved models.providers.vllm.params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("strips auth profile suffixes when moving legacy vLLM Qwen params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "vllm/Qwen/Qwen3-8B@local" },
        },
      },
      models: {
        providers: {
          vllm: {
            params: {
              qwenThinkingFormat: "chat-template",
            },
          },
        },
      },
    });

    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ]);
  });

  it("moves legacy vLLM Qwen default agent params to the selected model compat row", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: { primary: "vllm/Qwen/Qwen3-8B" },
          params: {
            qwenThinkingFormat: "chat-template",
            temperature: 0.2,
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.params).toEqual({ temperature: 0.2 });
    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved agents.defaults.params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("removes untargeted legacy vLLM Qwen default agent params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          params: {
            qwenThinkingFormat: "chat-template",
            temperature: 0.2,
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.params).toEqual({ temperature: 0.2 });
    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.params.qwenThinkingFormat; no concrete vLLM model row or agent model ref exists, so configure models.providers.vllm.models[].compat.thinkingFormat on each Qwen model that needs it.",
    ]);
  });

  it("moves legacy vLLM Qwen per-agent params to the agent model compat row", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        list: [
          {
            id: "local",
            model: "vllm/Qwen/Qwen3-8B",
            params: {
              qwen_thinking_format: "enable_thinking",
              temperature: 0.2,
            },
          },
        ],
      },
    });

    expect(res.config?.agents?.list?.[0]?.params).toEqual({ temperature: 0.2 });
    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved agents.list[0].params.qwen_thinking_format to models.providers.vllm.models[0].compat.thinkingFormat ("qwen").',
    ]);
  });

  it("removes untargeted legacy vLLM Qwen per-agent params", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        list: [
          {
            id: "local",
            params: {
              qwen_thinking_format: "enable_thinking",
              temperature: 0.2,
            },
          },
        ],
      },
    });

    expect(res.config?.agents?.list?.[0]?.params).toEqual({ temperature: 0.2 });
    expect(res.changes).toStrictEqual([
      "Removed agents.list[0].params.qwen_thinking_format; no concrete vLLM model row or agent model ref exists, so configure models.providers.vllm.models[].compat.thinkingFormat on each Qwen model that needs it.",
    ]);
  });

  it("moves legacy vLLM Qwen per-agent params using the inherited default model", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          model: "vllm/Qwen/Qwen3-8B",
        },
        list: [
          {
            id: "local",
            params: {
              qwenThinkingFormat: "chat-template",
            },
          },
        ],
      },
    });

    expect(res.config?.agents?.list?.[0]).not.toHaveProperty("params");
    expect(res.config?.models?.providers?.vllm?.models).toEqual([
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ]);
    expect(res.changes).toStrictEqual([
      'Moved agents.list[0].params.qwenThinkingFormat to models.providers.vllm.models[0].compat.thinkingFormat ("qwen-chat-template").',
    ]);
  });

  it("leaves legacy vLLM Qwen thinking params when the model compat row cannot be written", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {
              params: {
                qwenThinkingFormat: "chat-template",
              },
            },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            models: "malformed",
          },
        },
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });

  it("leaves malformed vLLM provider ancestors untouched during legacy Qwen migration", () => {
    const res = migrateLegacyConfigForTest({
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {
              params: {
                qwenThinkingFormat: "chat-template",
              },
            },
          },
        },
      },
      models: {
        providers: {
          vllm: "malformed",
        },
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });

  it("reports legacy vLLM Qwen thinking params before doctor fix", () => {
    const raw = {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {
              params: {
                qwenThinkingFormat: "chat-template",
              },
            },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain(
      "agents.defaults.models",
    );
  });

  it("reports legacy vLLM Qwen thinking params from merged extra-param sources", () => {
    const raw = {
      agents: {
        defaults: {
          params: {
            qwenThinkingFormat: "chat-template",
          },
        },
        list: [
          {
            id: "local",
            params: {
              qwen_thinking_format: "enable_thinking",
            },
          },
        ],
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["agents.defaults.params", "agents"]),
    );
  });

  it("reports legacy vLLM Qwen params from normalized provider keys", () => {
    const raw = {
      models: {
        providers: {
          VLLM: {
            params: {
              qwenThinkingFormat: "chat-template",
            },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("models.providers");
  });

  it("preserves recognized model compat thinkingFormat values", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          bailian: {
            models: [
              {
                id: "qwen3",
                name: "Qwen3",
                compat: {
                  thinkingFormat: "qwen",
                },
              },
            ],
          },
        },
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toStrictEqual([]);
  });

  it("selectively removes invalid thinkingFormat values across providers", () => {
    const res = migrateLegacyConfigForTest({
      models: {
        providers: {
          bailian: {
            models: [
              {
                id: "valid",
                name: "Valid",
                compat: { thinkingFormat: "qwen-chat-template" },
              },
              {
                id: "legacy",
                name: "Legacy",
                compat: { thinkingFormat: "old-bailian" },
              },
            ],
          },
          openrouter: {
            models: [
              {
                id: "legacy-router",
                name: "Legacy Router",
                compat: { thinkingFormat: "openrouter-v0" },
              },
            ],
          },
        },
      },
    });

    expect(res.config?.models?.providers?.bailian?.models?.[0]?.compat).toEqual({
      thinkingFormat: "qwen-chat-template",
    });
    expect(res.config?.models?.providers?.bailian?.models?.[1]?.compat).toEqual({});
    expect(res.config?.models?.providers?.openrouter?.models?.[0]?.compat).toEqual({});
    expect(res.changes).toStrictEqual([
      'Removed models.providers.bailian.models.1.compat.thinkingFormat (unrecognized value "old-bailian"; runtime default applies).',
      'Removed models.providers.openrouter.models.0.compat.thinkingFormat (unrecognized value "openrouter-v0"; runtime default applies).',
    ]);
  });
});
