import type { messagingApi, webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineAccountConfig } from "./types.js";

type ReportChannelRoomJoin =
  typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin;

const { reportJoin, getGroupSummary, createClient } = vi.hoisted(() => {
  const summary = vi.fn<messagingApi.MessagingApiClient["getGroupSummary"]>();
  return {
    reportJoin: vi.fn<ReportChannelRoomJoin>(async () => ({ kind: "posted" })),
    getGroupSummary: summary,
    createClient: vi.fn(function () {
      return { getGroupSummary: summary };
    }),
  };
});

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  reportChannelRoomJoin: reportJoin,
}));
vi.mock("@line/bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@line/bot-sdk")>();
  return {
    ...actual,
    messagingApi: { ...actual.messagingApi, MessagingApiClient: createClient },
  };
});

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;
let resolveLineAccount: typeof import("./accounts.js").resolveLineAccount;

const groupId = `C${"a".repeat(32)}`;
const roomId = `R${"b".repeat(32)}`;
const userId = `U${"c".repeat(32)}`;
const sources = [
  { type: "group", groupId },
  { type: "room", roomId },
] as const;

function joinEvent(source: webhook.Source): webhook.JoinEvent {
  return {
    type: "join",
    source,
    replyToken: "join-reply",
    timestamp: 1_800_000_000_000,
    mode: "active",
    webhookEventId: "join-event",
    deliveryContext: { isRedelivery: false },
  };
}

function createContext(config: LineAccountConfig = {}) {
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main" }, { id: "room-agent" }] },
    bindings: [{ agentId: "room-agent", match: { channel: "line", accountId: "work" } }],
    channels: {
      line: {
        accounts: {
          work: {
            channelAccessToken: "line-work-token",
            channelSecret: "line-work-secret",
            groupPolicy: "allowlist",
            groupAllowFrom: [userId],
            ...config,
          },
        },
      },
    },
  };
  return {
    cfg,
    account: resolveLineAccount({ cfg, accountId: "work" }),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    mediaMaxBytes: 1,
    processMessage: vi.fn(),
  };
}

describe("LINE group join introductions", () => {
  beforeAll(async () => {
    ({ handleLineWebhookEvents } = await import("./bot-handlers.js"));
    ({ resolveLineAccount } = await import("./accounts.js"));
  });

  beforeEach(() => {
    reportJoin.mockClear();
    createClient.mockClear();
    getGroupSummary.mockReset();
    getGroupSummary.mockResolvedValue({ groupId, groupName: "Incident Response" });
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/channel-join-intro-runtime");
    vi.doUnmock("@line/bot-sdk");
    vi.resetModules();
  });

  it.each(sources)(
    "introduces the bot in its joined $type without human sender authorization",
    async (source) => {
      const context = createContext();
      const conversationId = source.type === "group" ? source.groupId : source.roomId;

      await handleLineWebhookEvents([joinEvent(source)], context);

      expect(reportJoin).toHaveBeenCalledTimes(1);
      const params = reportJoin.mock.calls[0]?.[0];
      if (!params) {
        throw new Error("Expected a LINE join introduction");
      }
      expect(params).toMatchObject({
        cfg: context.cfg,
        channel: "line",
        accountId: "work",
        conversationId,
        deliverTo: conversationId,
        roomAllowed: true,
        route: {
          agentId: "room-agent",
          sessionKey: `agent:room-agent:line:group:${conversationId.toLowerCase()}`,
        },
      });
      await expect(params.resolveRoomContext({ messageLimit: 100 })).resolves.toEqual(
        source.type === "group"
          ? { title: "Incident Response", historyUnavailable: true }
          : { historyUnavailable: true },
      );
      if (source.type === "group") {
        expect(getGroupSummary).toHaveBeenCalledWith(groupId);
        expect(createClient).toHaveBeenCalledWith({ channelAccessToken: "line-work-token" });
      } else {
        expect(getGroupSummary).not.toHaveBeenCalled();
      }
      expect(context.processMessage).not.toHaveBeenCalled();
    },
  );

  it("keeps an honest thin snapshot when the group summary request fails", async () => {
    getGroupSummary.mockRejectedValue(new Error("LINE unavailable"));
    // A group nothing has resolved before, so the answer comes from this failed
    // request rather than a name the name cache still remembers.
    await handleLineWebhookEvents(
      [joinEvent({ type: "group", groupId: `C${"d".repeat(32)}` })],
      createContext(),
    );

    const params = reportJoin.mock.calls[0]?.[0];
    if (!params) {
      throw new Error("Expected a LINE join introduction");
    }
    await expect(params.resolveRoomContext({ messageLimit: 100 })).resolves.toEqual({
      historyUnavailable: true,
    });
  });

  it.each([
    { name: "a direct user chat", event: joinEvent({ type: "user", userId }) },
    {
      name: "a human member join",
      event: {
        ...joinEvent(sources[0]),
        type: "memberJoined",
        joined: { members: [{ type: "user", userId }] },
      } satisfies webhook.MemberJoinedEvent,
    },
  ])("does not introduce for $name", async ({ event }) => {
    const context = createContext();
    await handleLineWebhookEvents([event], context);

    expect(reportJoin).not.toHaveBeenCalled();
    expect(getGroupSummary).not.toHaveBeenCalled();
    expect(context.processMessage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "disabled group policy", config: { groupPolicy: "disabled" as const } },
    { name: "a disabled group", config: { groups: { [groupId]: { enabled: false } } } },
    { name: "disabled wildcard groups", config: { groups: { "*": { enabled: false } } } },
    // An allowlist with nobody on it rejects every message from the room, so
    // introducing the bot there would speak in a room it may not act in.
    { name: "an allowlist with nobody on it", config: { groupAllowFrom: [] } },
    {
      name: "a per-group allowlist with nobody on it",
      config: { groups: { [groupId]: { allowFrom: [] } } },
    },
  ])("reports denied admission for $name without reading metadata", async ({ config }) => {
    await handleLineWebhookEvents([joinEvent(sources[0])], createContext(config));

    expect(reportJoin).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: groupId, roomAllowed: false }),
    );
    expect(getGroupSummary).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an open group policy needs no allowlist",
      config: { groupPolicy: "open" as const, groupAllowFrom: [] },
    },
    {
      name: "a per-group allowlist admits the room its account list does not",
      config: { groupAllowFrom: [], groups: { [groupId]: { allowFrom: [userId] } } },
    },
  ])("introduces the bot when $name", async ({ config }) => {
    await handleLineWebhookEvents([joinEvent(sources[0])], createContext(config));

    expect(reportJoin).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: groupId, roomAllowed: true }),
    );
  });
});
