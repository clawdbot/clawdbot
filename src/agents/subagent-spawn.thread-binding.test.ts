import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  type SessionBindingService = NonNullable<
    Parameters<typeof loadSubagentSpawnModuleForTest>[0]["getSessionBindingService"]
  >;
  type DeliveryTargetResolver = NonNullable<
    Parameters<typeof loadSubagentSpawnModuleForTest>[0]["resolveConversationDeliveryTarget"]
  >;

  let spawnSubagentDirect: SpawnModule["spawnSubagentDirect"];
  let currentConfig: Record<string, unknown>;
  let currentSessionBindingService: ReturnType<SessionBindingService>;
  let currentDeliveryTargetResolver: DeliveryTargetResolver;

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => currentConfig,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      hookRunner: hoisted.hookRunner,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      getSessionBindingService: () => currentSessionBindingService,
      resolveConversationDeliveryTarget: (params) => currentDeliveryTargetResolver(params),
    }));
  });

  beforeEach(() => {
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
    currentSessionBindingService = { listBySession: () => [] };
    currentDeliveryTargetResolver = (params) => ({
      to: params.conversationId ? `channel:${String(params.conversationId)}` : undefined,
    });
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.hookRunner.hasHooks.mockReset();
    hoisted.hookRunner.runSubagentSpawning.mockReset();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
  });

  it("passes the target agent's bound account to thread binding hooks", async () => {
    const boundRoom = "!room:example.org";
    let hookRequester:
      | { channel?: string; accountId?: string; to?: string; threadId?: string | number }
      | undefined;
    hoisted.hookRunner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "subagent_spawning",
    );
    hoisted.hookRunner.runSubagentSpawning.mockImplementation(async (event: unknown) => {
      hookRequester = (
        event as {
          requester?: {
            channel?: string;
            accountId?: string;
            to?: string;
            threadId?: string | number;
          };
        }
      ).requester;
      return {
        status: "ok",
        threadBindingReady: true,
        deliveryOrigin: {
          channel: "matrix",
          to: `room:${boundRoom}`,
          threadId: "$thread-root",
        },
      };
    });
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
    expect(hookRequester?.channel).toBe("matrix");
    expect(hookRequester?.accountId).toBe("bot-alpha");
    expect(hookRequester?.to).toBe(`room:${boundRoom}`);
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
    let hookRequesterSessionKey: string | undefined;
    hoisted.hookRunner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "subagent_spawning",
    );
    hoisted.hookRunner.runSubagentSpawning.mockImplementation(
      async (_event: unknown, ctx?: { requesterSessionKey?: string }) => {
        hookRequesterSessionKey = ctx?.requesterSessionKey;
        return {
          status: "ok",
          threadBindingReady: true,
        };
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:telegram:default:direct:456",
        completionOwnerKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:direct:456",
      },
    );

    expect(result.status).toBe("accepted");
    expect(hookRequesterSessionKey).toBe("agent:main:telegram:default:direct:456");
    const registeredRun = firstRegisteredSubagentRun();
    expect(registeredRun.controllerSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(registeredRun.requesterSessionKey).toBe("agent:main:main");
    expect(registeredRun.requesterDisplayKey).toBe("agent:main:main");
  });

  it("keeps completion announcements when only a generic binding is available", async () => {
    hoisted.hookRunner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "subagent_spawning",
    );
    hoisted.hookRunner.runSubagentSpawning.mockResolvedValue({
      status: "ok",
      threadBindingReady: true,
    });
    currentSessionBindingService = {
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
    expect(agentCall?.params?.channel).toBe("matrix");
    expect(agentCall?.params?.accountId).toBe("sut");
    expect(agentCall?.params?.to).toBe("room:!parent:example");
    expect(agentCall?.params?.deliver).toBe(false);
    const registeredRun = firstRegisteredSubagentRun();
    expect(registeredRun?.expectsCompletionMessage).toBe(true);
    expect(registeredRun?.requesterOrigin?.channel).toBe("matrix");
    expect(registeredRun?.requesterOrigin?.accountId).toBe("sut");
    expect(registeredRun?.requesterOrigin?.to).toBe("room:!parent:example");
  });
});
