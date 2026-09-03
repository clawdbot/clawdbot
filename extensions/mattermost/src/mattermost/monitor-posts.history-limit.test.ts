import { describe, expect, it, vi } from "vitest";

const buildEventPlan = vi.hoisted(() => vi.fn());
const recordHistory = vi.hoisted(() => vi.fn());

vi.mock("./monitor-event-plan.js", () => ({ buildMattermostEventPlan: buildEventPlan }));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createChannelHistoryWindow: () => ({ record: recordHistory }),
}));

const { createMattermostPostHandler } = await import("./monitor-posts.js");

describe("Mattermost pending history limit", () => {
  it.each([
    { account: 3, expected: 3 },
    { account: undefined, expected: 7 },
    { account: 0, expected: 0 },
  ])("passes the effective $expected limit into the pending-history owner", async (testCase) => {
    recordHistory.mockClear();
    buildEventPlan.mockResolvedValue({
      channelDisplay: "General",
      kind: "group",
      roomLabel: "general",
      route: { agentId: "main" },
      thread: { sessionKey: "agent:main:mattermost:group:chan-1" },
      finalizeContext: () => {},
    });

    const monitor = {
      account: { accountId: "work", config: { historyLimit: testCase.account } },
      botUserId: "bot",
      botUsername: "bot",
      cfg: { messages: { groupChat: { historyLimit: 7 } } },
      core: {
        channel: {
          activity: { record: () => {} },
          commands: {
            shouldHandleTextCommands: () => false,
            isControlCommandMessage: () => false,
          },
          groups: { resolveRequireMention: () => true },
          mentions: { buildMentionRegexes: () => [], matchesMentionPatterns: () => false },
          pairing: { buildPairingReply: () => undefined },
        },
      },
      groupPolicy: "open",
      pairing: {},
      resources: {
        resolveMattermostMedia: async () => [],
        resolveUserInfo: async () => ({ username: "sender" }),
      },
      logVerboseMessage: () => {},
      logDebugMessage: () => {},
    } as unknown as Parameters<typeof createMattermostPostHandler>[0];

    const handler = createMattermostPostHandler(monitor);
    await handler(
      {
        id: "post-1",
        channel_id: "chan-1",
        user_id: "sender",
        message: "no mention here",
        create_at: 1,
      } as never,
      { data: { sender_name: "sender" } } as never,
    );

    expect(recordHistory.mock.calls[0]?.[0]?.limit).toBe(testCase.expected);
  });
});
