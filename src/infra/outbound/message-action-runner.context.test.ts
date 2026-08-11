// Covers message-action cross-context policy, markers, and presentation
// decoration behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
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
  it.each([
    {
      name: "a channel id passed as channel",
      actionParams: { channel: "C_TARGET" },
      expectedError: "Unknown channel: c_target",
    },
    {
      name: "targets passed instead of target",
      actionParams: { targets: ["C_TARGET"] },
      expectedError: "Action read requires a target.",
    },
    {
      name: "an empty targets array",
      actionParams: { targets: [] },
      expectedError: "Action read requires a target.",
    },
  ])("rejects read with $name before plugin dispatch", async ({ actionParams, expectedError }) => {
    await expect(
      runMessageAction({
        cfg: workspaceConfig,
        action: "read",
        params: actionParams,
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "C_CURRENT",
          currentChannelProvider: "workspace",
        },
        dryRun: false,
      }),
    ).rejects.toThrow(expectedError);
    expect(handleWorkspaceAction).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "send",
      run: (abortSignal: AbortSignal) =>
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "#C12345678",
            message: "hi",
          },
          abortSignal,
        }),
    },
    {
      name: "broadcast",
      run: (abortSignal: AbortSignal) =>
        runDryAction({
          cfg: workspaceConfig,
          action: "broadcast",
          actionParams: {
            targets: ["channel:C12345678"],
            channel: "workspace",
            message: "hi",
          },
          abortSignal,
        }),
    },
  ])("aborts $name when abortSignal is already aborted", async ({ run }) => {
    const controller = new AbortController();
    controller.abort();
    let rejection: unknown;
    try {
      await run(controller.signal);
    } catch (error) {
      rejection = error;
    }
    expect((rejection as { name?: unknown }).name).toBe("AbortError");
  });
});
