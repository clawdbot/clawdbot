import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
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
            agentRuntime: { fallback: "pi" },
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
            id: "pi",
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

describe("legacy migrate heartbeat config", () => {
  it("moves top-level heartbeat into agents.defaults.heartbeat", () => {
    const res = migrateLegacyConfigForTest({
      heartbeat: {
        model: "anthropic/claude-3-5-haiku-20241022",
        every: "30m",
      },
    });

    expect(res.changes).toStrictEqual(["Moved heartbeat → agents.defaults.heartbeat."]);
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      model: "anthropic/claude-3-5-haiku-20241022",
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
    ]);
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
      target: "telegram",
      model: "anthropic/claude-3-5-haiku-20241022",
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
      model: "anthropic/claude-3-5-haiku-20241022",
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
});
