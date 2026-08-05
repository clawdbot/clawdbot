import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetContextWindowCacheForTest } from "./context-runtime-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const originalHome = process.env.HOME;
const originalOpenClawHome = process.env.OPENCLAW_HOME;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-prewarm-"));
const workspaceDir = path.join(root, "workspace");
fs.mkdirSync(workspaceDir, { recursive: true });
process.env.HOME = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");

function createSyntheticConfig(modelCount: number): OpenClawConfig {
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
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
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
  };
}

async function measureCacheLoad(load: () => Promise<void>) {
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
  const immediateSpy = vi.spyOn(globalThis, "setImmediate");
  const startedAt = performance.now();
  let completedAt = startedAt;
  let immediateCallCount: number;
  try {
    await load();
    completedAt = performance.now();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
  } finally {
    immediateCallCount = immediateSpy.mock.calls.length;
    immediateSpy.mockRestore();
    delayMonitor.disable();
    clearInterval(heartbeat);
  }
  const elu = performance.eventLoopUtilization(performance.eventLoopUtilization(), eluStart);
  return {
    warmMs: completedAt - startedAt,
    maxHeartbeatGapMs: Math.max(...heartbeatGaps),
    delayMaxMs: delayMonitor.max / 1_000_000,
    delayP99Ms: delayMonitor.percentile(99) / 1_000_000,
    eventLoopUtilization: elu.utilization,
    immediateCallCount,
    heartbeatCount: heartbeatGaps.length,
  };
}

afterAll(() => {
  resetContextWindowCacheForTest();
  resetPreparedModelRuntimeSnapshotsForTest();
  process.env.HOME = originalHome;
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("post-ready context cache prewarm", () => {
  it("yields through the real prepared catalog lifecycle and converges atomically", async () => {
    const modelCount = Number.parseInt(process.env.SYNTHETIC_MODEL_COUNT ?? "20000", 10);
    const config = createSyntheticConfig(modelCount);

    const runtimeModule = await import("./prepared-model-runtime.js");
    const contextModule = await import("./context.js");
    await runtimeModule.refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: workspaceDir,
    });
    contextModule.resetContextWindowCacheForTest();

    const metrics = await measureCacheLoad(() =>
      contextModule.prewarmContextWindowCacheAfterReady({
        config: process.env.SYNTHETIC_CLONE_CONFIG === "0" ? config : structuredClone(config),
      }),
    );
    console.log(
      `CONTEXT_PREWARM_GREEN ${JSON.stringify({
        modelCount,
        ...metrics,
      })}`,
    );

    expect(metrics.immediateCallCount).toBeGreaterThan(0);
    expect(metrics.heartbeatCount).toBeGreaterThan(0);
    expect(metrics.maxHeartbeatGapMs).toBeLessThan(500);
    expect(metrics.delayMaxMs).toBeLessThan(500);
    expect(
      contextModule.lookupContextTokens("shared-model", {
        allowAsyncLoad: false,
        skipRuntimeConfigLoad: true,
      }),
    ).toBe(64_000);
    expect(
      contextModule.resolveContextTokensForModel({
        cfg: config,
        provider: "synthetic-a",
        model: "shared-model",
        allowAsyncLoad: false,
      }),
    ).toBe(128_000);
    expect(
      contextModule.resolveContextTokensForModel({
        cfg: config,
        provider: "synthetic-b",
        model: "shared-model",
        allowAsyncLoad: false,
      }),
    ).toBe(64_000);
  }, 30_000);

  it("keeps first-request configured projection cooperative through the real catalog owner", async () => {
    const modelCount = Number.parseInt(process.env.SYNTHETIC_MODEL_COUNT ?? "20000", 10);
    const config = createSyntheticConfig(modelCount);
    const runtimeModule = await import("./prepared-model-runtime.js");
    const contextModule = await import("./context.js");
    await runtimeModule.refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: workspaceDir,
    });
    contextModule.resetContextWindowCacheForTest();

    const lastConfiguredModel = `synthetic-a-model-${modelCount - 1}`;
    const metrics = await measureCacheLoad(() => {
      const loadPromise = contextModule.ensureContextWindowCacheLoaded(config);
      expect(
        contextModule.lookupContextTokens(lastConfiguredModel, {
          allowAsyncLoad: false,
          skipRuntimeConfigLoad: true,
        }),
      ).toBeUndefined();
      return loadPromise;
    });
    console.log(
      `CONTEXT_REQUEST_LOAD_GREEN ${JSON.stringify({
        modelCount,
        ...metrics,
      })}`,
    );

    expect(metrics.immediateCallCount).toBeGreaterThan(0);
    expect(metrics.heartbeatCount).toBeGreaterThan(0);
    expect(metrics.maxHeartbeatGapMs).toBeLessThan(500);
    expect(metrics.delayMaxMs).toBeLessThan(500);
    expect(
      contextModule.lookupContextTokens(lastConfiguredModel, {
        allowAsyncLoad: false,
        skipRuntimeConfigLoad: true,
      }),
    ).toBe(128_000 + ((modelCount - 1) % 17));
  }, 30_000);
});
