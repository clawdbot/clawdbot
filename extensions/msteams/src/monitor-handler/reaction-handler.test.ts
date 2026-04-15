import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsReactionHandler } from "./reaction-handler.js";

function buildMockRuntime(overrides?: Partial<PluginRuntime>): PluginRuntime {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "test-session",
          agentId: "agent1",
          accountId: "default",
        })),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    ...overrides,
  } as unknown as PluginRuntime;
}

function buildDeps(cfg: OpenClawConfig, _runtime?: PluginRuntime): MSTeamsMessageHandlerDeps {
  return {
    cfg,
    runtime: { error: vi.fn() } as unknown as MSTeamsMessageHandlerDeps["runtime"],
    appId: "test-app",
    adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
    tokenProvider: { getAccessToken: vi.fn(async () => "token") },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore: {
      upsert: vi.fn(async () => undefined),
    } as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };
}

function createReactionTestHarness() {
  const mockRuntime = buildMockRuntime();
  setMSTeamsRuntime(mockRuntime);

  const cfg: OpenClawConfig = {
    channels: { msteams: { allowFrom: ["allowed-aad"] } },
  } as OpenClawConfig;

  const deps = buildDeps(cfg, mockRuntime);
  const handler = createMSTeamsReactionHandler(deps);
  const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;

  return { handler, enqueue };
}

async function invokeReactionEvent(
  handler: ReturnType<typeof createMSTeamsReactionHandler>,
  activity: Record<string, unknown>,
  direction: "added" | "removed",
) {
  await handler(
    {
      activity: {
        type: "messageReaction",
        conversation: { id: "dm-conv", conversationType: "personal" },
        ...activity,
      },
      sendActivity: vi.fn(async () => undefined),
    } as never,
    direction,
  );
}

describe("createMSTeamsReactionHandler", () => {
  describe("emoji mapping", () => {
    it("maps Teams reaction types to unicode emoji in event label", async () => {
      const mockRuntime = buildMockRuntime();
      setMSTeamsRuntime(mockRuntime);

      const cfg: OpenClawConfig = {
        channels: {
          msteams: {
            allowFrom: ["allowed-aad"],
          },
        },
      } as OpenClawConfig;

      const deps = buildDeps(cfg);
      const handler = createMSTeamsReactionHandler(deps);

      await handler(
        {
          activity: {
            type: "messageReaction",
            reactionsAdded: [{ type: "like" }],
            from: { id: "user-id", aadObjectId: "allowed-aad", name: "Alice" },
            conversation: { id: "personal-conv", conversationType: "personal" },
            replyToId: "msg-123",
          },
          sendActivity: vi.fn(async () => undefined),
        } as never,
        "added",
      );

      const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;
      expect(enqueue).toHaveBeenCalledOnce();
      const label: string = enqueue.mock.calls[0][0];
      expect(label).toContain("👍");
      expect(label).toContain("Alice");
      expect(label).toContain("msg-123");
    });

    it("maps heart, laugh, surprised, sad, angry reaction types", async () => {
      const emojiMap: Record<string, string> = {
        heart: "❤️",
        laugh: "😆",
        surprised: "😮",
        sad: "😢",
        angry: "😡",
      };

      for (const [type, expectedEmoji] of Object.entries(emojiMap)) {
        const mockRuntime = buildMockRuntime();
        setMSTeamsRuntime(mockRuntime);

        const cfg: OpenClawConfig = {
          channels: { msteams: { allowFrom: ["allowed-aad"] } },
        } as OpenClawConfig;

        const deps = buildDeps(cfg, mockRuntime);
        const handler = createMSTeamsReactionHandler(deps);

        await handler(
          {
            activity: {
              type: "messageReaction",
              reactionsAdded: [{ type }],
              from: { id: "user-id", aadObjectId: "allowed-aad", name: "Bob" },
              conversation: { id: "dm-conv", conversationType: "personal" },
              replyToId: "msg-456",
            },
            sendActivity: vi.fn(async () => undefined),
          } as never,
          "added",
        );

        const enqueue = mockRuntime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>;
        const label: string = enqueue.mock.calls[0][0];
        expect(label).toContain(expectedEmoji);
      }
    });
  });

  describe("inbound reaction events", () => {
    it("enqueues system event for reactionsAdded", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: { id: "u1", aadObjectId: "allowed-aad", name: "User" },
          replyToId: "msg-1",
        },
        "added",
      );

      expect(enqueue).toHaveBeenCalledOnce();
      const [label, meta] = enqueue.mock.calls[0];
      expect(label).toContain("added");
      expect(meta.sessionKey).toBe("test-session");
      expect(meta.contextKey).toContain("added");
    });

    it("enqueues system event for reactionsRemoved", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsRemoved: [{ type: "heart" }],
          from: { id: "u1", aadObjectId: "allowed-aad", name: "User" },
          replyToId: "msg-2",
        },
        "removed",
      );

      expect(enqueue).toHaveBeenCalledOnce();
      const [label] = enqueue.mock.calls[0];
      expect(label).toContain("removed");
      expect(label).toContain("❤️");
    });

    it("skips when reactions array is empty", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [],
          from: { id: "u1", aadObjectId: "allowed-aad", name: "User" },
          replyToId: "msg-3",
        },
        "added",
      );

      expect(enqueue).not.toHaveBeenCalled();
    });

    it("skips when from.id is missing", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: {},
          replyToId: "msg-4",
        },
        "added",
      );

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe("sender authorization", () => {
    it("drops reaction from non-allowlisted DM sender", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: { id: "bad-user", aadObjectId: "not-allowed", name: "Attacker" },
          replyToId: "msg-5",
        },
        "added",
      );

      expect(enqueue).not.toHaveBeenCalled();
    });

    it("allows reaction from allowlisted DM sender", async () => {
      const { handler, enqueue } = createReactionTestHarness();
      await invokeReactionEvent(
        handler,
        {
          reactionsAdded: [{ type: "like" }],
          from: { id: "good-user", aadObjectId: "allowed-aad", name: "Alice" },
          replyToId: "msg-6",
        },
        "added",
      );

      expect(enqueue).toHaveBeenCalledOnce();
    });
  });
});
