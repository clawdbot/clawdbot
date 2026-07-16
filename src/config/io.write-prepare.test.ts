// Covers config write preparation diffs and metadata preservation.
import { describe, expect, it } from "vitest";
import {
  collectChangedPaths,
  applyUnsetPathsForWrite,
  createMergePatch,
  formatConfigValidationFailure,
  restoreEnvRefsFromMap,
  resolvePersistCandidateForWrite,
  resolveWriteEnvSnapshotForPath,
} from "./io.write-prepare.js";
import type { OpenClawConfig } from "./types.js";

describe("config io write prepare", () => {
  it("ignores prototype-chain keys when building merge patches", () => {
    // Discriminating fixture: `collision` is own on base and only inherited on
    // target. With `key in target` the old code treated the inherited value as
    // present and emitted it in the patch; Object.hasOwn deletes the own key.
    const base = {
      safe: { mode: "local" },
      collision: { mode: "owned-base" },
    };
    const target = Object.create({
      collision: { mode: "inherited-target" },
    }) as Record<string, unknown>;
    target.safe = { mode: "cloud" };

    expect(createMergePatch(base, target)).toEqual({
      safe: { mode: "cloud" },
      collision: null,
    });
  });

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

  it("does not reintroduce legacy openai-codex model params after doctor route repair", () => {
    const sourceConfig: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          models: {
            "openai-codex/gpt-5.5": {
              params: { reasoning_effort: "high" },
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
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                params: { reasoning_effort: "high" },
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      },
    }) as OpenClawConfig;

    expect(persisted.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(persisted.agents?.defaults?.models).not.toHaveProperty("openai-codex/gpt-5.5");
    expect(persisted.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({
      params: { reasoning_effort: "high" },
      agentRuntime: { id: "codex" },
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
          utilityModel: "google/gemini-3-pro-preview",
          heartbeat: { model: "google/gemini-3-pro-preview" },
          subagents: {
            model: {
              primary: "google/gemini-3-pro-preview",
              fallbacks: ["google/gemini-3-pro-preview"],
            },
          },
          compaction: {
            model: "google/gemini-3-pro-preview",
            memoryFlush: { model: "google/gemini-3-pro-preview" },
          },
          models: {
            "google/gemini-3-pro-preview": {
              alias: "Gemini",
            },
          },
        },
        list: [
          {
            id: "ops",
            model: {
              primary: "google/gemini-3-pro-preview",
              fallbacks: ["google/gemini-3-pro-preview"],
            },
            utilityModel: "google/gemini-3-pro-preview",
            heartbeat: { model: "google/gemini-3-pro-preview" },
            subagents: { model: "google/gemini-3-pro-preview" },
            models: {
              "google/gemini-3-pro-preview": {
                alias: "Ops Gemini",
              },
            },
          },
        ],
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
          utilityModel: "google/gemini-3.1-pro-preview",
          heartbeat: { model: "google/gemini-3.1-pro-preview" },
          subagents: {
            model: {
              primary: "google/gemini-3.1-pro-preview",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
          },
          compaction: {
            model: "google/gemini-3.1-pro-preview",
            memoryFlush: { model: "google/gemini-3.1-pro-preview" },
          },
          models: {
            "google/gemini-3.1-pro-preview": {
              alias: "Gemini",
            },
          },
        },
        list: [
          {
            id: "ops",
            model: {
              primary: "google/gemini-3.1-pro-preview",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
            utilityModel: "google/gemini-3.1-pro-preview",
            heartbeat: { model: "google/gemini-3.1-pro-preview" },
            subagents: { model: "google/gemini-3.1-pro-preview" },
            models: {
              "google/gemini-3.1-pro-preview": {
                alias: "Ops Gemini",
              },
            },
          },
        ],
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
    expect(persisted.agents?.defaults?.utilityModel).toBe("google/gemini-3.1-pro-preview");
    expect(persisted.agents?.defaults?.heartbeat?.model).toBe("google/gemini-3.1-pro-preview");
    expect(persisted.agents?.defaults?.subagents?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(persisted.agents?.defaults?.compaction?.model).toBe("google/gemini-3.1-pro-preview");
    expect(persisted.agents?.defaults?.compaction?.memoryFlush?.model).toBe(
      "google/gemini-3.1-pro-preview",
    );
    expect(persisted.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "Gemini",
      },
    });
    expect(persisted.agents?.list?.[0]?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(persisted.agents?.list?.[0]?.utilityModel).toBe("google/gemini-3.1-pro-preview");
    expect(persisted.agents?.list?.[0]?.heartbeat?.model).toBe("google/gemini-3.1-pro-preview");
    expect(persisted.agents?.list?.[0]?.subagents?.model).toBe("google/gemini-3.1-pro-preview");
    expect(persisted.agents?.list?.[0]?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "Ops Gemini",
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

  it("normalizes manifest-backed provider catalog refs during unrelated config writes", () => {
    const makeModel = (id: string) => ({
      id,
      name: "Custom latest",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    });
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            models: [makeModel("latest")],
          },
        },
      },
      gateway: { port: 18789 },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            models: [makeModel("vendor/modern-model")],
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
      modelIdNormalizationPolicies: new Map([
        [
          "myproxy",
          {
            aliases: { latest: "modern-model" },
            prefixWhenBare: "vendor",
          },
        ],
      ]),
    }) as OpenClawConfig;

    expect(persisted.models?.providers?.myproxy?.models).toEqual([
      makeModel("vendor/modern-model"),
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

  it("applies explicit unsets without mutating caller config", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch", "read"] },
    };

    const next = applyUnsetPathsForWrite(input, [
      ["commands", "ownerDisplay"],
      ["tools", "alsoAllow", "1"],
    ]);

    expect(input).toEqual({
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch", "read"] },
    });
    expect(next.commands ?? {}).not.toHaveProperty("ownerDisplay");
    expect(next.tools?.alsoAllow).toEqual(["exec", "read"]);
  });

  it.each([
    ["invalid array suffix", ["tools", "alsoAllow", "1abc"]],
    ["signed array index", ["tools", "alsoAllow", "+0"]],
    ["unsafe integer", ["tools", "alsoAllow", "9007199254740993"]],
    ["maximum array key", ["tools", "alsoAllow", "4294967294"]],
    ["missing key", ["commands", "missingKey"]],
    ["prototype key", ["commands", "__proto__"]],
    ["constructor key", ["commands", "constructor"]],
    ["prototype constructor property", ["commands", "prototype"]],
  ] as const)("treats %s unset paths as immutable no-ops", (_name, unsetPath) => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch"] },
    };

    expect(applyUnsetPathsForWrite(input, [[...unsetPath]])).toBe(input);
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

  it("allows removing root-authored sibling keys beside an include", () => {
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        gateway: { mode: "local", legacyKey: true },
      },
      sourceConfig: {
        gateway: { mode: "local", legacyKey: true },
      },
      rootAuthoredConfig: {
        gateway: { $include: "./config/gateway.json", legacyKey: true },
      },
      nextConfig: {
        gateway: { mode: "local" },
      },
    }) as Record<string, unknown>;

    expect(persisted.gateway).toEqual({ $include: "./config/gateway.json" });
  });

  it("allows nested root-authored sibling edits without flattening included values", () => {
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "old" },
        },
      },
      sourceConfig: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "old" },
        },
      },
      rootAuthoredConfig: {
        gateway: {
          $include: "./config/gateway.json",
          auth: { token: "old" },
        },
      },
      nextConfig: {
        gateway: {
          mode: "local",
          auth: { mode: "none", token: "new", strategy: "strict" },
        },
      },
    }) as Record<string, unknown>;

    expect(persisted.gateway).toEqual({
      $include: "./config/gateway.json",
      auth: { token: "new", mode: "none", strategy: "strict" },
    });
  });

  it("does not copy runtime-normalized include values into root-authored siblings", () => {
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        gateway: {
          tls: { certPath: "/home/test/cert.pem", enabled: false },
        },
      },
      sourceConfig: {
        gateway: {
          tls: { certPath: "~/cert.pem", enabled: false },
        },
      },
      rootAuthoredConfig: {
        gateway: {
          $include: "./config/gateway.json",
          tls: { enabled: false },
        },
      },
      nextConfig: {
        gateway: {
          tls: { certPath: "~/cert.pem", enabled: true },
        },
      },
    }) as Record<string, unknown>;

    expect(persisted.gateway).toEqual({
      $include: "./config/gateway.json",
      tls: { enabled: true },
    });
  });

  it("rejects included-value edits beside root-authored sibling edits", () => {
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: {
          gateway: { mode: "local", legacyKey: "old" },
        },
        sourceConfig: {
          gateway: { mode: "local", legacyKey: "old" },
        },
        rootAuthoredConfig: {
          gateway: { $include: "./config/gateway.json", legacyKey: "old" },
        },
        nextConfig: {
          gateway: { mode: "remote", legacyKey: "new" },
        },
      }),
    ).toThrow("Config write would flatten $include-owned config at gateway");
  });

  it("preserves include-owned array entries across runtime-only normalization", () => {
    const sourceAgents = { list: [{ id: "main", workspace: "~/agent" }] };
    const runtimeAgents = { list: [{ id: "main", workspace: "/home/test/agent" }] };
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        agents: runtimeAgents,
        gateway: { mode: "local" },
      },
      sourceConfig: {
        agents: sourceAgents,
        gateway: { mode: "local" },
      },
      rootAuthoredConfig: {
        agents: { list: [{ $include: "./config/main-agent.json" }] },
        gateway: { mode: "local" },
      },
      nextConfig: {
        agents: sourceAgents,
        gateway: { mode: "local", port: 18789 },
      },
    }) as Record<string, unknown>;

    expect(persisted.agents).toEqual({
      list: [{ $include: "./config/main-agent.json" }],
    });
    expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
  });

  it("allows edits to root-owned siblings beside an include-owned array entry", () => {
    const mainAgent = { id: "main", workspace: "~/agent" };
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: {
        agents: { list: [mainAgent, { id: "ops", workspace: "~/ops" }] },
      },
      sourceConfig: {
        agents: { list: [mainAgent, { id: "ops", workspace: "~/ops" }] },
      },
      rootAuthoredConfig: {
        agents: {
          list: [{ $include: "./config/main-agent.json" }, { id: "ops", workspace: "~/ops" }],
        },
      },
      nextConfig: {
        agents: {
          list: [
            mainAgent,
            { id: "ops", workspace: "~/ops-next" },
            { id: "new", workspace: "~/new" },
          ],
        },
      },
    }) as Record<string, unknown>;

    expect(persisted.agents).toEqual({
      list: [
        { $include: "./config/main-agent.json" },
        { id: "ops", workspace: "~/ops-next" },
        { id: "new", workspace: "~/new" },
      ],
    });
  });

  it("rejects writes that change include-owned array entries", () => {
    const agents = { list: [{ id: "main", workspace: "~/agent" }] };

    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: { agents },
        sourceConfig: { agents },
        rootAuthoredConfig: {
          agents: { list: [{ $include: "./config/main-agent.json" }] },
        },
        nextConfig: {
          agents: { list: [{ id: "main", workspace: "~/other-agent" }] },
        },
      }),
    ).toThrow("Config write would flatten $include-owned config at agents.list.0");
  });

  it("rejects array shifts when an included value has a duplicate sibling", () => {
    const paths = ["/same", "/same"];

    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: { plugins: { load: { paths } } },
        sourceConfig: { plugins: { load: { paths } } },
        rootAuthoredConfig: {
          plugins: {
            load: { paths: [{ $include: "./path.json5" }, "/same"] },
          },
        },
        nextConfig: { plugins: { load: { paths: ["/same"] } } },
      }),
    ).toThrow("Config write would flatten $include-owned config at plugins.load.paths.0");
  });

  it("allows unrelated removals after duplicate include-resolved values", () => {
    const paths = ["/same", "/same", "/other"];
    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: { plugins: { load: { paths } } },
      sourceConfig: { plugins: { load: { paths } } },
      rootAuthoredConfig: {
        plugins: {
          load: { paths: [{ $include: "./path.json5" }, "/same", "/other"] },
        },
      },
      nextConfig: { plugins: { load: { paths: ["/same", "/same"] } } },
    }) as Record<string, unknown>;

    expect(persisted).toEqual({
      plugins: {
        load: { paths: [{ $include: "./path.json5" }, "/same"] },
      },
    });
  });

  it("rejects included-entry removals hidden by duplicate sibling edits", () => {
    const paths = ["/same", "/same", "/old"];

    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: { plugins: { load: { paths } } },
        sourceConfig: { plugins: { load: { paths } } },
        rootAuthoredConfig: {
          plugins: {
            load: { paths: [{ $include: "./path.json5" }, "/same", "/old"] },
          },
        },
        nextConfig: { plugins: { load: { paths: ["/same", "/new"] } } },
      }),
    ).toThrow("Config write would flatten $include-owned config at plugins.load.paths.0");
  });

  it("rejects newly introduced duplicates of include-owned array entries", () => {
    const paths = ["/root", "/included"];

    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: { plugins: { load: { paths } } },
        sourceConfig: { plugins: { load: { paths } } },
        rootAuthoredConfig: {
          plugins: {
            load: { paths: ["/root", { $include: "./path.json5" }] },
          },
        },
        nextConfig: { plugins: { load: { paths: ["/included", "/included"] } } },
      }),
    ).toThrow("Config write would flatten $include-owned config at plugins.load.paths.1");
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

  it("does not overwrite identity-restored env refs with positional map entries", () => {
    const restored = restoreEnvRefsFromMap(
      {
        agents: [
          { id: "b", token: "${TOKEN_B}" },
          { id: "a", token: "${TOKEN_A}" },
        ],
      },
      "",
      new Map([
        ["agents[0].token", "${TOKEN_A}"],
        ["agents[1].token", "${TOKEN_B}"],
      ]),
      new Set(["agents[0].id", "agents[1].id"]),
      new Set(["agents[0].token", "agents[1].token"]),
    );

    expect(restored).toEqual({
      agents: [
        { id: "b", token: "${TOKEN_B}" },
        { id: "a", token: "${TOKEN_A}" },
      ],
    });
  });

  it("ignores prototype-chain keys when collecting changed paths", () => {
    // Same one-sided collision as the merge-patch fixture: own on base, only
    // inherited on target. Old `in` checks walked into collision.mode; hasOwn
    // reports the top-level own-key removal instead.
    const base = {
      safe: { mode: "local" },
      collision: { mode: "owned-base" },
    };
    const target = Object.create({
      collision: { mode: "inherited-target" },
    }) as Record<string, unknown>;
    target.safe = { mode: "cloud" };

    const changedPaths = new Set<string>();
    collectChangedPaths(base, target, "", changedPaths);

    expect([...changedPaths].toSorted()).toEqual(["collision", "safe.mode"]);
  });

  it("does not overwrite identity-restored escaped refs with positional map entries", () => {
    const restored = restoreEnvRefsFromMap(
      {
        agents: [
          { id: "real", token: "${TOKEN}" },
          { id: "literal", token: "$${TOKEN}" },
        ],
      },
      "",
      new Map([["agents[1].token", "${TOKEN}"]]),
      new Set(["agents[0].id", "agents[1].id"]),
      new Set(["agents[0].token", "agents[1].token"]),
    );

    expect(restored).toEqual({
      agents: [
        { id: "real", token: "${TOKEN}" },
        { id: "literal", token: "$${TOKEN}" },
      ],
    });
  });

  it("restores unchanged paths even when their values equal another authored template", () => {
    const restored = restoreEnvRefsFromMap(
      {
        included: {
          first: "${SECOND}",
          second: "second-secret",
          third: "$${SECOND}",
          escaped: "$${SECOND}",
        },
        gateway: { port: 18790 },
      },
      "",
      new Map([
        ["included.first", "${FIRST}"],
        ["included.second", "${SECOND}"],
        ["included.third", "${THIRD}"],
        ["included.escaped", "$${SECOND}"],
      ]),
      new Set(["gateway.port"]),
    );

    expect(restored).toEqual({
      included: {
        first: "${FIRST}",
        second: "${SECOND}",
        third: "${THIRD}",
        escaped: "$${SECOND}",
      },
      gateway: { port: 18790 },
    });
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
    (runtimeConfig.channels!.imessage as Record<string, unknown>).runtimeOnlyDefault = true;

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

  it("ignores unsafe array-index explicit set paths", () => {
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
      explicitSetPaths: [
        ["models", "providers", "openai", "models", "0abc", "contextWindow"],
        ["models", "providers", "openai", "models", "+0", "contextWindow"],
        ["models", "providers", "openai", "models", "9007199254740993", "contextWindow"],
        ["models", "providers", "openai", "models", "4294967294", "contextWindow"],
      ],
    }) as { models?: { providers?: { openai?: { models?: Array<Record<string, unknown>> } } } };

    expect(persisted.models?.providers?.openai?.models).toEqual([{ id: "gpt-5.5" }]);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
