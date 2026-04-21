import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  prepareOutboundMirrorRoute,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";

const ensureOutboundSessionEntry = vi.fn(async () => undefined);
const resolveOutboundSessionRoute = vi.fn();

const workspaceConfig = {
  channels: {
    workspace: {
      botToken: "xoxb-test",
    },
  },
} as OpenClawConfig;

const forumConfig = {
  channels: {
    forum: {
      botToken: "forum-test",
    },
  },
} as OpenClawConfig;

const defaultForumToolContext = {
  currentChannelId: "forum:123",
  currentThreadTs: "42",
} as const;

describe("message action threading helpers", () => {
  beforeEach(() => {
    ensureOutboundSessionEntry.mockClear();
    resolveOutboundSessionRoute.mockReset();
  });

  it.each([
    {
      name: "exact channel id",
      target: "channel:C123",
      threadTs: "111.222",
      expectedSessionKey: "agent:main:workspace:channel:c123:thread:111.222",
    },
    {
      name: "case-insensitive channel id",
      target: "channel:c123",
      threadTs: "333.444",
      expectedSessionKey: "agent:main:workspace:channel:c123:thread:333.444",
    },
  ] as const)("prepares outbound routes for workspace using $name", async (testCase) => {
    const actionParams: Record<string, unknown> = {
      channel: "workspace",
      target: testCase.target,
      message: "hi",
    };
    resolveOutboundSessionRoute.mockResolvedValue({
      sessionKey: testCase.expectedSessionKey,
      baseSessionKey: "base",
      peer: { id: "peer", kind: "channel" },
      chatType: "channel",
      from: "from",
      to: testCase.target,
      threadId: testCase.threadTs,
    });

    const result = await prepareOutboundMirrorRoute({
      cfg: workspaceConfig,
      channel: "workspace",
      to: testCase.target,
      actionParams,
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: testCase.threadTs,
        replyToMode: "all",
      },
      agentId: "main",
      resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs,
      resolveOutboundSessionRoute,
      ensureOutboundSessionEntry,
    });

    expect(result.outboundRoute?.sessionKey).toBe(testCase.expectedSessionKey);
    expect(actionParams.__sessionKey).toBe(testCase.expectedSessionKey);
    expect(actionParams.__agentId).toBe("main");
    expect(ensureOutboundSessionEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "injects threadId for matching target",
      target: "forum:123",
      expectedThreadId: "42",
    },
    {
      name: "injects threadId for prefixed group target",
      target: "forum:group:123",
      expectedThreadId: "42",
    },
    {
      name: "skips threadId when target chat differs",
      target: "forum:999",
      expectedThreadId: undefined,
    },
  ] as const)("forum auto-threading: $name", (testCase) => {
    const actionParams: Record<string, unknown> = {
      channel: "forum",
      target: testCase.target,
      message: "hi",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: forumConfig,
      to: testCase.target,
      toolContext: defaultForumToolContext,
      resolveAutoThreadId: ({ to, toolContext }) =>
        to.includes("123") ? toolContext?.currentThreadTs : undefined,
    });

    expect(actionParams.threadId).toBe(testCase.expectedThreadId);
    expect(resolved).toBe(testCase.expectedThreadId);
  });

  it("uses explicit forum threadId when provided", () => {
    const actionParams: Record<string, unknown> = {
      channel: "forum",
      target: "forum:123",
      message: "hi",
      threadId: "999",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: forumConfig,
      to: "forum:123",
      toolContext: defaultForumToolContext,
      resolveAutoThreadId: () => "42",
    });

    expect(actionParams.threadId).toBe("999");
    expect(resolved).toBe("999");
  });

  it("passes explicit replyTo into auto-thread resolution", () => {
    const resolveAutoThreadId = vi.fn(() => "thread-777");
    const actionParams: Record<string, unknown> = {
      channel: "forum",
      target: "forum:123",
      message: "hi",
      replyTo: "777",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: forumConfig,
      to: "forum:123",
      toolContext: defaultForumToolContext,
      resolveAutoThreadId,
    });

    expect(resolveAutoThreadId).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "777",
      }),
    );
    expect(resolved).toBe("thread-777");
    expect(actionParams.threadId).toBe("thread-777");
  });
});
