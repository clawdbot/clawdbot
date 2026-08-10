// Slack tests cover Enterprise Grid native approval delivery behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

const { slackApprovalNativeRuntime } = await import("./approval-handler.runtime.js");

describe("Slack Enterprise Grid approval delivery", () => {
  beforeEach(() => {
    sendMessageSlackMock.mockReset().mockResolvedValue({
      channelId: "C123",
      messageId: "1712345678.123456",
    });
  });

  it("prepares a qualified target without losing its team", async () => {
    await expect(
      slackApprovalNativeRuntime.transport.prepareTarget({
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: {
            to: "team:T123:channel:C123",
            threadId: "1712345678.000001",
          },
        },
      } as never),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "channel:C123",
        teamId: "T123",
        threadTs: "1712345678.000001",
      },
    });
  });

  it("uses the team client without requiring an Enterprise app id", async () => {
    const chatUpdate = vi.fn().mockResolvedValue({ ok: true });
    const teamClient = {
      chat: { update: chatUpdate },
      conversations: { open: vi.fn() },
    };
    const resolveClient = vi.fn().mockReturnValue(teamClient);
    const context = {
      app: { client: { chat: { update: vi.fn() } } },
      config: {},
      enterprise: { enterpriseId: "E123" },
      resolveClient,
    };

    const entry = await slackApprovalNativeRuntime.transport.deliverPending({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      },
      accountId: "default",
      context,
      preparedTarget: {
        to: "channel:C123",
        teamId: "T123",
      },
      pendingPayload: { text: "approve", blocks: [] },
    } as never);

    expect(entry).toEqual({
      channelId: "C123",
      messageTs: "1712345678.123456",
      teamId: "T123",
    });
    expect(resolveClient).toHaveBeenCalledWith("T123");
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "channel:C123",
      "approve",
      expect.objectContaining({
        client: teamClient,
        eventScope: {
          teamId: "T123",
          client: teamClient,
        },
      }),
    );

    await slackApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context,
      entry,
      payload: { text: "approved", blocks: [] },
      phase: "resolved",
    } as never);

    expect(resolveClient).toHaveBeenLastCalledWith("T123");
    expect(chatUpdate).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1712345678.123456",
      text: "approved",
      blocks: [],
    });
  });

  it.each([
    ["missing", undefined],
    ["unusable", () => undefined],
  ])("fails closed when the workspace client resolver is %s", async (_name, resolveClient) => {
    await expect(
      slackApprovalNativeRuntime.transport.deliverPending({
        cfg: {} as never,
        accountId: "default",
        context: {
          app: { client: {} },
          config: {},
          enterprise: { enterpriseId: "E123" },
          ...(resolveClient ? { resolveClient } : {}),
        },
        preparedTarget: {
          to: "channel:C123",
          teamId: "T123",
        },
        pendingPayload: { text: "approve", blocks: [] },
      } as never),
    ).rejects.toThrow("Slack Enterprise Grid approval client is unavailable");
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
  });

  it("opens an approver DM with the same team client", async () => {
    const open = vi.fn().mockResolvedValue({ channel: { id: "D123" } });
    const teamClient = {
      chat: { update: vi.fn() },
      conversations: { open },
    };

    await slackApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        app: { client: {} },
        config: {},
        enterprise: { enterpriseId: "E123" },
        resolveClient: () => teamClient,
      },
      preparedTarget: {
        to: "user:U123",
        teamId: "T123",
      },
      pendingPayload: { text: "approve", blocks: [] },
    } as never);

    expect(open).toHaveBeenCalledWith({ users: "U123", return_im: true });
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "channel:D123",
      "approve",
      expect.objectContaining({
        eventScope: expect.objectContaining({ teamId: "T123" }),
      }),
    );
  });
});
