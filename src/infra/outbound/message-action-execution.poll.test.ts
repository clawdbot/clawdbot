import { beforeEach, describe, expect, it, vi } from "vitest";
// Covers message-action poll normalization and direct provider delivery.
import type {
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeMessagePoll } from "./message-action-execution.js";

const pollerConfig = {
  channels: {
    poller: {
      botToken: "poller-test",
    },
  },
} as OpenClawConfig;

type PollerSendPoll = NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendPoll"]>;

const pollerSendPoll = vi.fn<PollerSendPoll>(async () => ({
  messageId: "poll-test",
}));

const pollerTestPlugin: ChannelPlugin = {
  id: "poller",
  meta: {
    id: "poller",
    label: "Poller",
    selectionLabel: "Poller",
    docsPath: "/channels/poller",
    blurb: "Poller test plugin.",
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ botToken: "poller-test" }),
    isConfigured: () => true,
  },
  outbound: {
    deliveryMode: "direct",
    sendPoll: pollerSendPoll,
  },
  messaging: {
    targetResolver: {
      looksLikeId: () => true,
      resolveTarget: async ({ normalized }) => ({
        to: normalized,
        kind: "user",
        source: "normalized",
      }),
    },
  },
  threading: {
    resolveAutoThreadId: ({ toolContext, to, replyToId }) => {
      if (replyToId || toolContext?.currentChannelId !== to) {
        return undefined;
      }
      return toolContext.currentThreadTs;
    },
  },
};

async function runPollAction(params: {
  actionParams: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
}) {
  const target = params.actionParams.target;
  if (typeof target !== "string") {
    throw new Error("poll test target is required");
  }
  const actionParams = { ...params.actionParams, to: target };
  await executeMessagePoll({
    cfg: pollerConfig,
    params: actionParams,
    channel: "poller",
    channelPlugin: pollerTestPlugin,
    mediaAccess: {},
    accountId: "default",
    dryRun: false,
    input: {
      cfg: pollerConfig,
      action: "poll",
      params: actionParams,
      toolContext: params.toolContext,
    },
  });
  const call = pollerSendPoll.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected poller sendPoll call");
  }
  return call;
}

describe("executeMessagePoll", () => {
  beforeEach(() => {
    pollerSendPoll.mockReset();
    pollerSendPoll.mockResolvedValue({ messageId: "poll-test" });
  });

  it("passes normalized poll fields and auto threadId to the provider", async () => {
    const call = await runPollAction({
      actionParams: {
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollDurationHours: 2,
      },
      toolContext: {
        currentChannelId: "poller:123",
        currentThreadTs: "42",
      },
    });

    expect(call.poll).toMatchObject({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      durationHours: 2,
      maxSelections: 1,
    });
    expect(call.threadId).toBe("42");
  });

  it.each([0, -1, 1.5, "1.5", "soon"])(
    "rejects invalid pollDurationHours value %s",
    async (pollDurationHours) => {
      await expect(
        runPollAction({
          actionParams: {
            target: "poller:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationHours,
          },
        }),
      ).rejects.toThrow(/pollDurationHours must be a positive integer/i);
    },
  );

  it("expands maxSelections when pollMulti is enabled", async () => {
    const call = await runPollAction({
      actionParams: {
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
        pollMulti: true,
      },
    });

    expect(call.poll.maxSelections).toBe(3);
  });

  it("defaults maxSelections to one choice when pollMulti is omitted", async () => {
    const call = await runPollAction({
      actionParams: {
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
      },
    });

    expect(call.poll.maxSelections).toBe(1);
  });

  it("requires at least two poll options", async () => {
    await expect(
      runPollAction({
        actionParams: {
          target: "poller:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza"],
        },
      }),
    ).rejects.toThrow(/pollOption requires at least two values/i);
  });
});
