// Covers message-action cross-context policy, markers, and presentation
// decoration behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  directChatConfig,
  directChatTestPlugin,
  directOutbound,
  forumTestPlugin,
  runDryAction,
  runDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-test-fixtures.js";

const handleWorkspaceAction = vi.fn(async (_ctx: ChannelMessageActionContext) =>
  jsonResult({ ok: true }),
);

const readWorkspaceTestPlugin: ChannelPlugin = {
  ...workspaceTestPlugin,
  actions: {
    describeMessageTool: () => ({ actions: ["read"] }),
    handleAction: handleWorkspaceAction,
  },
};

const localChatTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "localchat",
    label: "Local Chat",
    docsPath: "/channels/localchat",
    capabilities: { chatTypes: ["direct", "group"], media: true },
  }),
  meta: {
    id: "localchat",
    label: "Local Chat",
    selectionLabel: "Local Chat (local)",
    docsPath: "/channels/localchat",
    blurb: "Local chat test stub.",
    aliases: ["local"],
  },
  outbound: directOutbound,
  messaging: {
    normalizeTarget: (raw) => raw.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => raw.trim().length > 0,
      hint: "<handle|chat_id:ID>",
    },
  },
};

const resolvedDmTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "slackdm",
    label: "Resolved DM",
    capabilities: { chatTypes: ["direct"], media: true },
  }),
  outbound: directOutbound,
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return undefined;
      }
      const userId = trimmed.replace(/^user:/i, "");
      return /^user:/i.test(trimmed)
        ? `user:${userId.toLowerCase()}`
        : `channel:${trimmed.toLowerCase()}`;
    },
    targetResolver: {
      looksLikeId: (raw) => /^(?:user:)?[UW][A-Z0-9]+$/i.test(raw.trim()),
      hint: "<user:ID>",
      resolveTarget: async ({ input }) => {
        const userId = input.trim().replace(/^user:/i, "");
        return /^[UW][A-Z0-9]+$/i.test(userId)
          ? { to: userId, kind: "user", source: "normalized" }
          : null;
      },
    },
  },
  threading: {
    matchesToolContextTarget: ({ target, toolContext }) =>
      target.toLowerCase() ===
      toolContext.currentMessagingTarget?.replace(/^user:/i, "").toLowerCase(),
  },
};

describe("runMessageAction context isolation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: readWorkspaceTestPlugin,
        },
        {
          pluginId: "directchat",
          source: "test",
          plugin: directChatTestPlugin,
        },
        {
          pluginId: "forum",
          source: "test",
          plugin: forumTestPlugin,
        },
        {
          pluginId: "localchat",
          source: "test",
          plugin: localChatTestPlugin,
        },
        {
          pluginId: "slackdm",
          source: "test",
          plugin: resolvedDmTestPlugin,
        },
      ]),
    );
    handleWorkspaceAction.mockClear();
  });
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

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
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
    await expect(
      runMessageAction({
        cfg: workspaceConfig,
        action: "channel-info",
        params: {
          channel: "workspace",
          channelId: "U12345678",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: true,
      }),
    ).rejects.toThrow('Channel id "U12345678" resolved to a user target.');
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
