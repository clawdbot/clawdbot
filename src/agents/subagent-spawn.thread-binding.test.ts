import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  hookRunner: {
    hasHooks: vi.fn(),
    runSubagentSpawning: vi.fn(),
  },
}));

describe("spawnSubagentDirect thread binding delivery", () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.hookRunner.hasHooks.mockReset();
    hoisted.hookRunner.runSubagentSpawning.mockReset();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
  });

  it("seeds a thread-bound child session from the binding created during spawn", async () => {
    hoisted.hookRunner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "subagent_spawning",
    );
    hoisted.hookRunner.runSubagentSpawning.mockResolvedValue({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "matrix",
        accountId: "sut",
        to: "room:!room:example",
        threadId: "$thread-root",
      },
    });
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
            },
            list: [{ id: "main", workspace: "/tmp/workspace-main" }],
          },
        }),
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      hookRunner: hoisted.hookRunner,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "sut",
        agentTo: "room:!room:example",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([call]) => (call as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).toMatchObject({
      channel: "matrix",
      accountId: "sut",
      to: "room:!room:example",
      threadId: "$thread-root",
      deliver: true,
    });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterOrigin: {
          channel: "matrix",
          accountId: "sut",
          to: "room:!room:example",
          threadId: "$thread-root",
        },
        expectsCompletionMessage: false,
        spawnMode: "session",
      }),
    );
  });

  it("keeps completion announcements when only a generic binding is available", async () => {
    hoisted.hookRunner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "subagent_spawning",
    );
    hoisted.hookRunner.runSubagentSpawning.mockResolvedValue({
      status: "ok",
      threadBindingReady: true,
    });
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
            },
            list: [{ id: "main", workspace: "/tmp/workspace-main" }],
          },
        }),
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      hookRunner: hoisted.hookRunner,
      getSessionBindingService: () => ({
        listBySession: () => [
          {
            status: "active",
            conversation: {
              channel: "feishu",
              accountId: "work",
              conversationId: "oc_dm_chat_1",
            },
          },
        ],
      }),
      resolveConversationDeliveryTarget: () => ({
        to: "channel:oc_dm_chat_1",
      }),
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "sut",
        agentTo: "room:!parent:example",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([call]) => (call as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).toMatchObject({
      channel: "matrix",
      accountId: "sut",
      to: "room:!parent:example",
      deliver: false,
    });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectsCompletionMessage: true,
        requesterOrigin: {
          channel: "matrix",
          accountId: "sut",
          to: "room:!parent:example",
        },
      }),
    );
  });
});
