import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  pruneLegacyStoreKeysMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      pruneLegacyStoreKeysMock: hoisted.pruneLegacyStoreKeysMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      resolveAgentConfig: () => undefined,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
      resetModules: false,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.pruneLegacyStoreKeysMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);

    hoisted.updateSessionStoreMock.mockImplementation(
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

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        agentThreadId: 42,
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      mode: "run",
      modelApplied: true,
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(1);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          accountId: "acct-1",
          to: "user-1",
          threadId: 42,
        },
        task: "inspect the spawn seam",
        cleanup: "keep",
        model: "openai-codex/gpt-5.4",
        workspaceDir: "/tmp/requester-workspace",
        expectsCompletionMessage: true,
        spawnMode: "run",
      }),
    );
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: childSessionKey,
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(operations.indexOf("gateway:sessions.patch")).toBeGreaterThan(-1);
    expect(operations.indexOf("store:update")).toBeGreaterThan(
      operations.indexOf("gateway:sessions.patch"),
    );
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(operations.indexOf("store:update"));
  });

  it("omits requesterOrigin threadId when no requester thread is provided", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "inspect unthreaded spawn",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterOrigin: expect.objectContaining({
          channel: "discord",
          accountId: "acct-1",
          to: "user-1",
          threadId: undefined,
        }),
      }),
    );
  });

  it("pins admin-only methods to operator.admin and preserves least-privilege for others (#59428)", async () => {
    const capturedCalls: Array<{ method?: string; scopes?: string[] }> = [];

    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; scopes?: string[] }) => {
        capturedCalls.push({ method: request.method, scopes: request.scopes });
        if (request.method === "agent") {
          return { runId: "run-1" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify per-method scope routing",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(capturedCalls.length).toBeGreaterThan(0);

    for (const call of capturedCalls) {
      if (call.method === "sessions.patch" || call.method === "sessions.delete") {
        // Admin-only methods must be pinned to operator.admin.
        expect(call.scopes).toEqual(["operator.admin"]);
      } else {
        // Non-admin methods (e.g. "agent") must NOT be forced to admin scope
        // so the gateway preserves least-privilege and senderIsOwner stays false.
        expect(call.scopes).toBeUndefined();
      }
    }
  });

  it("forwards normalized thinking to the agent run", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-thinking", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify thinking forwarding",
        thinking: "high",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
    });
    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall?.params).toMatchObject({
      thinking: "high",
    });
  });

  it("returns an error when the initial model patch is rejected", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "sessions.patch") {
          const model = (request.params as { model?: unknown } | undefined)?.model;
          if (model === "bad-model") {
            throw new Error("invalid model: bad-model");
          }
          return { ok: true };
        }
        if (request.method === "agent") {
          return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "verify patch rejection",
        model: "bad-model",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
    });
    expect(result.error ?? "").toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
