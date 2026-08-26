// Subagent spawn model-session tests verify runtime model metadata is persisted
// before a child agent run starts.
import os from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveSessionAuthProfileOverrideSource } from "../../../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { resolveSessionAuthSelection } from "../../auth-profiles/session-override.js";
import { saveAuthProfileStore } from "../../auth-profiles/store.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function toCapturedSessionEntry(value: unknown): SessionEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sessionId !== "string") {
    return undefined;
  }
  return {
    ...candidate,
    sessionId: candidate.sessionId,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
  };
}

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      updateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);

    updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("persists runtime model fields on the child session before starting the run", async () => {
    // The child run reads model/provider from session state, so persistence must
    // happen before the gateway accepts the agent request.
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      if (opts.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "test",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.modelApplied).toBe(true);
    expect(result.resolvedModel).toBe("openai/gpt-5.4");
    expect(result.resolvedProvider).toBe("openai");
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(2);
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
  });

  it("persists self-origin metadata for auto-selected subagent models", async () => {
    const dedicatedUpdateSessionStoreMock = vi.fn();
    const {
      resetSubagentRegistryForTests: resetForAutoModelTest,
      spawnSubagentDirect: spawnWithAutoModel,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
              model: { primary: "openai/gpt-5.5" },
              subagents: { model: "gpt-5.4" },
            },
          },
        }),
      updateSessionStoreMock: dedicatedUpdateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    });
    resetForAutoModelTest();
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(dedicatedUpdateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnWithAutoModel(
      {
        task: "test",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry?.modelOverrideSource).toBe("auto");
    expect(persistedEntry?.modelOverrideFallbackOriginProvider).toBe("openai");
    expect(persistedEntry?.modelOverrideFallbackOriginModel).toBe("gpt-5.4");
  });

  it("keeps a selected auth profile separate from the authorized child model", async () => {
    const targetAgentDir = tempDirs.make("openclaw-subagent-auth-");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-default" },
          "openai:work": { type: "api_key", provider: "openai", key: "sk-test" },
          "anthropic:work": { type: "api_key", provider: "anthropic", key: "sk-other" },
        },
        order: { openai: ["openai:default", "openai:work"] },
      },
      targetAgentDir,
      { syncExternalCli: false },
    );
    const cfg = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": { alias: "approved" } },
        },
        list: [
          { id: "main", subagents: { allowAgents: ["worker"] } },
          {
            id: "worker",
            agentDir: targetAgentDir,
            model: { primary: "openai/gpt-5.6-luna" },
            modelPolicy: { allow: ["approved"] },
          },
        ],
      },
    }) as OpenClawConfig;
    const dedicatedCallGatewayMock = vi.fn();
    const dedicatedUpdateSessionStoreMock = vi.fn();
    const {
      resetSubagentRegistryForTests: resetForProfileTest,
      spawnSubagentDirect: spawnWithProfile,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: dedicatedCallGatewayMock,
      getRuntimeConfig: () => cfg,
      loadPreparedModelCatalogMock: vi
        .fn()
        .mockResolvedValue([{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }]),
      updateSessionStoreMock: dedicatedUpdateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    });
    resetForProfileTest();
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    let attemptedRun: Record<string, unknown> | undefined;
    installSessionStoreCaptureMock(dedicatedUpdateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });
    dedicatedCallGatewayMock.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        if (request.method === "agent") {
          const [sessionKey, rawEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
          const sessionEntry = toCapturedSessionEntry(rawEntry);
          const authSelection = await resolveSessionAuthSelection({
            cfg,
            provider: "openai",
            modelId: "gpt-5.6-luna",
            agentDir: targetAgentDir,
            sessionEntry,
            sessionStore: sessionKey && sessionEntry ? { [sessionKey]: sessionEntry } : undefined,
            sessionKey,
            isNewSession: true,
          });
          const authProfileId = authSelection?.profileId;
          attemptedRun = {
            provider: request.params?.provider,
            model: request.params?.model,
            authProfileId,
            authProfileIdSource:
              authProfileId && sessionEntry?.authProfileOverride === authProfileId
                ? resolveSessionAuthProfileOverrideSource(sessionEntry)
                : undefined,
          };
          return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
        }
        return { ok: true };
      },
    );

    for (const profileId of ["openai:missing", "anthropic:work"]) {
      const rejected = await spawnWithProfile(
        { task: "reject selected credentials", agentId: "worker", model: `approved@${profileId}` },
        { agentSessionKey: "agent:main:main" },
      );
      expect(rejected).toMatchObject({
        status: "error",
        error: expect.stringContaining(`auth profile "${profileId}" is unavailable`),
      });
      expect(persistedStore).toBeUndefined();
      expect(dedicatedCallGatewayMock).not.toHaveBeenCalled();
    }

    const result = await spawnWithProfile(
      { task: "use selected credentials", agentId: "worker", model: "approved@openai:work" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      resolvedModel: "openai/gpt-5.6-luna",
      resolvedProvider: "openai",
    });
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideRequired: true,
    });
    expect(attemptedRun).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });
  });
});
