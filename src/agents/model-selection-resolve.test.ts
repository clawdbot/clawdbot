// Verifies configured model ref resolution and OpenRouter compatibility aliases.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { installPluginMetadataOwner } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataOwner } from "../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveAllowedModelRefCore,
  resolveConfiguredModelRef,
} from "./model-selection-resolve.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";

describe("model-selection-resolve OpenRouter compat aliases", () => {
  it.each(["configured", "auxiliary"] as const)(
    "uses prepared load-path policy in a %s workspace without configured aliases",
    async (workspaceKind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pluginDir = state.path("normalizer");
        await fs.mkdir(pluginDir);
        const fixture = createColdPluginFixture({
          rootDir: pluginDir,
          pluginId: "model-selection-normalizer",
          manifest: {
            providers: ["custom"],
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
            modelIdNormalization: {
              providers: { custom: { aliases: { legacy: "current" } } },
            },
          },
        });
        const cfg: OpenClawConfig = {
          ...createColdPluginConfig(pluginDir, fixture.pluginId),
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: {
              main: { workspace: state.workspaceDir },
              work: { workspace: state.path("work") },
            },
          },
        };
        const pluginCache = createPluginCache();
        const owner = createPluginMetadataOwner(pluginCache);
        const dispose = installPluginMetadataOwner(owner, pluginCache);
        try {
          const metadata = owner.prepare({ config: cfg });
          owner.publish(metadata, { config: cfg });
          const workspaceDir = state.path(workspaceKind === "configured" ? "work" : "auxiliary");
          const pluginMetadataSnapshot = prepareOwnedPluginLoadContext(
            { config: cfg, workspaceDir },
            process.env,
          );
          const selection = {
            cfg,
            catalog: [{ provider: "custom", id: "current", name: "Current" }],
            raw: "custom/legacy",
            defaultProvider: "openai",
            agentId: "work",
            workspaceDir,
            pluginMetadataSnapshot,
          };
          expect(resolveAllowedModelRefCore(selection)).toEqual({
            key: "custom/current",
            ref: { provider: "custom", model: "current" },
          });
          expect(
            withPluginRuntimeGenerationScope(
              {
                config: cfg,
                metadataSnapshot: projectPluginMetadataSnapshot(metadata.selectedSnapshot, []),
              },
              () => resolveAllowedModelRefCore(selection),
            ),
          ).toEqual({ key: "custom/legacy", ref: { provider: "custom", model: "legacy" } });
          expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
        } finally {
          dispose();
          clearPluginMetadataLifecycleCaches();
        }
      });
    },
  );

  it("keeps inherited policy aliases bound to default metadata for per-agent selection", () => {
    const cfg = {
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "approved" },
          },
          modelPolicy: { allow: ["approved"] },
        },
        list: [
          {
            id: "worker",
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "approved" },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const catalog = [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "approved",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({ error: "model not allowed: anthropic/claude-sonnet-4-6" });
    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "openai/gpt-5.5",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({
      key: "openai/gpt-5.5",
      ref: { provider: "openai", model: "gpt-5.5" },
    });
  });

  it("binds explicit per-agent policy aliases to per-agent metadata", () => {
    const cfg = {
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": { alias: "approved" } },
          modelPolicy: { allow: ["approved"] },
        },
        list: [
          {
            id: "worker",
            models: { "anthropic/claude-sonnet-4-6": { alias: "approved" } },
            modelPolicy: { allow: ["approved"] },
          },
        ],
      },
    } as OpenClawConfig;
    const catalog = [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "approved",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({
      key: "anthropic/claude-sonnet-4-6",
      ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "openai/gpt-5.5",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({ error: "model not allowed: openai/gpt-5.5" });
  });

  it("preserves exact configured proxy provider ids for cron-style aliases", () => {
    // Proxy providers can intentionally own short ids like "cron"; keep the
    // configured provider scope instead of treating the id as a global alias.
    const cfg = {
      agents: {
        defaults: {
          models: {
            "litellm/cron": {},
          },
        },
      },
      models: {
        providers: {
          litellm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:4000/v1",
            models: [{ id: "cron", name: "Cron route" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog: [],
        raw: "litellm/cron",
        defaultProvider: "ollama",
        defaultModel: "qwen35-27b-researcher",
      }),
    ).toEqual({
      key: "litellm/cron",
      ref: { provider: "litellm", model: "cron" },
    });
  });

  it("resolves openrouter:auto through the canonical OpenRouter auto model", () => {
    // Colon syntax is a legacy operator shortcut for OpenRouter's auto route.
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openrouter:auto" },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        allowPluginNormalization: false,
      }),
    ).toEqual({ provider: "openrouter", model: "openrouter/auto" });
  });

  it("resolves openrouter:free through the runtime allowlist path", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/meta-llama/llama-3.3-70b-instruct:free": {},
          },
        },
      },
    } as OpenClawConfig;

    const catalog = [
      {
        provider: "openrouter",
        id: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Free",
      },
    ];

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "openrouter:free",
        defaultProvider: "anthropic",
      }),
    ).toEqual({
      ref: {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct:free",
      },
      key: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    });
  });
});
