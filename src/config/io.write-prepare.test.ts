import { describe, expect, it } from "vitest";
import {
  collectChangedPaths,
  formatConfigValidationFailure,
  applyUnsetPathsForWrite,
  restoreEnvRefsFromMap,
  resolvePersistCandidateForWrite,
  resolveWriteEnvSnapshotForPath,
  unsetPathForWrite,
} from "./io.write-prepare.js";
import type { OpenClawConfig } from "./types.js";

describe("config io write prepare", () => {
  it("persists caller changes onto resolved config without leaking runtime defaults", () => {
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        gateway: { port: 18789 },
        agents: { defaults: { cliBackend: "codex" } },
        messages: { ackReaction: "eyes" },
        sessions: { persistence: true },
      },
      sourceConfig: {
        gateway: { port: 18789 },
      },
      nextConfig: {
        gateway: {
          port: 18789,
          auth: { mode: "token" },
        },
      },
    }) as Record<string, unknown>;

    expect(persisted.gateway).toEqual({
      port: 18789,
      auth: { mode: "token" },
    });
    expect(persisted).not.toHaveProperty("agents.defaults");
    expect(persisted).not.toHaveProperty("messages.ackReaction");
    expect(persisted).not.toHaveProperty("sessions.persistence");
  });

  it("strips transient plugin install records from partial writes", () => {
    const persisted = applyUnsetPathsForWrite(
      resolvePersistCandidateForWrite({
        runtimeConfig: {
          plugins: {
            entries: {},
          },
        },
        sourceConfig: {
          plugins: {
            entries: {},
            installs: {
              "openclaw-web-search": {
                source: "npm",
                spec: "@ollama/openclaw-web-search",
                installPath: "/tmp/openclaw-web-search",
                resolvedName: "@ollama/openclaw-web-search",
                resolvedVersion: "0.2.2",
              },
            },
          },
        },
        nextConfig: {
          plugins: {
            entries: {},
            installs: {
              "openclaw-web-search": {
                source: "npm",
                spec: "@ollama/openclaw-web-search@0.2.2",
                installPath: "/tmp/openclaw-web-search",
                resolvedName: "@ollama/openclaw-web-search",
                resolvedVersion: "0.2.2",
              },
            },
          },
        },
      }) as OpenClawConfig,
      [["plugins", "installs"]],
    ) as {
      plugins?: {
        installs?: Record<string, Record<string, unknown>>;
      };
    };

    expect(persisted.plugins?.installs).toBeUndefined();
  });

  it("preserves authored agent provider params during narrowed agent-list writes", () => {
    const sourceConfig = {
      agents: {
        defaults: {
          params: { transport: "sse", openaiWsWarmup: false },
          models: {
            "openai/gpt-5.4": {
              alias: "GPT",
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
        list: [{ id: "main" }],
      },
      gateway: { mode: "local" },
    };
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        ...sourceConfig,
        agents: {
          ...sourceConfig.agents,
          defaults: {
            ...sourceConfig.agents.defaults,
            maxConcurrent: 4,
          },
        },
      },
      sourceConfig,
      nextConfig: {
        agents: { list: [{ id: "main" }, { id: "ops" }] },
        gateway: { mode: "local" },
      },
    }) as OpenClawConfig;

    expect(persisted.agents?.defaults?.params).toEqual({
      transport: "sse",
      openaiWsWarmup: false,
    });
    expect(persisted.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
      alias: "GPT",
      params: { transport: "sse", openaiWsWarmup: false },
    });
    expect(persisted.agents?.list).toEqual([{ id: "main" }, { id: "ops" }]);
  });

  it("preserves authored Google model params under normalized config keys", () => {
    const sourceConfig: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3-pro-preview" },
          models: {
            "google/gemini-3-pro-preview": {
              alias: "Gemini",
              params: { thinking: { level: "high" } },
            },
          },
        },
      },
    };
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: sourceConfig,
      sourceConfig,
      nextConfig: {
        agents: {
          defaults: {
            model: { primary: "google/gemini-3.1-pro-preview" },
            models: {
              "google/gemini-3.1-pro-preview": {},
            },
          },
        },
      },
    }) as OpenClawConfig;

    expect(persisted.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
    });
    expect(persisted.agents?.defaults?.models).not.toHaveProperty("google/gemini-3-pro-preview");
    expect(persisted.agents?.defaults?.models?.["google/gemini-3.1-pro-preview"]).toEqual({
      params: { thinking: { level: "high" } },
    });
  });

  it("normalizes retired Google model refs during unrelated config writes", () => {
    const sourceConfig: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-pro-preview",
            fallbacks: ["google/gemini-3-pro-preview", "openai/gpt-5.5"],
          },
          models: {
            "google/gemini-3-pro-preview": {
              alias: "Gemini",
            },
          },
        },
      },
      gateway: { port: 18789 },
    };
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3.1-pro-preview",
            fallbacks: ["google/gemini-3.1-pro-preview", "openai/gpt-5.5"],
          },
          models: {
            "google/gemini-3.1-pro-preview": {
              alias: "Gemini",
            },
          },
        },
      },
      gateway: { port: 18789 },
    };
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig,
      sourceConfig,
      nextConfig: {
        ...runtimeConfig,
        gateway: { port: 18888 },
      },
    }) as OpenClawConfig;

    expect(persisted.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview", "openai/gpt-5.5"],
    });
    expect(persisted.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "Gemini",
      },
    });
    expect(persisted.gateway?.port).toBe(18888);
  });

  it("normalizes retired Google provider catalog refs during unrelated config writes", () => {
    const makeModel = (id: string, name: string) => ({
      id,
      name,
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [makeModel("google/gemini-3-pro-preview", "Gemini 3 Pro")],
          },
          kilocode: {
            baseUrl: "https://kilocode.test/v1",
            models: [makeModel("google/gemini-3-pro-preview", "Gemini via Kilo")],
          },
        },
      },
      gateway: { port: 18789 },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [makeModel("google/gemini-3.1-pro-preview", "Gemini 3 Pro")],
          },
          kilocode: {
            baseUrl: "https://kilocode.test/v1",
            models: [makeModel("google/gemini-3.1-pro-preview", "Gemini via Kilo")],
          },
        },
      },
      gateway: { port: 18789 },
    };
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig,
      sourceConfig,
      nextConfig: {
        ...runtimeConfig,
        gateway: { port: 18888 },
      },
    }) as OpenClawConfig;

    expect(persisted.models?.providers?.google?.models).toEqual([
      makeModel("google/gemini-3.1-pro-preview", "Gemini 3 Pro"),
    ]);
    expect(persisted.models?.providers?.kilocode?.models).toEqual([
      makeModel("google/gemini-3.1-pro-preview", "Gemini via Kilo"),
    ]);
    expect(persisted.gateway?.port).toBe(18888);
  });

  it("allows explicit unsets to remove authored agent provider params", () => {
    const sourceConfig: OpenClawConfig = {
      agents: {
        defaults: {
          params: { transport: "sse", openaiWsWarmup: false },
          models: {
            "openai/gpt-5.4": {
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
    };
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: sourceConfig,
      sourceConfig,
      nextConfig: { agents: { defaults: { models: { "openai/gpt-5.4": {} } } } },
      unsetPaths: [
        ["agents", "defaults", "params"],
        ["agents", "defaults", "models", "openai/gpt-5.4", "params"],
      ],
    }) as OpenClawConfig;

    expect(persisted.agents?.defaults).not.toHaveProperty("params");
    expect(persisted.agents?.defaults?.models?.["openai/gpt-5.4"]).not.toHaveProperty("params");
  });

  it("preserves untouched include-owned subtrees during unrelated writes", () => {
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        agents: {
          defaults: { model: "openai/gpt-5.4" },
        },
        gateway: { mode: "local" },
      },
      sourceConfig: {
        agents: {
          defaults: { model: "openai/gpt-5.4" },
        },
        gateway: { mode: "local" },
      },
      rootAuthoredConfig: {
        agents: { $include: "./config/agents.json" },
        gateway: { mode: "local" },
      },
      nextConfig: {
        agents: {
          defaults: { model: "openai/gpt-5.4" },
        },
        gateway: { mode: "local", port: 18789 },
      },
    }) as Record<string, unknown>;

    expect(persisted.agents).toEqual({ $include: "./config/agents.json" });
    expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
  });

  it("rejects writes that would flatten include-owned subtrees", () => {
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: {
          agents: {
            defaults: { model: "openai/gpt-5.4" },
          },
        },
        sourceConfig: {
          agents: {
            defaults: { model: "openai/gpt-5.4" },
          },
        },
        rootAuthoredConfig: {
          agents: { $include: "./config/agents.json" },
        },
        nextConfig: {
          agents: {
            defaults: { model: "anthropic/sonnet-4.5" },
          },
        },
      }),
    ).toThrow("Config write would flatten $include-owned config at agents");
  });

  it('formats actionable guidance for dmPolicy="open" without wildcard allowFrom', () => {
    const message = formatConfigValidationFailure(
      "channels.telegram.allowFrom",
      'channels.telegram.dmPolicy = "open" requires channels.telegram.allowFrom to include "*"',
    );

    expect(message).toContain("openclaw config set channels.telegram.allowFrom '[\"*\"]'");
    expect(message).toContain('openclaw config set channels.telegram.dmPolicy "pairing"');
  });

  it("unsets explicit paths when runtime defaults would otherwise reappear", () => {
    const next = unsetPathForWrite(
      {
        gateway: { auth: { mode: "none" } },
        commands: { ownerDisplay: "hash" },
      },
      ["commands", "ownerDisplay"],
    );

    expect(next.changed).toBe(true);
    expect(next.next.commands ?? {}).not.toHaveProperty("ownerDisplay");
  });

  it("does not mutate caller config when unsetting existing config objects", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
    } satisfies OpenClawConfig;

    const next = unsetPathForWrite(input, ["commands", "ownerDisplay"]);

    expect(input).toEqual({
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
    });
    expect(next.next.commands ?? {}).not.toHaveProperty("ownerDisplay");
  });

  it("keeps caller arrays immutable when unsetting array entries", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      tools: { alsoAllow: ["exec", "fetch", "read"] },
    } satisfies OpenClawConfig;

    const next = unsetPathForWrite(input, ["tools", "alsoAllow", "1"]);

    expect(input.tools!.alsoAllow).toEqual(["exec", "fetch", "read"]);
    expect((next.next.tools as { alsoAllow?: string[] } | undefined)?.alsoAllow).toEqual([
      "exec",
      "read",
    ]);
  });

  it("treats missing unset paths as no-op without mutating caller config", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
    } satisfies OpenClawConfig;

    const next = unsetPathForWrite(input, ["commands", "missingKey"]);

    expect(next.changed).toBe(false);
    expect(next.next).toBe(input);
    expect(input).toEqual({
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
    });
  });

  it("ignores blocked prototype-key unset path segments", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
    } satisfies OpenClawConfig;

    const blocked = [
      ["commands", "__proto__"],
      ["commands", "constructor"],
      ["commands", "prototype"],
    ].map((segments) => unsetPathForWrite(input, segments));

    for (const result of blocked) {
      expect(result.changed).toBe(false);
      expect(result.next).toBe(input);
    }
    expect(input).toEqual({
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
    });
  });

  it("preserves env refs on unchanged paths while keeping changed paths resolved", () => {
    const changedPaths = new Set<string>();
    collectChangedPaths(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                env: { OPENAI_API_KEY: "sk-secret" },
              },
            },
          },
        },
        gateway: { port: 18789 },
      },
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                env: { OPENAI_API_KEY: "sk-secret" },
              },
            },
          },
        },
        gateway: {
          port: 18789,
          auth: { mode: "token" },
        },
      },
      "",
      changedPaths,
    );

    const restored = restoreEnvRefsFromMap(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                env: { OPENAI_API_KEY: "sk-secret" },
              },
            },
          },
        },
        gateway: {
          port: 18789,
          auth: { mode: "token" },
        },
      },
      "",
      new Map([["agents.defaults.cliBackends.codex.env.OPENAI_API_KEY", "${OPENAI_API_KEY}"]]),
      changedPaths,
    ) as {
      agents: { defaults: { cliBackends: { codex: { env: { OPENAI_API_KEY: string } } } } };
      gateway: { port: number; auth: { mode: string } };
    };

    expect(restored.agents.defaults.cliBackends.codex.env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
    expect(restored.gateway).toEqual({
      port: 18789,
      auth: { mode: "token" },
    });
  });

  it("preserves env refs in arrays while keeping appended entries resolved", () => {
    const changedPaths = new Set<string>();
    collectChangedPaths(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                args: ["${DISCORD_USER_ID}", "123"],
              },
            },
          },
        },
      },
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                args: ["${DISCORD_USER_ID}", "123", "456"],
              },
            },
          },
        },
      },
      "",
      changedPaths,
    );

    const restored = restoreEnvRefsFromMap(
      {
        agents: {
          defaults: {
            cliBackends: {
              codex: {
                args: ["999", "123", "456"],
              },
            },
          },
        },
      },
      "",
      new Map([["agents.defaults.cliBackends.codex.args[0]", "${DISCORD_USER_ID}"]]),
      changedPaths,
    ) as {
      agents: { defaults: { cliBackends: { codex: { args: string[] } } } };
    };

    expect(restored.agents.defaults.cliBackends.codex.args).toEqual([
      "${DISCORD_USER_ID}",
      "123",
      "456",
    ]);
  });

  it("keeps the read-time env snapshot when writing the same config path", () => {
    const snapshot = { OPENAI_API_KEY: "sk-secret" };
    expect(
      resolveWriteEnvSnapshotForPath({
        actualConfigPath: "/tmp/openclaw.json",
        expectedConfigPath: "/tmp/openclaw.json",
        envSnapshotForRestore: snapshot,
      }),
    ).toBe(snapshot);
  });

  it("drops the read-time env snapshot when writing a different config path", () => {
    expect(
      resolveWriteEnvSnapshotForPath({
        actualConfigPath: "/tmp/openclaw.json",
        expectedConfigPath: "/tmp/other.json",
        envSnapshotForRestore: { OPENAI_API_KEY: "sk-secret" },
      }),
    ).toBeUndefined();
  });

  it("keeps runtime-only channel defaults out of the persisted candidate", () => {
    const sourceConfig = {
      gateway: { port: 18789 },
      channels: {
        imessage: {
          cliPath: "/usr/local/bin/imsg",
        },
      },
    } satisfies OpenClawConfig;

    const runtimeConfig: OpenClawConfig = {
      gateway: { port: 18789 },
      channels: {
        imessage: {
          cliPath: "/usr/local/bin/imsg",
        },
      },
    } satisfies OpenClawConfig;
    (runtimeConfig.channels?.imessage as Record<string, unknown>).runtimeOnlyDefault = true;

    const nextConfig: OpenClawConfig = structuredClone(runtimeConfig);
    nextConfig.gateway = {
      ...nextConfig.gateway,
      auth: { mode: "token" },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig,
      sourceConfig,
      nextConfig,
    }) as Record<string, unknown>;

    expect(persisted.gateway).toEqual({
      port: 18789,
      auth: { mode: "token" },
    });
    const channels = persisted.channels as Record<string, Record<string, unknown>> | undefined;
    expect(channels?.imessage?.cliPath).toBe("/usr/local/bin/imsg");
    expect(channels?.imessage).not.toHaveProperty("runtimeOnlyDefault");
  });

  it("does not reintroduce legacy nested dm.policy defaults in the persisted candidate", () => {
    const sourceConfig: OpenClawConfig = {
      channels: {
        discord: {
          dmPolicy: "pairing",
          dm: { enabled: true, policy: "pairing" },
        },
        slack: {
          dmPolicy: "pairing",
          dm: { enabled: true, policy: "pairing" },
        },
      },
      gateway: { port: 18789 },
    } satisfies OpenClawConfig;

    const nextConfig = structuredClone(sourceConfig);
    delete (nextConfig.channels?.discord?.dm as { enabled?: boolean; policy?: string } | undefined)
      ?.policy;
    delete (nextConfig.channels?.slack?.dm as { enabled?: boolean; policy?: string } | undefined)
      ?.policy;

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: sourceConfig,
      sourceConfig,
      nextConfig,
    }) as {
      channels?: {
        discord?: { dm?: Record<string, unknown>; dmPolicy?: unknown };
        slack?: { dm?: Record<string, unknown>; dmPolicy?: unknown };
      };
    };

    expect(persisted.channels?.discord?.dmPolicy).toBe("pairing");
    expect(persisted.channels?.discord?.dm).toEqual({ enabled: true });
    expect(persisted.channels?.slack?.dmPolicy).toBe("pairing");
    expect(persisted.channels?.slack?.dm).toEqual({ enabled: true });
  });

  it("preserves normalized nested channel enabled keys during unrelated writes", () => {
    const sourceConfig = {
      channels: {
        slack: {
          channels: {
            ops: {
              enabled: false,
            },
          },
        },
        googlechat: {
          groups: {
            "spaces/aaa": {
              enabled: true,
            },
          },
        },
        discord: {
          guilds: {
            "100": {
              channels: {
                general: {
                  enabled: false,
                },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const nextConfig: OpenClawConfig = {
      ...structuredClone(sourceConfig),
      gateway: {
        auth: { mode: "token" },
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: sourceConfig,
      sourceConfig,
      nextConfig,
    }) as {
      channels?: {
        slack?: { channels?: Record<string, Record<string, unknown>> };
        googlechat?: { groups?: Record<string, Record<string, unknown>> };
        discord?: {
          guilds?: Record<string, { channels?: Record<string, Record<string, unknown>> }>;
        };
      };
      gateway?: Record<string, unknown>;
    };

    expect(persisted.gateway).toEqual({
      auth: { mode: "token" },
    });
    expect(persisted.channels?.slack?.channels?.ops).toEqual({ enabled: false });
    expect(persisted.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({ enabled: true });
    expect(persisted.channels?.discord?.guilds?.["100"]?.channels?.general).toEqual({
      enabled: false,
    });
  });

  it("preserves root $schema during unrelated partial writes", () => {
    const sourceConfig: OpenClawConfig = {
      $schema: "https://openclaw.ai/config.json",
      gateway: { mode: "local" },
    } satisfies OpenClawConfig;

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: sourceConfig,
      sourceConfig,
      nextConfig: {
        gateway: { mode: "local", port: 18789 },
      } satisfies OpenClawConfig,
    }) as OpenClawConfig;

    expect(persisted.$schema).toBe("https://openclaw.ai/config.json");
    expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
  });

  it("rejects writes that would flatten a root include", () => {
    const sourceConfig = {
      $schema: "https://openclaw.ai/config-from-include.json",
      gateway: { mode: "local" },
    };

    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: sourceConfig,
        sourceConfig,
        rootAuthoredConfig: {
          $include: "./extra.json5",
          gateway: { mode: "local" },
        },
        nextConfig: {
          gateway: { mode: "local", port: 18789 },
        },
      }),
    ).toThrow("Config write would flatten $include-owned config at <root>");
  });

  it("does not restore root $schema when the next config explicitly clears it", () => {
    const sourceConfig = {
      $schema: "https://openclaw.ai/config.json",
      gateway: { mode: "local" },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: sourceConfig,
      sourceConfig,
      nextConfig: {
        $schema: null,
        gateway: { mode: "local", port: 18789 },
      },
    }) as Record<string, unknown>;

    expect(persisted).not.toHaveProperty("$schema");
    expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
  });

  it("does not restore root $schema when the next config sets an invalid value", () => {
    const sourceConfig = {
      $schema: "https://openclaw.ai/config.json",
      gateway: { mode: "local" },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: sourceConfig,
      sourceConfig,
      nextConfig: {
        $schema: 123,
        gateway: { mode: "local", port: 18789 },
      },
    }) as Record<string, unknown>;

    expect(persisted.$schema).toBe(123);
    expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
  });

  it("persists explicitly set keys whose values match runtime defaults", () => {
    const runtimeConfig = {
      channels: {
        telegram: {
          botToken: "tok-abc",
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
        },
      },
      gateway: { port: 18789 },
    };
    const sourceConfig = {
      channels: {
        telegram: {
          botToken: "tok-abc",
        },
      },
      gateway: { port: 18789 },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig,
      sourceConfig,
      nextConfig: sourceConfig,
      explicitSetValueSource: runtimeConfig,
      explicitSetPaths: [
        ["channels", "telegram", "dmPolicy"],
        ["channels", "telegram", "groupPolicy"],
      ],
    }) as { channels?: { telegram?: Record<string, unknown> } };

    expect(persisted.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(persisted.channels?.telegram?.groupPolicy).toBe("allowlist");
    expect(persisted.channels?.telegram?.botToken).toBe("tok-abc");
  });

  it("persists default-valued children inside explicitly set objects", () => {
    const runtimeConfig = {
      channels: {
        telegram: {
          botToken: "tok-abc",
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
        },
      },
    };
    const sourceConfig = {
      channels: {
        telegram: {
          botToken: "tok-abc",
        },
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig,
      sourceConfig,
      nextConfig: sourceConfig,
      explicitSetValueSource: runtimeConfig,
      explicitSetPaths: [["channels", "telegram"]],
    }) as { channels?: { telegram?: Record<string, unknown> } };

    expect(persisted.channels?.telegram).toEqual({
      botToken: "tok-abc",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    });
  });

  it("persists explicitly set array-index children whose values match runtime defaults", () => {
    const runtimeConfig = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5", contextWindow: 128000 }],
          },
        },
      },
    };
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig,
      sourceConfig,
      nextConfig: sourceConfig,
      explicitSetValueSource: runtimeConfig,
      explicitSetPaths: [["models", "providers", "openai", "models", "0", "contextWindow"]],
    }) as { models?: { providers?: { openai?: { models?: Array<Record<string, unknown>> } } } };

    expect(persisted.models?.providers?.openai?.models?.[0]).toEqual({
      id: "gpt-5.5",
      contextWindow: 128000,
    });
  });

  it("rejects default-valued explicit writes under include-owned paths", () => {
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: {
          agents: {
            defaults: {
              params: { temperature: 0 },
            },
          },
        },
        sourceConfig: {
          agents: {
            defaults: {},
          },
        },
        rootAuthoredConfig: {
          agents: {
            defaults: { $include: "./agents-defaults.json" },
          },
        },
        nextConfig: {
          agents: {
            defaults: {},
          },
        },
        explicitSetValueSource: {
          agents: {
            defaults: {
              params: { temperature: 0 },
            },
          },
        },
        explicitSetPaths: [["agents", "defaults", "params"]],
      }),
    ).toThrow("Config write would flatten $include-owned config at agents.defaults");
  });
});
