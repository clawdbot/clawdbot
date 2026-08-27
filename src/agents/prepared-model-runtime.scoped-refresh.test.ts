// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime scoped refresh", () => {
  beforeEach(() => resetPreparedModelRuntimeHarness());

  it("retains unaffected configured owners across an agent-scoped refresh", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        entries: {
          pro: { model: "openai/gpt-5.6" },
          free: { model: "openai/gpt-5.5" },
        },
      },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        entries: {
          pro: { model: "openai/gpt-5.4" },
          free: { model: "openai/gpt-5.5" },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];
    const freeInput = {
      config: initialConfig,
      agentId: "free",
      agentDir: "/tmp/configured-free",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/workspace-free",
    };

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
    const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);

    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    const retained = getPreparedModelRuntimeSnapshot({ ...freeInput, config: nextConfig });
    expect(buildCounts).toEqual([2, 1]);
    expect(retained).toMatchObject({ agentId: "free", config: nextConfig });
    expect(retained).not.toBe(retainedReader);
    expect(retainedReader.config).toBe(initialConfig);
    expect(retained?.metadataSnapshot).toBe(retainedReader.metadataSnapshot);
    expect(retained?.modelCatalog).toBe(retainedReader.modelCatalog);
    expect(getPreparedModelRuntimeAuthStore(retained!)).toBe(retainedAuthStore);
  });

  it("falls back to full refresh when an out-of-scope owner dependency changes", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.6" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([2, 2]);
  });

  it("builds only a newly added non-default agent", async () => {
    mocks.configuredAgentIds = ["free"];
    const initialConfig = {
      agents: { entries: { free: { model: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        entries: {
          free: { model: "openai/gpt-5.5" },
          pro: { model: "openai/gpt-5.6" },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    mocks.configuredAgentIds = ["free", "pro"];
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([1, 1]);
    expect(
      getPreparedModelRuntimeSnapshot({
        config: nextConfig,
        agentId: "pro",
        agentDir: "/tmp/configured-pro",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-pro",
      }),
    ).toMatchObject({ agentId: "pro", config: nextConfig });
  });
});
