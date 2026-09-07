// Subagent spawn thread-binding tests cover child-session placement, target
// account selection, and completion routing for channel thread spawns.
import assert from "node:assert/strict";
import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  hookRunner: {
    hasHooks: vi.fn(),
  },
}));

function firstRegisteredSubagentRun(): {
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  requesterDisplayKey?: string;
  requesterOrigin?: { channel?: string; accountId?: string; to?: string };
  expectsCompletionMessage?: boolean;
  spawnMode?: string;
} {
  const call = hoisted.registerSubagentRunMock.mock.calls[0]?.[0] as
    | {
        controllerSessionKey?: string;
        requesterSessionKey?: string;
        requesterDisplayKey?: string;
        requesterOrigin?: { channel?: string; accountId?: string; to?: string };
        expectsCompletionMessage?: boolean;
        spawnMode?: string;
      }
    | undefined;
  if (!call) {
    throw new Error("expected registered subagent run");
  }
  return call;
}

describe("spawnSubagentDirect thread binding delivery", () => {
  type SpawnModule = Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;
  type SetActivePluginRegistry =
    typeof import("../../../plugins/runtime.js").setActivePluginRegistry;
  type CreateChannelTestPluginBase =
    typeof import("../../../test-utils/channel-plugins.js").createChannelTestPluginBase;
  type CreateTestRegistry =
    typeof import("../../../test-utils/channel-plugins.js").createTestRegistry;
  type SessionBindingService = NonNullable<
    Parameters<typeof loadSubagentSpawnModuleForTest>[0]["getSessionBindingService"]
  >;
  type DeliveryTargetResolver = NonNullable<
    Parameters<typeof loadSubagentSpawnModuleForTest>[0]["resolveConversationDeliveryTarget"]
  >;

  let spawnSubagentDirect: SpawnModule["spawnSubagentDirect"];
  let setActivePluginRegistryForTest: SetActivePluginRegistry;
  let createChannelTestPluginBaseForTest: CreateChannelTestPluginBase;
  let createTestRegistryForTest: CreateTestRegistry;
  let currentConfig: Record<string, unknown>;
  let currentSessionBindingService: ReturnType<SessionBindingService>;
  let currentDeliveryTargetResolver: DeliveryTargetResolver;
  let routableProjection = true;

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => currentConfig,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      hookRunner: hoisted.hookRunner,
      resolveSubagentSpawnModelSelection: () => "openai/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      getSessionBindingService: () => currentSessionBindingService,
      resolveConversationDeliveryTarget: (params) => currentDeliveryTargetResolver(params),
    }));
    ({ setActivePluginRegistry: setActivePluginRegistryForTest } =
      await import("../../../plugins/runtime.js"));
    ({
      createChannelTestPluginBase: createChannelTestPluginBaseForTest,
      createTestRegistry: createTestRegistryForTest,
    } = await import("../../../test-utils/channel-plugins.js"));
  });

  function installChannelRouteProjectionPluginsForTest() {
    // Matrix fixture projects a parent room plus child thread id into the
    // gateway delivery target shape used by thread-bound sessions.
    const matrixBase = createChannelTestPluginBaseForTest({ id: "matrix", label: "Matrix" });
    setActivePluginRegistryForTest(
      createTestRegistryForTest([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...matrixBase,
            messaging: {
              resolveDeliveryTarget: ({
                conversationId,
                parentConversationId,
              }: {
                conversationId: string;
                parentConversationId?: string;
              }) => {
                if (!routableProjection) {
                  return {};
                }
                const parent = parentConversationId?.trim();
                const child = conversationId.trim();
                if (parent && parent !== child) {
                  return { to: `room:${parent}`, threadId: child };
                }
                return { to: `room:${child}` };
              },
            },
          },
        },
      ]),
    );
  }

  beforeEach(() => {
    routableProjection = true;
    installChannelRouteProjectionPluginsForTest();
    currentConfig = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
      session: {
        threadBindings: {
          defaultSpawnContext: "isolated",
        },
      },
    });
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => ({
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation: {
          channel: request.conversation.channel,
          accountId: request.conversation.accountId,
          conversationId: request.conversation.conversationId,
        },
      }),
      listBySession: () => [],
    };
    currentDeliveryTargetResolver = (params) => ({
      to: params.conversationId ? `channel:${String(params.conversationId)}` : undefined,
    });
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.hookRunner.hasHooks.mockReset();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
  });

  it.each([
    { mode: "run", thread: false, routable: true, announce: true, completion: "announce" },
    { mode: "run", thread: false, routable: true, announce: false, completion: "quiet" },
    { mode: "run", thread: true, routable: true, announce: true, completion: "announce" },
    { mode: "session", thread: true, routable: true, announce: true, completion: "thread-direct" },
    { mode: "session", thread: true, routable: true, announce: false, completion: "thread-direct" },
    { mode: "session", thread: true, routable: false, announce: true, completion: "announce" },
    { mode: "session", thread: true, routable: false, announce: false, completion: "quiet" },
  ] as const)(
    "aligns $mode thread=$thread routable=$routable announce=$announce guidance with delivery and cleanup",
    async ({ mode, thread, routable, announce, completion }) => {
      routableProjection = routable;
      const cleanup = completion === "quiet" && mode === "run" ? "delete" : "keep";
      const result = await spawnSubagentDirect(
        {
          task: "Return the requested findings.",
          mode,
          thread,
          expectsCompletionMessage: announce,
          cleanup,
        },
        { agentSessionKey: "agent:main:main", agentChannel: "matrix", agentTo: "room:parent" },
      );
      expect(result.status).toBe("accepted");
      const agentCall = hoisted.callGatewayMock.mock.calls.find(
        ([call]) => (call as { method?: string }).method === "agent",
      )?.[0] as { params: Record<string, unknown> };
      expect(agentCall.params.deliver).toBe(completion === "thread-direct");
      expect(result.expectsCompletionMessage).toBe(completion === "announce");
      expect(firstRegisteredSubagentRun().expectsCompletionMessage).toBe(completion === "announce");
      assert(
        typeof agentCall.params.extraSystemPrompt === "string",
        "child system prompt must be text",
      );
      assert(typeof agentCall.params.message === "string", "child task must be text");
      const childGuidance = `${agentCall.params.extraSystemPrompt}\n${agentCall.params.message}`;
      const contract = {
        announce: /completion event/i,
        quiet: /no completion notification/i,
        "thread-direct": /directly to the bound thread/i,
      }[completion];
      expect.soft(childGuidance).toMatch(contract);
      expect.soft(result.note).toMatch(contract);
      if (cleanup === "delete") {
        expect(firstRegisteredSubagentRun()).toMatchObject({ cleanup: "delete" });
        expect.soft(childGuidance).not.toContain("remains in the child session");
        expect.soft(result.note).not.toContain("remains in the child session");
      }
      if (completion !== "announce") {
        expect.soft(childGuidance).not.toMatch(/final auto-reported|Results auto-announce/);
        expect.soft(result.note).not.toMatch(/Auto-announce is push-based/);
      }
    },
  );

  it("passes the target agent's bound account to core thread binding", async () => {
    // Cross-agent spawns bind the target agent account, while requester origin
    // remains the caller account for completion reporting.
    const boundRoom = "!room:example.org";
    const bindCalls: Array<Record<string, unknown>> = [];
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => {
        bindCalls.push(request as unknown as Record<string, unknown>);
        return {
          targetSessionKey: request.targetSessionKey,
          targetKind: request.targetKind,
          status: "active",
          conversation: {
            channel: request.conversation.channel,
            accountId: request.conversation.accountId,
            conversationId: "$thread-root",
            parentConversationId: request.conversation.conversationId,
          },
        };
      },
      listBySession: () => [],
    };
    currentConfig = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: {
            allowAgents: ["bot-alpha"],
          },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "bot-alpha", workspace: "/tmp/workspace-bot-alpha" },
        ],
      },
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "matrix",
            peer: {
              kind: "channel",
              id: boundRoom,
            },
            accountId: "bot-alpha",
          },
        },
      ],
    });

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        agentId: "bot-alpha",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "bot-beta",
        agentTo: `room:${boundRoom}`,
      },
    );

    expect(result.status).toBe("accepted");
    expect(bindCalls).toHaveLength(1);
    const bindingConversation = bindCalls[0]?.conversation as
      | { channel?: string; accountId?: string; conversationId?: string }
      | undefined;
    expect(bindingConversation?.channel).toBe("matrix");
    expect(bindingConversation?.accountId).toBe("bot-alpha");
    expect(bindingConversation?.conversationId).toBe(boundRoom);
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([call]) => (call as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params?.channel).toBe("matrix");
    expect(agentCall?.params?.accountId).toBe("bot-alpha");
    expect(agentCall?.params?.to).toBe(`room:${boundRoom}`);
    expect(agentCall?.params?.threadId).toBe("$thread-root");
    expect(agentCall?.params?.deliver).toBe(true);
    const registeredRun = firstRegisteredSubagentRun();
    expect(registeredRun?.requesterOrigin?.channel).toBe("matrix");
    expect(registeredRun?.requesterOrigin?.accountId).toBe("bot-beta");
    expect(registeredRun?.requesterOrigin?.to).toBe(`room:${boundRoom}`);
    expect(registeredRun?.expectsCompletionMessage).toBe(false);
    expect(registeredRun?.spawnMode).toBe("session");
  });

  it("uses controller ownership for thread binding while completion routes to owner", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:matrix:default:room:456",
        completionOwnerKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: "room:456",
      },
    );

    expect(result.status).toBe("accepted");
    const registeredRun = firstRegisteredSubagentRun();
    expect(registeredRun.controllerSessionKey).toBe("agent:main:matrix:default:room:456");
    expect(registeredRun.requesterSessionKey).toBe("agent:main:main");
    expect(registeredRun.requesterDisplayKey).toBe("agent:main:main");
  });

  it("uses core binding delivery when only a generic route projection is available", async () => {
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => ({
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation: {
          channel: "collabchat",
          accountId: "work",
          conversationId: "collab_dm_1",
        },
      }),
      listBySession: () => [
        {
          status: "active",
          conversation: {
            channel: "collabchat",
            accountId: "work",
            conversationId: "collab_dm_1",
          },
        },
      ],
    };
    currentDeliveryTargetResolver = () => ({
      to: "channel:collab_dm_1",
    });

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
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
    expect(agentCall?.params?.channel).toBe("collabchat");
    expect(agentCall?.params?.accountId).toBe("work");
    expect(agentCall?.params?.to).toBe("channel:collab_dm_1");
    expect(agentCall?.params?.deliver).toBe(true);
    const registeredRun = firstRegisteredSubagentRun();
    expect(registeredRun?.expectsCompletionMessage).toBe(false);
    expect(registeredRun?.requesterOrigin?.channel).toBe("matrix");
    expect(registeredRun?.requesterOrigin?.accountId).toBe("sut");
    expect(registeredRun?.requesterOrigin?.to).toBe("room:!parent:example");
  });
});
