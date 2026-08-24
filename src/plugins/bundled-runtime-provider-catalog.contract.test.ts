import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import { loadBundledPluginPublicSurface } from "../plugin-sdk/plugin-test-contracts.js";
import { registerProviderPlugin } from "../test-utils/plugin-registration.js";
import type { ProviderCatalogContext, ProviderCatalogResult } from "./types.js";

const contractMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async () => {
    throw new Error("runtime provider catalog attempted network discovery without auth");
  }),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-sdk/provider-auth-runtime.js")>()),
  resolveApiKeyForProvider: vi.fn(async () => undefined),
  resolveProviderAuthProfileMetadata: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-sdk/ssrf-runtime.js")>()),
  fetchWithSsrFGuard: contractMocks.fetchWithSsrFGuard,
}));

type RuntimeManifest = {
  id?: unknown;
  modelCatalog?: {
    discovery?: Record<string, unknown>;
    providers?: Record<string, { models?: unknown[] }>;
  };
};

type RegisteredPlugin = Parameters<typeof registerProviderPlugin>[0]["plugin"];

function readRuntimeManifestProviders(): Array<{
  pluginId: string;
  providerId: string;
  manifestModelIds: string[];
}> {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const providers: Array<{
    pluginId: string;
    providerId: string;
    manifestModelIds: string[];
  }> = [];
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(extensionsDir, entry.name, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RuntimeManifest;
    if (typeof manifest.id !== "string") {
      continue;
    }
    for (const [providerId, discovery] of Object.entries(manifest.modelCatalog?.discovery ?? {})) {
      if (discovery === "runtime") {
        const manifestModelIds = (
          manifest.modelCatalog?.providers?.[providerId]?.models ?? []
        ).flatMap((model) => {
          if (!model || typeof model !== "object" || !("id" in model)) {
            return [];
          }
          return typeof model.id === "string" ? [model.id] : [];
        });
        providers.push({ pluginId: manifest.id, providerId, manifestModelIds });
      }
    }
  }
  return providers.toSorted((left, right) =>
    `${left.pluginId}/${left.providerId}`.localeCompare(`${right.pluginId}/${right.providerId}`),
  );
}

function createEmptyAuthCatalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined, discoveryApiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  };
}

function providerConfigFor(
  result: ProviderCatalogResult | undefined,
  providerId: string,
): ModelProviderConfig | undefined {
  if (!result) {
    return undefined;
  }
  if ("provider" in result) {
    return result.provider;
  }
  return result.providers[providerId];
}

describe("bundled runtime provider catalog contract", () => {
  it("returns static rows and a terminal ready outcome without auth or network", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("runtime provider catalog attempted network discovery without auth");
    });

    try {
      for (const { pluginId, providerId, manifestModelIds } of readRuntimeManifestProviders()) {
        const plugin = await loadBundledPluginPublicSurface<{
          default: RegisteredPlugin;
        }>({ pluginId, artifactBasename: "index.js" });
        const registered = await registerProviderPlugin({
          plugin: plugin.default,
          id: pluginId,
          name: pluginId,
        });
        const provider = registered.providers.find((candidate) => candidate.id === providerId);
        expect(
          provider,
          `${pluginId}/${providerId} must register its manifest provider`,
        ).toBeDefined();
        expect(
          provider?.catalog,
          `${pluginId}/${providerId} must expose a runtime catalog`,
        ).toBeDefined();

        const context = createEmptyAuthCatalogContext();
        const runtimeResult = await provider!.catalog!.run({
          ...context,
          providerIds: [providerId],
        });
        const runtimeProvider = providerConfigFor(runtimeResult, providerId);

        expect(runtimeProvider, `${pluginId}/${providerId} runtime rows missing`).toBeDefined();
        expect(runtimeProvider?.models).not.toHaveLength(0);
        if (provider?.staticCatalog) {
          const staticResult = await provider.staticCatalog.run(context);
          const staticProvider = providerConfigFor(staticResult, providerId);
          expect(staticProvider, `${pluginId}/${providerId} static rows missing`).toBeDefined();
          expect(staticProvider?.models).not.toHaveLength(0);
          expect(runtimeProvider?.models).toEqual(staticProvider?.models);
        } else {
          expect(manifestModelIds).not.toHaveLength(0);
          expect(runtimeProvider?.models?.map((model) => model.id)).toEqual(
            expect.arrayContaining(manifestModelIds),
          );
        }
        expect(runtimeResult?.outcomes).toHaveLength(1);
        expect(runtimeResult?.outcomes?.[0]).toEqual(
          expect.objectContaining({ provider: providerId, status: "ready" }),
        );
      }
    } finally {
      fetchMock.mockRestore();
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(contractMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
