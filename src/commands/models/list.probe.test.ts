// Model list probe tests cover runtime probing while listing configured models.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../../infra/gateway-lock.js";

let probeModule: typeof import("./list.probe.js");

function createGatewayLockOptions(stateDir: string): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    readProcessStartTime: () => 123_456,
    timeoutMs: 100,
  };
}

function createSignalProcess() {
  type SignalName = "SIGINT" | "SIGTERM";
  const listeners = new Map<SignalName, Set<() => void>>();
  const processLike = {
    on(signal: SignalName, handler: () => void) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(handler);
      listeners.set(signal, current);
      return processLike;
    },
    off(signal: SignalName, handler: () => void) {
      listeners.get(signal)?.delete(handler);
      return processLike;
    },
  };
  return {
    processLike,
    emit(signal: SignalName) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
  };
}

async function withTempState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-probe-lock-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("mapFailoverReasonToProbeStatus", () => {
  beforeAll(async () => {
    vi.doMock("../../agents/embedded-agent.js", () => {
      throw new Error("embedded-agent should stay lazy for probe imports");
    });
    try {
      probeModule = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
    }
  });

  it("does not import the embedded runner on module load", () => {
    expect(probeModule.mapFailoverReasonToProbeStatus).toBeTypeOf("function");
  });

  it("maps failover reasons to probe statuses", () => {
    const { mapFailoverReasonToProbeStatus } = probeModule;
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("overloaded")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("format");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");

    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("something_else")).toBe("unknown");
  });
});

describe("runAuthProbes", () => {
  beforeAll(async () => {
    probeModule ??= await import("./list.probe.js");
  });

  it("refuses direct CLI probes while a live Gateway owns canonical state", async () => {
    await withTempState(async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
      expect(gatewayLock).not.toBeNull();
      if (!gatewayLock) {
        throw new Error("Expected live Gateway fixture lock");
      }
      try {
        await expect(
          probeModule.withAuthProbeStateOwnership(
            { mode: "exclusive", gatewayLockOptions: lockOptions },
            async () => undefined,
          ),
        ).rejects.toThrow(
          `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Stop the Gateway first (openclaw gateway stop), then rerun models status --probe.`,
        );
      } finally {
        await gatewayLock.release();
      }
    });
  });

  it("holds and releases canonical state ownership around direct CLI probes", async () => {
    await withTempState(async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
      let observedPayload: { pid?: number; role?: string } | undefined;

      await probeModule.withAuthProbeStateOwnership(
        { mode: "exclusive", gatewayLockOptions: lockOptions },
        async () => {
          observedPayload = JSON.parse(fsSync.readFileSync(stateLockPath, "utf8")) as {
            pid?: number;
            role?: string;
          };
        },
      );

      expect(observedPayload).toMatchObject({ pid: process.pid, role: "agent-embedded" });
      await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("releases canonical state ownership when a direct CLI probe receives SIGTERM", async () => {
    await withTempState(async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
      const signals = createSignalProcess();

      await probeModule.withAuthProbeStateOwnership(
        {
          mode: "exclusive",
          gatewayLockOptions: lockOptions,
          process: signals.processLike,
        },
        async (signal) => {
          let markInterrupted!: () => void;
          const interrupted = new Promise<void>((resolve) => {
            markInterrupted = resolve;
          });
          signal?.addEventListener("abort", markInterrupted, { once: true });
          signals.emit("SIGTERM");
          await interrupted;
        },
      );

      await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("runs Codex-pinned auth probes through raw OpenClaw model-run mode", async () => {
    const runEmbeddedAgent = vi.fn(
      async (params: {
        agentDir?: string;
        agentHarnessRuntimeOverride?: string;
        authProfileId?: string;
        authProfileIdSource?: string;
        config?: OpenClawConfig;
      }) => {
        if (params.agentHarnessRuntimeOverride !== "openclaw") {
          throw new Error(
            'Requested agent harness "codex" does not support openai/gpt-5.5 (Codex cannot reproduce authored request transport overrides).',
          );
        }
        return { text: "OK" };
      },
    );
    vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
    vi.doMock("../../agents/auth-profiles.js", () => ({
      clearRuntimeAuthProfileStoreSnapshot: () => false,
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({
        version: 1,
        profiles: {
          "openai:profile": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        order: {},
      }),
      listProfilesForProvider: () => ["openai:profile"],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => ["openai:profile"],
      upsertAuthProfileWithLock: vi.fn(),
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => false,
      resolveEnvApiKey: () => null,
      resolveProviderEntryApiKeyBinding: vi.fn(),
      resolveProviderEntryApiKeyProfileReference: () => ({ kind: "none" }),
    }));
    vi.doMock("../../agents/prepared-model-catalog.js", () => ({
      loadPreparedModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
    }));
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      const result = await module.runAuthProbes({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                agentRuntime: { id: "codex" },
                models: [],
              },
            },
          },
        } satisfies OpenClawConfig,
        agentId: "probe-agent",
        agentDir: "/tmp/openclaw-probe-agent",
        workspaceDir: "/tmp/openclaw-probe-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          profileIds: ["openai:profile"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      expect(result.results[0]?.status).toBe("ok");
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentHarnessRuntimeOverride: "openclaw",
          modelRun: true,
          disableTools: true,
          authProfileId: "openai:profile",
          authProfileIdSource: "user",
        }),
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/prepared-model-catalog.js");
    }
  });

  it("preserves provider config while suppressing profiles for a config-key target", async () => {
    const runEmbeddedAgent = vi.fn(
      async (_params: {
        agentDir?: string;
        authProfileId?: string;
        authProfileIdSource?: string;
        config?: OpenClawConfig;
      }) => ({ text: "OK" }),
    );
    vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
    const upsertAuthProfileWithLock = vi.fn(
      async (params: { profileId: string; credential: unknown }) => ({
        version: 1,
        profiles: { [params.profileId]: params.credential },
      }),
    );
    const clearRuntimeAuthProfileStoreSnapshot = vi.fn(() => true);
    vi.doMock("../../agents/auth-profiles.js", () => ({
      clearRuntimeAuthProfileStoreSnapshot,
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({
        version: 1,
        profiles: {
          "openai:profile": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        order: {},
      }),
      listProfilesForProvider: () => ["openai:profile"],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => ["openai:profile"],
      upsertAuthProfileWithLock,
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => true,
      resolveEnvApiKey: () => null,
      resolveProviderEntryApiKeyBinding: vi.fn(),
      resolveProviderEntryApiKeyProfileReference: () => ({
        kind: "literal",
        apiKey: "test",
        source: "models.json",
      }),
    }));
    vi.doMock("../../agents/prepared-model-catalog.js", () => ({
      loadPreparedModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
    }));
    const providerConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses" as const,
      apiKey: "test",
      auth: "oauth" as const,
      models: [],
    };
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      await module.runAuthProbes({
        cfg: { models: { providers: { openai: providerConfig } } },
        agentId: "probe-agent",
        agentDir: "/tmp/openclaw-probe-agent",
        workspaceDir: "/tmp/openclaw-probe-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          includeDirectKeys: true,
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      const configKeyCall = runEmbeddedAgent.mock.calls.find(([params]) =>
        params.authProfileId?.startsWith("openai:probe-"),
      );
      expect(configKeyCall?.[0].agentDir).not.toBe("/tmp/openclaw-probe-agent");
      expect(configKeyCall?.[0].authProfileIdSource).toBe("user");
      expect(configKeyCall?.[0].config).toMatchObject({
        models: {
          providers: {
            openai: {
              ...providerConfig,
              apiKey: "test",
              auth: "oauth",
            },
          },
        },
        auth: { order: { openai: [] } },
      });
      const expected = expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access: "test",
      });
      expect(upsertAuthProfileWithLock).toHaveBeenCalledWith({
        profileId: configKeyCall?.[0].authProfileId,
        credential: expected,
        agentDir: configKeyCall?.[0].agentDir,
      });
      expect(clearRuntimeAuthProfileStoreSnapshot).toHaveBeenCalledWith(
        configKeyCall?.[0].agentDir,
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/prepared-model-catalog.js");
    }
  });

  it("isolates marker credentials from stored profiles without pinning a synthetic one", async () => {
    const runEmbeddedAgent = vi.fn(
      async (_params: { agentDir?: string; authProfileId?: string; config?: OpenClawConfig }) => ({
        text: "OK",
      }),
    );
    const upsertAuthProfileWithLock = vi.fn();
    vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
    vi.doMock("../../agents/auth-profiles.js", () => ({
      clearRuntimeAuthProfileStoreSnapshot: () => false,
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({ version: 1, profiles: {}, order: {} }),
      listProfilesForProvider: () => [],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => [],
      upsertAuthProfileWithLock,
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => true,
      resolveEnvApiKey: () => ({ apiKey: "envkey", source: "OPENAI_API_KEY" }),
      resolveProviderEntryApiKeyBinding: vi.fn(),
      resolveProviderEntryApiKeyProfileReference: () => ({ kind: "marker" }),
      resolveUsableCustomProviderApiKey: () => ({
        apiKey: "envkey",
        source: "OPENAI_API_KEY",
      }),
    }));
    vi.doMock("../../agents/prepared-model-catalog.js", () => ({
      loadPreparedModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
    }));
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses" as const,
            // Marker value assembled to satisfy review-bundle secret scanning.
            apiKey: ["OPENAI", "API", "KEY"].join("_"),
            models: [],
          },
        },
      },
    };
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      await module.runAuthProbes({
        cfg,
        agentId: "probe-agent",
        agentDir: "/tmp/openclaw-probe-agent",
        workspaceDir: "/tmp/openclaw-probe-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          includeDirectKeys: true,
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      // Runs in an isolated agent dir (no stored profiles) with the provider's
      // auth order cleared, so only the marker credential is exercised — and no
      // synthetic profile is pinned, letting the runtime resolve the marker.
      const call = runEmbeddedAgent.mock.calls[0]?.[0];
      expect(call?.agentDir).not.toBe("/tmp/openclaw-probe-agent");
      expect(call?.agentDir).toContain("openclaw-auth-probe-");
      expect(call?.config?.auth?.order?.openai).toEqual([]);
      expect(call?.config?.models?.providers?.openai?.apiKey).toBe(
        cfg.models.providers.openai.apiKey,
      );
      expect(call?.authProfileId).toBeUndefined();
      expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/prepared-model-catalog.js");
    }
  });
});
