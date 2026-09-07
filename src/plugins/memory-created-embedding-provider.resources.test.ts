import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "../plugin-sdk/facade-loader.js";
import { createEmbeddingProvider } from "../plugin-sdk/memory-core-bundled-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getEmbeddingProviderCore } from "./embedding-provider-runtime.js";
import type { EmbeddingProvider } from "./embedding-provider-types.js";
import type { MemoryEmbeddingProviderRuntime } from "./memory-embedding-providers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  abandonPluginRegistryResourceConstruction,
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "./registry-resources.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

// Load the public module during fixture initialization, as a static import would;
// the cases exercise provider callbacks, not cold source transformation latency.
loadBundledPluginPublicSurfaceModuleSyncCore({
  dirName: "memory-core",
  artifactBasename: "runtime-api.js",
});

it.each(["embed", "embedBatch", "batchEmbed", "close", "diagnostics"] as const)(
  "runs created Memory provider %s in its retained resource scope",
  async (operation) => {
    const registry = createEmptyPluginRegistry();
    const construction = createPluginRegistryResourceOwner(registry, "scoped");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE proof (value INTEGER); INSERT INTO proof VALUES (7)");
    let disposals = 0;
    let closes = 0;
    let failClose = operation === "close";
    let closeGate = createDeferredCore();
    registerPluginRegistryResourceDisposer(registry, "native-embedding", {
      id: "sqlite",
      dispose() {
        db.close();
        disposals += 1;
      },
    });
    registry.embeddingProviders.push({
      pluginId: "native-embedding",
      source: "fixture",
      provider: {
        id: "native-value",
        get defaultModel() {
          return String(db.prepare("SELECT value FROM proof").get()?.value);
        },
        create: async () => ({ provider: null }),
      },
    });
    const read = async () => {
      await Promise.resolve();
      // Selection and resource ownership are independent: this nested lookup still
      // needs the created provider's resource scope after the creation call returns.
      return withPluginRuntimeRegistryScope(registry, () =>
        Number(getEmbeddingProviderCore("native-value")?.defaultModel),
      );
    };
    class NativeProvider implements EmbeddingProvider {
      #offset = 2;
      get id() {
        return "native-embedding";
      }
      get model() {
        return "native-model";
      }
      get dimensions() {
        return this.#offset;
      }
      get maxInputTokens() {
        return 256;
      }
      async embed() {
        return [await read(), this.#offset];
      }
      async embedBatch(inputs: Parameters<EmbeddingProvider["embedBatch"]>[0]) {
        const value = await read();
        return inputs.map(() => [value, this.#offset]);
      }
      async close() {
        await closeGate.promise;
        await read();
        if (failClose) {
          failClose = false;
          throw new Error("physical provider close failed");
        }
        closes += this.#offset;
      }
    }
    class NativeRuntime implements MemoryEmbeddingProviderRuntime {
      #offset = 3;
      id = "native-runtime";
      sourceWideBatchEmbed = true;
      async batchEmbed() {
        return [[await read(), this.#offset]];
      }
    }
    const raw = new NativeProvider();
    const runtimeFactsKey = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
    Object.defineProperty(raw, runtimeFactsKey, {
      get() {
        expect(this).toBe(raw);
        return () => ({
          model: raw.model,
          dimensions: raw.dimensions,
          value: db.prepare("SELECT value FROM proof").get()?.value,
        });
      },
    });
    Object.freeze(raw);
    const runtime = Object.freeze(new NativeRuntime());
    registry.embeddingProviders.push({
      pluginId: "native-embedding",
      source: "fixture",
      provider: { id: raw.id, create: async () => ({ provider: raw, runtime }) },
    });
    try {
      const result = await withPluginRuntimeRegistryScope(registry, () =>
        createEmbeddingProvider({
          config: { plugins: { enabled: false } },
          provider: raw.id,
          fallback: "none",
          model: "",
        }),
      );
      construction.release();
      const provider = result.provider!;
      expect(provider).toMatchObject({
        id: raw.id,
        model: raw.model,
        dimensions: 2,
        maxInputTokens: 256,
      });
      expect(db.isOpen).toBe(true);
      if (operation === "embed") {
        await expect(provider.embed("query")).resolves.toEqual([7, 2]);
      } else if (operation === "embedBatch") {
        await expect(provider.embedBatch(["document"])).resolves.toEqual([[7, 2]]);
      } else if (operation === "batchEmbed") {
        const batchEmbed = result.runtime!.batchEmbed!;
        await expect(
          batchEmbed({
            agentId: "main",
            chunks: [{ text: "document" }],
            wait: true,
            concurrency: 1,
            pollIntervalMs: 1,
            timeoutMs: 1000,
            debug() {},
          }),
        ).resolves.toEqual([[7, 3]]);
      } else if (operation === "diagnostics") {
        const readRuntimeFacts = Reflect.get(provider, runtimeFactsKey);
        expect(typeof readRuntimeFacts).toBe("function");
        expect(readRuntimeFacts()).toEqual({ model: raw.model, dimensions: 2, value: 7 });
      } else {
        const failedCloses = Promise.allSettled([provider.close!(), provider.close!()]);
        closeGate.resolve();
        expect(await failedCloses).toEqual([
          { status: "rejected", reason: new Error("physical provider close failed") },
          { status: "rejected", reason: new Error("physical provider close failed") },
        ]);
        expect(db.isOpen).toBe(true);
        closeGate = createDeferredCore();
        await expect(provider.embed("retry")).resolves.toEqual([7, 2]);
      }
      const successfulCloses = Promise.all([provider.close!(), provider.close!()]);
      closeGate.resolve();
      await successfulCloses;
      await drainPluginRegistryResourceDisposals();
      expect(closes).toBe(2);
      expect(disposals).toBe(1);
      expect(db.isOpen).toBe(false);
    } finally {
      closeGate.resolve();
      construction.release();
      abandonPluginRegistryResourceConstruction(registry);
      await drainPluginRegistryResourceDisposals();
    }
  },
);
