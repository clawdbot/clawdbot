import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  collectPreparedModelRuntimeDiscoveryProviderIds,
  collectPreparedModelRuntimeProviderIds,
} from "./prepared-model-runtime.configured.js";

function runtimePlugin(...providerIds: string[]): PluginManifestRecord {
  return {
    id: "runtime-catalog-test",
    channels: [],
    providers: providerIds,
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: "/tmp/runtime-catalog-test",
    source: "bundled",
    manifestPath: "/tmp/runtime-catalog-test/openclaw.plugin.json",
    modelCatalog: {
      discovery: Object.fromEntries(providerIds.map((providerId) => [providerId, "runtime"])),
    },
  };
}

function metadataSnapshot(...plugins: PluginManifestRecord[]) {
  return { plugins, manifestRegistry: { plugins, diagnostics: [] } };
}

describe("prepared model runtime provider selection", () => {
  it("keeps configured-only providers in ordinary full-catalog discovery", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          ollama: { baseUrl: "http://127.0.0.1:11434", models: [] },
        },
      },
    };

    expect(collectPreparedModelRuntimeProviderIds(config, {}, false)).toEqual(["ollama"]);
  });

  it("keeps unassigned global runtime providers eligible for an allow-any owner", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      models: {
        providers: {
          omniroute: { baseUrl: "http://omniroute.invalid", models: [] },
        },
      },
    };

    expect(
      collectPreparedModelRuntimeDiscoveryProviderIds(
        config,
        metadataSnapshot(runtimePlugin("omniroute")),
        "default",
      ),
    ).toEqual(["omniroute"]);
  });

  it("honors explicit owner policy for global runtime providers", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          modelPolicy: { allow: ["openai/*"] },
        },
      },
      models: {
        providers: {
          omniroute: { baseUrl: "http://omniroute.invalid", models: [] },
        },
      },
    };

    expect(
      collectPreparedModelRuntimeDiscoveryProviderIds(
        config,
        metadataSnapshot(runtimePlugin("omniroute")),
        "default",
      ),
    ).toEqual([]);
  });

  it.each([
    ["an exact model reference", { model: { primary: "modelstudio/qwen3.5-plus" } }],
    ["a provider wildcard", { modelPolicy: { allow: ["modelstudio/*"] } }],
  ])("canonicalizes runtime provider aliases from %s", (_label, defaults) => {
    const config: OpenClawConfig = { agents: { defaults } };
    const plugin = runtimePlugin("qwen");
    plugin.modelCatalog = {
      ...plugin.modelCatalog,
      aliases: {
        modelstudio: { provider: "qwen" },
        qwencloud: { provider: "qwen" },
      },
    };

    expect(
      collectPreparedModelRuntimeDiscoveryProviderIds(config, metadataSnapshot(plugin), "default"),
    ).toEqual(["qwen"]);
  });

  it("reserves an aliased runtime provider for the referencing agent", () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "qwen-owner", model: { primary: "modelstudio/qwen3.5-plus" } },
          { id: "allow-any", model: { primary: "openai/gpt-5.5" } },
        ],
      },
      models: {
        providers: { qwen: { baseUrl: "https://qwen.invalid", models: [] } },
      },
    };
    const plugin = runtimePlugin("qwen");
    plugin.modelCatalog = {
      ...plugin.modelCatalog,
      aliases: { modelstudio: { provider: "qwen" } },
    };
    const metadata = metadataSnapshot(plugin);

    expect(collectPreparedModelRuntimeDiscoveryProviderIds(config, metadata, "qwen-owner")).toEqual(
      ["qwen"],
    );
    expect(collectPreparedModelRuntimeDiscoveryProviderIds(config, metadata, "allow-any")).toEqual(
      [],
    );
  });

  it("does not canonicalize transport aliases for runtime discovery", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "azure-openai-responses/gpt-5.5" } } },
    };
    const plugin = runtimePlugin("openai", "azure-openai-responses");
    plugin.modelCatalog = {
      ...plugin.modelCatalog,
      aliases: {
        "azure-openai-responses": {
          provider: "openai",
          api: "azure-openai-responses",
        },
      },
    };

    expect(
      collectPreparedModelRuntimeDiscoveryProviderIds(config, metadataSnapshot(plugin), "default"),
    ).toEqual(["azure-openai-responses"]);
  });
});
