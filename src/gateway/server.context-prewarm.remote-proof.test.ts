import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { prepareContextWindowCaches } from "../agents/context-cache-projection.js";
import { getContextWindowCaches, replaceContextWindowCaches } from "../agents/context-cache.js";
import { resetContextWindowCacheForTest } from "../agents/context-runtime-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preparePluginMetadata } from "../plugins/plugin-metadata-collection.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

afterEach(() => {
  resetContextWindowCacheForTest();
  resetPreparedModelRuntimeSnapshotsForTest();
});

describe("Gateway context cache remote proof", () => {
  it("keeps unrelated work responsive during the real post-ready warmup", async () => {
    const modelCount = Number.parseInt(process.env.SYNTHETIC_MODEL_COUNT ?? "2000", 10);
    const makeModels = (provider: string, baseWindow: number) =>
      Array.from({ length: modelCount }, (_, index) => ({
        id: index === 0 ? "shared-model" : `${provider}-model-${index}`,
        name: `${provider} model ${index}`,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: baseWindow + (index % 17),
        maxTokens: 8_192,
      }));
    testState.agentConfig = { workspace: process.cwd() };
    const port = await getGatewayTestPort();
    const token = "context-prewarm-proof-token";
    const server = await startTestGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientDisplayName: "context-prewarm-proof",
      requestTimeoutMs: 10_000,
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    try {
      const warmConfig = {
        agents: {
          defaults: {
            workspace: process.cwd(),
            model: { primary: "synthetic-a/shared-model" },
            models: {
              "synthetic-a/shared-model": { agentRuntime: { id: "openclaw" } },
              "synthetic-b/shared-model": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
        models: {
          providers: {
            "synthetic-a": {
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions" as const,
              models: makeModels("synthetic-a", 128_000),
            },
            "synthetic-b": {
              baseUrl: "http://127.0.0.1:2/v1",
              api: "openai-completions" as const,
              models: makeModels("synthetic-b", 64_000),
            },
          },
        },
      } satisfies OpenClawConfig;
      const { refreshPreparedModelRuntimeSnapshots } =
        await import("../agents/prepared-model-runtime.js");
      const pluginMetadata = preparePluginMetadata({ config: warmConfig });
      await refreshPreparedModelRuntimeSnapshots(warmConfig, {
        gatewayLifecycle: true,
        catalogMode: "static",
        defaultWorkspaceDir: process.cwd(),
        allowGatewaySubagentBinding: true,
        pluginMetadata,
      });
      const { getPublishedPreparedModelCatalogOwnerSnapshot } =
        await import("../agents/prepared-model-catalog.js");
      const publishedOwner = getPublishedPreparedModelCatalogOwnerSnapshot({
        config: structuredClone(warmConfig),
        allowGatewaySubagentBinding: true,
      });
      if (!publishedOwner) {
        throw new Error("synthetic Gateway model catalog owner was not published");
      }
      await Promise.all([
        client.request("health", { probe: true }),
        client.request("chat.metadata", {}),
        client.request("worktrees.branches", { repoRoot: process.cwd() }),
      ]);

      const contextModule = await import("../agents/context.js");
      contextModule.resetContextWindowCacheForTest();

      const heartbeatGaps: number[] = [];
      let lastHeartbeatAt = performance.now();
      const heartbeat = setInterval(() => {
        const now = performance.now();
        heartbeatGaps.push(now - lastHeartbeatAt);
        lastHeartbeatAt = now;
      }, 20);
      const delayMonitor = monitorEventLoopDelay({ resolution: 20 });
      delayMonitor.enable();
      const eluStart = performance.eventLoopUtilization();
      const cpuStart = process.cpuUsage();
      const memoryStart = process.memoryUsage();
      const resourceStart = process.resourceUsage();
      const gcDurationsMs: number[] = [];
      const gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          gcDurationsMs.push(entry.duration);
        }
      });
      gcObserver.observe({ entryTypes: ["gc"] });
      const latencies = {
        healthz: [] as number[],
        readyz: [] as number[],
        healthRpc: [] as number[],
        metadataRpc: [] as number[],
        branchesRpc: [] as number[],
      };
      const errors: string[] = [];
      const probeRpc = async (
        name: "healthRpc" | "metadataRpc" | "branchesRpc",
        method: string,
        params: Record<string, unknown>,
      ) => {
        const startedAt = performance.now();
        try {
          await client.request(method, params);
        } catch (error) {
          errors.push(`${name}:${String(error)}`);
        } finally {
          latencies[name].push(performance.now() - startedAt);
        }
      };
      let probing = true;

      const contextPreparationStartedAt = performance.now();
      const activeContextPreparation = prepareContextWindowCaches({
        config: publishedOwner.config,
        modelCatalog: publishedOwner.modelCatalog,
      }).then((caches) => {
        replaceContextWindowCaches(caches);
      });
      const probeLoop = (async () => {
        while (true) {
          await Promise.all([
            ...(["healthz", "readyz"] as const).map(async (name) => {
              const startedAt = performance.now();
              try {
                const response = await fetch(`http://127.0.0.1:${port}/${name}`);
                if (response.status !== 200) {
                  errors.push(`${name}:${response.status}`);
                }
                await response.arrayBuffer();
              } catch (error) {
                errors.push(`${name}:${String(error)}`);
              } finally {
                latencies[name].push(performance.now() - startedAt);
              }
            }),
            probeRpc("healthRpc", "health", { probe: true }),
            probeRpc("metadataRpc", "chat.metadata", {}),
            probeRpc("branchesRpc", "worktrees.branches", { repoRoot: process.cwd() }),
          ]);
          if (!probing) {
            break;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 40);
          });
        }
      })();
      const contextPreparationOutcome = await activeContextPreparation.then(
        () => ({ status: "loaded" as const }),
        (error: unknown) => ({ status: "rejected" as const, error: String(error) }),
      );
      const contextPreparationDurationMs = performance.now() - contextPreparationStartedAt;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      probing = false;
      await probeLoop;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 40);
      });
      const elu = performance.eventLoopUtilization(performance.eventLoopUtilization(), eluStart);
      const cpu = process.cpuUsage(cpuStart);
      const memoryEnd = process.memoryUsage();
      const resourceEnd = process.resourceUsage();
      delayMonitor.disable();
      clearInterval(heartbeat);
      gcObserver.disconnect();

      const result = {
        modelCount,
        maxHeartbeatGapMs: Math.max(...heartbeatGaps),
        delayMaxMs: delayMonitor.max / 1_000_000,
        delayP99Ms: delayMonitor.percentile(99) / 1_000_000,
        eventLoopUtilization: elu.utilization,
        cpu: { userMs: cpu.user / 1_000, systemMs: cpu.system / 1_000 },
        memory: {
          rssStartMiB: memoryStart.rss / 1024 / 1024,
          rssEndMiB: memoryEnd.rss / 1024 / 1024,
          heapUsedStartMiB: memoryStart.heapUsed / 1024 / 1024,
          heapUsedEndMiB: memoryEnd.heapUsed / 1024 / 1024,
          maxRssDeltaMiB: (resourceEnd.maxRSS - resourceStart.maxRSS) / 1024,
        },
        gc: {
          count: gcDurationsMs.length,
          totalMs: gcDurationsMs.reduce((total, duration) => total + duration, 0),
          maxMs: Math.max(0, ...gcDurationsMs),
        },
        maxHealthzMs: Math.max(...latencies.healthz),
        maxReadyzMs: Math.max(...latencies.readyz),
        maxHealthRpcMs: Math.max(...latencies.healthRpc),
        maxMetadataRpcMs: Math.max(...latencies.metadataRpc),
        maxBranchesRpcMs: Math.max(...latencies.branchesRpc),
        probeCounts: Object.fromEntries(
          Object.entries(latencies).map(([name, values]) => [name, values.length]),
        ),
        errors,
        contextPreparationOutcome,
        contextPreparationDurationMs,
        cacheSizes: (() => {
          const caches = getContextWindowCaches();
          return {
            configured: caches.configuredTokenCache.size,
            discovered: caches.discoveredTokenCache.size,
            windows: caches.contextWindowCache.size,
          };
        })(),
        publishedOwner: {
          configuredModelCount: Object.values(publishedOwner.config.models?.providers ?? {}).reduce(
            (count, provider) => count + (provider.models?.length ?? 0),
            0,
          ),
          catalogEntryCount: publishedOwner.modelCatalog.entries.length,
          staticEntryCount: publishedOwner.modelCatalog.staticEntries?.length ?? 0,
        },
        sharedBare: contextModule.lookupContextTokens("shared-model", {
          allowAsyncLoad: false,
          skipRuntimeConfigLoad: true,
        }),
        providerA: contextModule.resolveContextTokensForModel({
          cfg: warmConfig,
          provider: "synthetic-a",
          model: "shared-model",
          allowAsyncLoad: false,
        }),
        providerB: contextModule.resolveContextTokensForModel({
          cfg: warmConfig,
          provider: "synthetic-b",
          model: "shared-model",
          allowAsyncLoad: false,
        }),
      };
      console.log(`CONTEXT_PREWARM_GATEWAY_PROOF ${JSON.stringify(result)}`);

      expect(result.errors).toEqual([]);
      expect(result.contextPreparationOutcome).toEqual({ status: "loaded" });
      expect(result.cacheSizes.discovered).toBeGreaterThan(modelCount * 2);
      expect(result.cacheSizes.windows).toBeGreaterThan(modelCount * 2);
      expect(result.sharedBare).toBe(64_000);
      expect(result.providerA).toBe(128_000);
      expect(result.providerB).toBe(64_000);
      expect(result.maxHeartbeatGapMs).toBeLessThan(500);
      expect(result.maxHealthzMs).toBeLessThan(1_000);
      expect(result.maxReadyzMs).toBeLessThan(1_000);
      expect(result.maxHealthRpcMs).toBeLessThan(1_000);
      expect(result.maxMetadataRpcMs).toBeLessThan(1_000);
      expect(result.maxBranchesRpcMs).toBeLessThan(1_000);
    } finally {
      await disconnectGatewayClient(client);
      await server.close({ reason: "context prewarm remote proof complete" });
    }
  }, 120_000);
});
