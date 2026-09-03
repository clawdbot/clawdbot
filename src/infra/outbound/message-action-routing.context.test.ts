// Covers message-action cross-context policy, markers, and presentation
// decoration behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  createMessageActionContextFixture,
  directChatConfig,
  runDryAction,
  runDrySend,
  workspaceConfig,
} from "./message-action-runner.test-support.js";

const contextFixture = createMessageActionContextFixture();
const { handleWorkspaceAction } = contextFixture;

describe("runMessageAction context isolation", () => {
  beforeEach(() => contextFixture.setup());
  afterEach(() => contextFixture.cleanup());
  it("uses the current conversation for an implicit read", async () => {
    await runMessageAction({
      cfg: workspaceConfig,
      action: "read",
      params: {},
      defaultAccountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelId: "C12345678",
        currentChannelProvider: "workspace",
      },
      dryRun: false,
    });

    expect(handleWorkspaceAction).toHaveBeenCalledOnce();
    expect(handleWorkspaceAction.mock.calls[0]?.[0]).toMatchObject({
      action: "read",
      params: {
        channel: "workspace",
        target: "C12345678",
        to: "C12345678",
      },
    });
  });

  it.each([
    {
      name: "allows send when target matches current channel",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "accepts legacy to parameter for send",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        to: "#C12345678",
        message: "hi",
      },
    },
    {
      name: "defaults to current channel when target is omitted",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "allows media-only send when target matches current channel",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        media: "https://example.com/note.ogg",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "allows send when poll booleans are explicitly false",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollMulti: false,
        pollAnonymous: false,
        pollPublic: false,
      },
      toolContext: { currentChannelId: "C12345678" },
    },
  ])("$name", async ({ cfg, actionParams, toolContext }) => {
    const result = await runDrySend({
      cfg,
      actionParams,
      ...(toolContext ? { toolContext } : {}),
    });

    expect(result.kind).toBe("send");
  });

  it("allows the active DM after target resolution strips its user prefix", async () => {
    const result = await runDrySend({
      cfg: {
        channels: { slackdm: {} },
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "slackdm",
        target: "user:U123",
        message: "hi",
      },
      toolContext: {
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        currentChannelProvider: "slackdm",
      },
    });

    expect(result).toMatchObject({ kind: "send", to: "U123" });
  });

  it.each([
    {
      name: "send when target differs from current workspace channel",
      run: () =>
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "channel:C99999999",
            message: "hi",
          },
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
        }),
      expectedKind: "send",
    },
    {
      name: "thread-reply when channelId differs from current workspace channel",
      run: () =>
        runDryAction({
          cfg: workspaceConfig,
          action: "thread-reply",
          actionParams: {
            channel: "workspace",
            target: "C99999999",
            message: "hi",
          },
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
        }),
      expectedKind: "action",
    },
  ])("blocks cross-context UI handoff for $name", async ({ run, expectedKind }) => {
    const result = await run();
    expect(result.kind).toBe(expectedKind);
  });

  it.each([
    {
      name: "direct chat match",
      channel: "directchat",
      target: "123@g.us",
      currentChannelId: "123@g.us",
    },
    {
      name: "local chat match",
      channel: "localchat",
      target: "localchat:+15551234567",
      currentChannelId: "localchat:+15551234567",
    },
    {
      name: "direct chat mismatch",
      channel: "directchat",
      target: "456@g.us",
      currentChannelId: "123@g.us",
      currentChannelProvider: "directchat",
    },
    {
      name: "local chat mismatch",
      channel: "localchat",
      target: "localchat:+15551230000",
      currentChannelId: "localchat:+15551234567",
      currentChannelProvider: "localchat",
    },
  ] as const)("$name", async (testCase) => {
    const result = await runDrySend({
      cfg: directChatConfig,
      actionParams: {
        channel: testCase.channel,
        target: testCase.target,
        message: "hi",
      },
      toolContext: {
        currentChannelId: testCase.currentChannelId,
        ...(testCase.currentChannelProvider
          ? { currentChannelProvider: testCase.currentChannelProvider }
          : {}),
      },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "infers channel + target from tool context when missing",
      cfg: {
        channels: {
          workspace: {
            botToken: "workspace-test",
            appToken: "workspace-app-test",
          },
          forum: {
            token: "forum-test",
          },
        },
      } as OpenClawConfig,
      action: "send" as const,
      actionParams: {
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      expectedKind: "send",
      expectedChannel: "workspace",
    },
    {
      name: "falls back to tool-context provider when channel param is an id",
      cfg: workspaceConfig,
      action: "send" as const,
      actionParams: {
        channel: "C12345678",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      expectedKind: "send",
      expectedChannel: "workspace",
    },
    {
      name: "falls back to tool-context provider for broadcast channel ids",
      cfg: workspaceConfig,
      action: "broadcast" as const,
      actionParams: {
        targets: ["channel:C12345678"],
        channel: "C12345678",
        message: "hi",
      },
      toolContext: { currentChannelProvider: "workspace" },
      expectedKind: "broadcast",
      expectedChannel: "workspace",
    },
  ])("$name", async ({ cfg, action, actionParams, toolContext, expectedKind, expectedChannel }) => {
    const result = await runDryAction({
      cfg,
      action,
      actionParams,
      toolContext,
    });

    expect(result.kind).toBe(expectedKind);
    expect(result.channel).toBe(expectedChannel);
  });

  it.each([
    {
      name: "blocks cross-provider sends by default",
      action: "send" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "forum",
        target: "@opsbot",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks cross-provider message mutations by default",
      action: "edit" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "forum",
        target: "@opsbot",
        messageId: "forum-message-1",
        message: "updated",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks cross-provider delete mutations by default",
      action: "delete" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "forum",
        target: "@opsbot",
        messageId: "forum-message-1",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks cross-provider pin mutations by default",
      action: "pin" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "forum",
        target: "@opsbot",
        messageId: "forum-message-1",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks cross-provider unpin mutations by default",
      action: "unpin" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "forum",
        target: "@opsbot",
        messageId: "forum-message-1",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks same-provider cross-context when disabled",
      action: "send" as const,
      cfg: {
        ...workspaceConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "workspace",
        target: "channel:C99999999",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks same-provider cross-context uploads when disabled",
      action: "upload-file" as const,
      cfg: {
        ...workspaceConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "workspace",
        target: "channel:C99999999",
        filePath: "/tmp/report.png",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks delegated channel reads without current context before target resolution",
      action: "channel-info" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        channelId: "U12345678",
      },
      message: "requires the exact current conversation and account",
    },
    {
      name: "blocks actions outside the per-agent allowlist",
      action: "channel-info" as const,
      cfg: {
        ...workspaceConfig,
        agents: {
          list: [
            {
              id: "sandbox",
              tools: {
                message: {
                  actions: {
                    allow: ["send"],
                  },
                },
              },
            },
          ],
        },
      } as OpenClawConfig,
      agentId: "sandbox",
      actionParams: {
        channel: "workspace",
        channelId: "C12345678",
      },
      message: 'Message action "channel-info" is disabled for this agent.',
    },
  ])("$name", async ({ action, cfg, actionParams, toolContext, message, agentId }) => {
    await expect(
      runDryAction({
        cfg,
        action,
        actionParams,
        toolContext,
        agentId,
      }),
    ).rejects.toThrow(message);
  });

  it("retains direct-operator target-kind validation", async () => {
    const failure = runMessageAction({
      cfg: workspaceConfig,
      action: "channel-info",
      params: {
        channel: "workspace",
        channelId: "U12345678",
      },
      conversationReadOrigin: "direct-operator",
      dryRun: true,
    });
    await expect(failure).rejects.toBeInstanceOf(MessageActionDeniedError);
    await expect(failure).rejects.toMatchObject({
      reasonCode: "message_target_invalid",
      policyRef: "message-target:valid",
    });
    await expect(failure).rejects.toThrow('Channel id "U12345678" resolved to a user target.');
  });

  it("retains direct-operator cross-provider reads", async () => {
    await expect(
      runMessageAction({
        cfg: workspaceConfig,
        action: "read",
        params: {
          channel: "workspace",
          target: "C12345678",
        },
        defaultAccountId: "default",
        conversationReadOrigin: "direct-operator",
        toolContext: {
          currentChannelId: "forum-current",
          currentChannelProvider: "forum",
        },
        dryRun: false,
      }),
    ).resolves.toMatchObject({ kind: "action", channel: "workspace", action: "read" });
    expect(handleWorkspaceAction).toHaveBeenCalledOnce();
  });

  it("retains cross-provider policy for direct operators", async () => {
    await expect(
      runMessageAction({
        cfg: workspaceConfig,
        action: "pin",
        params: {
          channel: "forum",
          target: "@opsbot",
          messageId: "forum-message-1",
        },
        conversationReadOrigin: "direct-operator",
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "workspace",
        },
        dryRun: true,
      }),
    ).rejects.toThrow(/Cross-context messaging denied/);
  });
});
