import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { unregisterResolvedAgentDir } from "../agents/agent-dir-registry.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import * as providerModelNormalization from "../agents/provider-model-normalization.runtime.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginMetadataOwner,
  withPluginMetadataCollectionScope,
} from "../plugins/plugin-metadata-collection.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { checkTouchedTextModelRefs } from "./config-model-validation.js";

type ResolverInput = {
  config: OpenClawConfig;
  ref: {
    path: string;
    value: string;
    agentIndex?: number;
    agentId?: string;
    fallback: boolean;
    authProfileId?: string;
  };
};

describe("config model validation env handling", () => {
  let normalize: MockInstance<
    typeof providerModelNormalization.normalizeProviderModelIdWithRuntime
  >;
  beforeEach(() => {
    // These collector/syntax cases inject the final resolver and a deterministic execution port.
    normalize = vi
      .spyOn(providerModelNormalization, "normalizeProviderModelIdWithRuntime")
      .mockImplementation(({ context }) => context.modelId);
  });
  afterEach(() => {
    normalize.mockRestore();
  });

  it("validates an expanded ref while preserving the authored config", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "${MODEL_REF}" } } },
    };
    const result = await checkTouchedTextModelRefs({
      config,
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { MODEL_REF: "openai/gpt-5.4-mini" },
      resolveModelRef,
    });
    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: { agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } } },
      ref: {
        path: "agents.defaults.model.primary",
        value: "openai/gpt-5.4-mini",
        fallback: false,
      },
    });
    expect(config.agents?.defaults?.model).toEqual({ primary: "${MODEL_REF}" });
  });

  it("reports an authored placeholder without exposing its expanded value", async () => {
    const resolveModelRef = vi.fn(async () => "Unknown model: private-provider/private-model");
    const result = await checkTouchedTextModelRefs({
      config: { agents: { defaults: { model: { primary: "${MODEL_REF}" } } } },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { MODEL_REF: "private-provider/private-model@work" },
      resolveModelRef,
    });
    expect(result.errors).toEqual([expect.stringContaining('model reference "${MODEL_REF}"')]);
    expect(result.errors).toEqual([
      expect.stringContaining("Unable to resolve authored model reference"),
    ]);
    expect(result.errors.join("\n")).not.toContain("private-provider");
  });

  it("redacts a fallback selected after provider expansion", async () => {
    const resolveModelRef = vi.fn(async ({ ref }: ResolverInput) =>
      ref.fallback ? "Unknown model: private-fallback" : undefined,
    );
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "${PRIMARY_REF}", fallbacks: ["${FALLBACK_REF}"] },
          },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: { primary: "openai/current", fallbacks: ["${FALLBACK_REF}"] },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { PRIMARY_REF: "provider-b/next", FALLBACK_REF: "private-fallback" },
      resolveModelRef,
    });
    expect(result.errors).toEqual([expect.stringContaining('model reference "${FALLBACK_REF}"')]);
    expect(result.errors.join("\n")).not.toContain("private-fallback");
  });

  it("does not revalidate an unchanged expanded primary in a model replacement", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "${MODEL_REF}", fallbacks: ["provider-b/next"] },
          },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: { primary: "${MODEL_REF}", fallbacks: ["provider-b/current"] },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model"]],
      env: { MODEL_REF: "provider-a/main" },
      resolveModelRef,
    });
    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: expect.any(Object),
      ref: {
        path: "agents.defaults.model.fallbacks.0",
        value: "provider-b/next",
        fallback: true,
      },
    });
  });

  it("validates authored changes even when expansion matches the previous values", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "${PRIMARY_REF}", fallbacks: ["${FALLBACK_REF}"] },
          },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: { primary: "provider-a/main", fallbacks: ["provider-b/backup"] },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model"]],
      env: { PRIMARY_REF: "provider-a/main", FALLBACK_REF: "provider-b/backup" },
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 2, refsTotal: 2, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledTimes(2);
  });

  it("replaces a stale previous placeholder without requiring its env var", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: { agents: { defaults: { model: { primary: "provider-a/next" } } } },
      previousConfig: { agents: { defaults: { model: { primary: "${OLD_MODEL}" } } } },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: {},
      resolveModelRef,
    });
    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("ignores a missing placeholder outside model validation inputs", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "provider-a/next" } } },
        channels: { discord: { token: "${DISCORD_TOKEN}" } },
      },
      previousConfig: {
        agents: { defaults: { model: { primary: "provider-a/current" } } },
        channels: { discord: { token: "${DISCORD_TOKEN}" } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: {},
      resolveModelRef,
    });
    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("redacts provider details inherited indirectly from an expanded primary", async () => {
    const resolveModelRef = vi.fn(async ({ ref }: ResolverInput) =>
      ref.fallback ? "Unknown model: private-provider/backup" : undefined,
    );
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "${PRIMARY_REF}", fallbacks: ["backup"] } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "provider-a/current", fallbacks: ["backup"] } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { PRIMARY_REF: "private-provider/main" },
      resolveModelRef,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('model reference "backup"');
    expect(result.errors[0]).not.toContain("private-provider");
  });

  it("redacts dependency values when authored spelling is unavailable", async () => {
    const resolveModelRef = vi.fn(async ({ ref }: ResolverInput) =>
      ref.fallback ? "Unknown model: provider-b/backup" : undefined,
    );
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "provider-b/main", fallbacks: ["backup"] } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "provider-a/main", fallbacks: ["backup"] } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      redactDependencyValues: true,
      resolveModelRef,
    });
    expect(result.errors).toEqual([
      expect.stringContaining('model reference "<configured model reference>"'),
    ]);
    expect(result.errors[0]).not.toContain("provider-b");
    expect(result.errors[0]).not.toContain('reference "backup"');
  });

  it("leaves a bare fallback unchecked when its primary provider is env-unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "${MODEL_REF}", fallbacks: ["backup"] } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "${MODEL_REF}", fallbacks: ["previous"] } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 0, refsTotal: 1, errors: [] });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("keeps numeric agent ids as object keys when matching unresolved paths", async () => {
    const result = await checkTouchedTextModelRefs({
      config: { agents: { entries: { "123": { model: "${MODEL_REF}" } } } },
      touchedPaths: [["agents", "entries", "123", "model"]],
      env: {},
      resolveModelRef: vi.fn(async () => undefined),
    });

    expect(result.errors).toEqual([expect.stringContaining("unresolved environment variable")]);
  });

  it("does not classify an escaped placeholder literal as unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: { agents: { defaults: { model: { primary: "$${MODEL_REF}" } } } },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("validates a bare fallback when its primary provider resolves from env", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "${MODEL_REF}", fallbacks: ["backup"] } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "${MODEL_REF}", fallbacks: ["previous"] } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      env: { MODEL_REF: "provider-a/main" },
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("validates an explicit fallback when its primary provider is env-unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "${MODEL_REF}", fallbacks: ["provider-a/backup"] },
          },
        },
      },
      previousConfig: {
        agents: {
          defaults: {
            model: { primary: "${MODEL_REF}", fallbacks: ["provider-a/previous"] },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("rejects an invalid bare fallback when its primary provider is env-unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "${MODEL_REF}", fallbacks: [" "] } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "${MODEL_REF}", fallbacks: ["previous"] } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({
      refsChecked: 1,
      refsTotal: 1,
      errors: [expect.stringContaining("Model reference is empty")],
    });
    expect(resolveModelRef).not.toHaveBeenCalled();
  });

  it("validates a bare fallback when only the primary model is env-unresolved", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: {
          defaults: { model: { primary: "provider-a/${MODEL_ID}", fallbacks: ["backup"] } },
        },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "provider-a/current", fallbacks: ["previous"] } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
      env: {},
      resolveModelRef,
    });

    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledOnce();
  });

  it("revalidates a fallback when an expanded primary is removed", async () => {
    const resolveModelRef = vi.fn(async (_params: ResolverInput) => undefined);
    const result = await checkTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { fallbacks: ["backup"] } } },
      },
      previousConfig: {
        agents: {
          defaults: { model: { primary: "${MODEL_REF}", fallbacks: ["backup"] } },
        },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      env: { MODEL_REF: "provider-a/main" },
      resolveModelRef,
    });
    expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    expect(resolveModelRef).toHaveBeenCalledWith({
      config: expect.any(Object),
      ref: {
        path: "agents.defaults.model.fallbacks.0",
        value: "backup",
        fallback: true,
        dependency: true,
      },
    });
  });
});

describe("config model validation scoped environments", () => {
  it.each([
    { name: "primary", fallback: false, runtimeAlias: false },
    { name: "fallback", fallback: true, runtimeAlias: false },
    { name: "runtime primary", fallback: false, runtimeAlias: true },
    { name: "runtime fallback", fallback: true, runtimeAlias: true },
  ])(
    "resolves an agent-owned $name alias through the real model catalog",
    async ({ fallback, runtimeAlias }) => {
      await withTempDir("openclaw-config-model-alias-", async (tempDir) => {
        const stateDir = path.join(tempDir, "state");
        await withEnvAsync(
          {
            HOME: tempDir,
            USERPROFILE: tempDir,
            OPENCLAW_HOME: tempDir,
            OPENCLAW_STATE_DIR: stateDir,
          },
          async () => {
            const agentDir = path.join(stateDir, "agents", "ops", "agent");
            const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
            const workspaceDir = path.join(tempDir, "ops");
            const provider: ModelProviderConfig = {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [
                {
                  id: "available",
                  name: "Fixture model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1024,
                },
              ],
            };
            const config: OpenClawConfig = {
              plugins: runtimeAlias
                ? {
                    allow: ["runtime-fixture"],
                    entries: { "runtime-fixture": { enabled: true } },
                  }
                : { enabled: false },
              agents: {
                defaults: {
                  model: "fixture/available",
                  models: { "unavailable/default": { alias: "selected" } },
                },
                entries: {
                  main: { agentDir: mainAgentDir, workspace: path.join(tempDir, "main") },
                  ops: {
                    agentDir,
                    workspace: workspaceDir,
                    model: fallback
                      ? { primary: "unavailable/untouched-primary", fallbacks: ["selected"] }
                      : { primary: "selected" },
                    models: {
                      [runtimeAlias ? "runtime-fixture/legacy" : "fixture/available"]: {
                        alias: "selected",
                      },
                    },
                  },
                },
              },
              models: { providers: { fixture: provider } },
            };
            if (runtimeAlias) {
              const pluginDir = path.join(
                workspaceDir,
                ".openclaw",
                "extensions",
                "runtime-fixture",
              );
              await fs.mkdir(pluginDir, { recursive: true });
              await fs.writeFile(
                path.join(pluginDir, "package.json"),
                JSON.stringify({
                  name: "runtime-fixture",
                  version: "1.0.0",
                  openclaw: { extensions: ["./index.cjs"] },
                }),
              );
              await fs.writeFile(
                path.join(pluginDir, "openclaw.plugin.json"),
                JSON.stringify({
                  id: "runtime-fixture",
                  providers: ["runtime-fixture"],
                  configSchema: { type: "object" },
                }),
              );
              await fs.writeFile(
                path.join(pluginDir, "index.cjs"),
                `module.exports = {
  id: "runtime-fixture",
  register(api) {
    api.registerProvider({
      id: "runtime-fixture",
      label: "Runtime fixture",
      auth: [],
      normalizeModelId({ modelId }) {
        return modelId === "legacy" ? "available" : undefined;
      },
    });
  },
};`,
              );
              await fs.mkdir(agentDir, { recursive: true });
              await fs.writeFile(
                path.join(agentDir, "models.json"),
                JSON.stringify({ providers: { "runtime-fixture": provider } }),
              );
            }
            const owner = createPluginMetadataOwner();
            try {
              const result = await withPluginMetadataCollectionScope(
                owner.prepare({ config }),
                () =>
                  checkTouchedTextModelRefs({
                    config,
                    touchedPaths: [
                      [
                        "agents",
                        "entries",
                        "ops",
                        "model",
                        ...(fallback ? ["fallbacks", "0"] : ["primary"]),
                      ],
                    ],
                  }),
                { config },
              );

              expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
            } finally {
              resetPreparedModelRuntimeSnapshotsForTest();
              closeOpenClawAgentDatabasesForTest();
              unregisterResolvedAgentDir({ agentId: "ops", agentDir });
              unregisterResolvedAgentDir({ agentId: "main", agentDir: mainAgentDir });
              owner.dispose();
            }
          },
        );
      });
    },
  );
});
