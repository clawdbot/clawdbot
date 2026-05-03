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
    expect(res.changes).toContain("Removed deprecated session.maintenance.rotateBytes.");
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
    expect(res.changes).toContain(
      "Removed session.parentForkMaxTokens; parent fork sizing is automatic.",
    );
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
    expect(res.changes).toContain(
      "Moved channels.discord.threadBindings.spawnSubagentSessions/spawnAcpSessions → channels.discord.threadBindings.spawnSessions (true).",
    );
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
    expect(res.changes).toContain(
      "Collapsed conflicting channels.discord.accounts.work.threadBindings.spawnSubagentSessions/spawnAcpSessions → channels.discord.accounts.work.threadBindings.spawnSessions (false).",
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

    expect(res.changes).toEqual([]);
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

    expect(res.changes).toEqual([]);
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

    expect(res.changes).toContain("Removed audio.transcription (invalid or empty command).");
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

    expect(res.changes).toContain("Moved audio.transcription → tools.media.audio.models.");
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
  it("does not rewrite removed routing.groupChat.requireMention migrations", () => {
    const res = migrateLegacyConfigForTest({
      routing: {
        groupChat: {
          requireMention: true,
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });

  it("does not rewrite removed channels.telegram.requireMention migrations", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        telegram: {
          requireMention: false,
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
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

    expect(res.changes).toContain(
      "Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds.",
    );
    expect(res.config?.agents?.defaults).toEqual({
      model: { primary: "openai/gpt-5.4" },
    });
  });

  it("moves legacy embeddedHarness runtime policy into agentRuntime", () => {
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

    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Moved agents.defaults.embeddedHarness → agents.defaults.agentRuntime.",
        "Moved agents.list.0.embeddedHarness → agents.list.0.agentRuntime.",
      ]),
    );
    expect(res.config?.agents?.defaults).toEqual({
      agentRuntime: {
        id: "claude-cli",
      },
    });
    expect(res.config?.agents?.list?.[0]).toEqual({
      id: "reviewer",
      agentRuntime: {
        id: "codex",
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

    expect(res.changes).toContain(
      "Moved agents.defaults.sandbox.perSession → agents.defaults.sandbox.scope (session).",
    );
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

    expect(res.changes).toContain(
      "Moved agents.list.0.sandbox.perSession → agents.list.0.sandbox.scope (shared).",
    );
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

    expect(res.changes).toContain(
      "Removed agents.defaults.sandbox.perSession (agents.defaults.sandbox.scope already set).",
    );
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

    expect(res.changes).toEqual([]);
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

    expect(res.changes).toContain(
      'Moved mcp.servers.silo.type "http" → transport "streamable-http".',
    );
    expect(res.changes).toContain('Moved mcp.servers.legacySse.type "sse" → transport "sse".');
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

    expect(res.changes).toContain('Removed mcp.servers.mixed.type (transport "sse" already set).');
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

    expect(res.changes).toContain("Moved heartbeat → agents.defaults.heartbeat.");
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

    expect(res.changes).toContain("Moved heartbeat visibility → channels.defaults.heartbeat.");
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

    expect(res.changes).toContain(
      "Merged heartbeat → agents.defaults.heartbeat (filled missing fields from legacy; kept explicit agents.defaults values).",
    );
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

    expect(res.changes).toContain(
      "Merged heartbeat visibility → channels.defaults.heartbeat (filled missing fields from legacy; kept explicit channels.defaults values).",
    );
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

    expect(res.changes).toContain("Removed empty top-level heartbeat.");
    expect(res.config).not.toBeNull();
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
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
    expect(res.changes.some((c) => c.includes("gateway.controlUi.allowedOrigins"))).toBe(true);
    expect(res.changes.some((c) => c.includes("bind=lan"))).toBe(true);
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
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toContain("http://192.168.1.100:18789");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toContain("http://localhost:18789");
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
    expect(res.changes).toHaveLength(0);
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
    expect(res.changes).toHaveLength(0);
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
    expect(res.changes.some((c) => c.includes("gateway.controlUi.allowedOrigins"))).toBe(true);
  });

  it("does not migrate loopback bind — returns null", () => {
    const res = migrateLegacyConfigForTest({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
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
