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

describe("legacy migrate channel streaming aliases", () => {
  it("migrates Telegram and Slack preview-channel legacy streaming fields without rewriting Discord", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        telegram: {
          streamMode: "block",
          chunkMode: "newline",
          blockStreaming: true,
          draftChunk: {
            minChars: 120,
          },
          blockStreamingCoalesce: {
            idleMs: 250,
          },
        },
        discord: {
          streaming: false,
          chunkMode: "newline",
          blockStreaming: true,
          draftChunk: {
            maxChars: 900,
          },
        },
        slack: {
          streamMode: "status_final",
          blockStreaming: true,
          blockStreamingCoalesce: {
            minChars: 100,
          },
          nativeStreaming: false,
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.telegram.streamMode → channels.telegram.streaming.mode (block).",
    );
    expect(res.changes).toContain(
      "Moved channels.telegram.chunkMode → channels.telegram.streaming.chunkMode.",
    );
    expect(res.changes).toContain(
      "Moved channels.telegram.blockStreaming → channels.telegram.streaming.block.enabled.",
    );
    expect(res.changes).toContain(
      "Moved channels.telegram.draftChunk → channels.telegram.streaming.preview.chunk.",
    );
    expect(res.changes).toContain(
      "Moved channels.telegram.blockStreamingCoalesce → channels.telegram.streaming.block.coalesce.",
    );
    expect(res.changes).toContain(
      "Moved channels.slack.streamMode → channels.slack.streaming.mode (progress).",
    );
    expect(res.changes).toContain(
      "Moved channels.slack.nativeStreaming → channels.slack.streaming.nativeTransport.",
    );
    expect(res.config?.channels?.telegram).toMatchObject({
      streaming: {
        mode: "block",
        chunkMode: "newline",
        block: {
          enabled: true,
          coalesce: {
            idleMs: 250,
          },
        },
        preview: {
          chunk: {
            minChars: 120,
          },
        },
      },
    });
    expect(res.config?.channels?.discord).toMatchObject({
      streaming: false,
      chunkMode: "newline",
      blockStreaming: true,
      draftChunk: {
        maxChars: 900,
      },
    });
    expect(res.config?.channels?.slack).toMatchObject({
      streaming: {
        mode: "progress",
        block: {
          enabled: true,
          coalesce: {
            minChars: 100,
          },
        },
        nativeTransport: false,
      },
    });
  });

  it("preserves slack streaming=false when deriving nativeTransport during migration", () => {
    const raw = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          streaming: false,
        },
      },
    };
    const res = migrateLegacyConfigForTest(raw);
    const migrated = migrateLegacyConfigForTest(raw);

    expect(res.changes).toContain(
      "Moved channels.slack.streaming (boolean) → channels.slack.streaming.mode (off).",
    );
    expect(migrated.config?.channels?.slack).toMatchObject({
      streaming: {
        mode: "off",
        nativeTransport: false,
      },
    });
  });

  it("rejects legacy googlechat streamMode aliases during validation and removes them in migration", () => {
    const raw = {
      channels: {
        googlechat: {
          streamMode: "append",
          accounts: {
            work: {
              streamMode: "replace",
            },
          },
        },
      },
    };

    const res = migrateLegacyConfigForTest(raw);
    expect(res.changes).toContain(
      "Removed channels.googlechat.streamMode (legacy key no longer used).",
    );
    expect(res.changes).toContain(
      "Removed channels.googlechat.accounts.work.streamMode (legacy key no longer used).",
    );
    expect(
      (res.config?.channels?.googlechat as Record<string, unknown> | undefined)?.streamMode,
    ).toBeUndefined();
    expect(
      (res.config?.channels?.googlechat?.accounts?.work as Record<string, unknown> | undefined)
        ?.streamMode,
    ).toBeUndefined();
  });
});

describe("legacy migrate nested channel enabled aliases", () => {
  it("rejects legacy allow aliases during validation and normalizes them in migration", () => {
    const raw = {
      channels: {
        slack: {
          channels: {
            ops: {
              allow: false,
            },
          },
        },
        googlechat: {
          groups: {
            "spaces/aaa": {
              allow: true,
            },
          },
        },
        discord: {
          guilds: {
            "100": {
              channels: {
                general: {
                  allow: false,
                },
              },
            },
          },
        },
      },
    };

    const migrated = migrateLegacyConfigForTest(raw);
    expect(migrated.config?.channels?.slack?.channels?.ops).toEqual({
      enabled: false,
    });
    expect(migrated.config?.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({
      enabled: true,
    });
    expect(migrated.config?.channels?.discord?.guilds?.["100"]?.channels?.general).toEqual({
      enabled: false,
    });
  });

  it("moves legacy allow toggles into enabled for slack, googlechat, and discord", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        slack: {
          channels: {
            ops: {
              allow: false,
            },
          },
          accounts: {
            work: {
              channels: {
                general: {
                  allow: true,
                },
              },
            },
          },
        },
        googlechat: {
          groups: {
            "spaces/aaa": {
              allow: false,
            },
          },
          accounts: {
            work: {
              groups: {
                "spaces/bbb": {
                  allow: true,
                },
              },
            },
          },
        },
        discord: {
          guilds: {
            "100": {
              channels: {
                general: {
                  allow: false,
                },
              },
            },
          },
          accounts: {
            work: {
              guilds: {
                "200": {
                  channels: {
                    help: {
                      allow: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.slack.channels.ops.allow → channels.slack.channels.ops.enabled.",
    );
    expect(res.changes).toContain(
      "Moved channels.slack.accounts.work.channels.general.allow → channels.slack.accounts.work.channels.general.enabled.",
    );
    expect(res.changes).toContain(
      "Moved channels.googlechat.groups.spaces/aaa.allow → channels.googlechat.groups.spaces/aaa.enabled.",
    );
    expect(res.changes).toContain(
      "Moved channels.googlechat.accounts.work.groups.spaces/bbb.allow → channels.googlechat.accounts.work.groups.spaces/bbb.enabled.",
    );
    expect(res.changes).toContain(
      "Moved channels.discord.guilds.100.channels.general.allow → channels.discord.guilds.100.channels.general.enabled.",
    );
    expect(res.changes).toContain(
      "Moved channels.discord.accounts.work.guilds.200.channels.help.allow → channels.discord.accounts.work.guilds.200.channels.help.enabled.",
    );
    expect(res.config?.channels?.slack?.channels?.ops).toEqual({
      enabled: false,
    });
    expect(res.config?.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({
      enabled: false,
    });
    expect(res.config?.channels?.discord?.guilds?.["100"]?.channels?.general).toEqual({
      enabled: false,
    });
  });

  it("drops legacy allow when enabled is already set", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        slack: {
          channels: {
            ops: {
              allow: true,
              enabled: false,
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Removed channels.slack.channels.ops.allow (channels.slack.channels.ops.enabled already set).",
    );
    expect(res.config?.channels?.slack?.channels?.ops).toEqual({
      enabled: false,
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
