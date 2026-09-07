// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createActionHubPluginFixture,
  createGatewayActionPlugin,
  createPollForwardingPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const requireRecord = createRequireRecord("record", "expected-non-array-record");
const requireLabeledRecord = createRequireRecord("record", "expected-label");

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readPluginCall(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readLastPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return readPluginCall(mock, mock.mock.calls.length - 1);
}

function readMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const value = mockCall?.[argIndex];
  return requireLabeledRecord(value, label);
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  return requireLabeledRecord(value, label);
}

function expectRecordFields(
  record: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(value);
  }
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    const { handleAction, plugin: actionHubPlugin } = createActionHubPluginFixture();

    beforeEach(() => {
      setTestPlugin(actionHubPlugin, "actionhub");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });
    it("dispatches messageId/chatId-based plugin actions through the shared runner", async () => {
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "unused-agent-runtime-token");
      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "pin",
        params: {
          channel: "actionhub",
          messageId: "om_123",
        },
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "gateway-client",
          mode: "backend",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "list-pins",
        params: {
          channel: "actionhub",
          chatId: "oc_123",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      const pinCall = readPluginCall(handleAction, 0);
      expectRecordFields(
        pinCall,
        { action: "pin", conversationReadOrigin: "direct-operator" },
        "pin call",
      );
      expectRecordFields(
        readRecordField(pinCall, "params", "pin call params"),
        { messageId: "om_123" },
        "pin call params",
      );
      const listPinsCall = readPluginCall(handleAction, 1);
      expectRecordFields(listPinsCall, { action: "list-pins" }, "list pins call");
      expectRecordFields(
        readRecordField(listPinsCall, "params", "list pins call params"),
        { chatId: "oc_123" },
        "list pins call params",
      );
      expect(resolveAgentRuntimeIdentityToken).not.toHaveBeenCalled();
    });

    it("preserves canonical thread and edit fields through plugin dispatch", async () => {
      const cfg = {
        channels: {
          actionhub: {
            enabled: true,
          },
        },
      } as OpenClawConfig;

      await runMessageAction({
        cfg,
        action: "thread-create",
        params: {
          channel: "actionhub",
          target: "actionhub:room",
          threadName: "Canonical thread",
        },
        dryRun: false,
      });
      await runMessageAction({
        cfg,
        action: "thread-reply",
        params: {
          channel: "actionhub",
          target: "actionhub:room/thread-1",
          message: "Canonical reply",
        },
        dryRun: false,
      });
      await runMessageAction({
        cfg,
        action: "edit",
        params: {
          channel: "actionhub",
          target: "actionhub:room/thread-1",
          messageId: "om_123",
          message: "Canonical edit",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      expectRecordFields(
        readRecordField(readPluginCall(handleAction, 0), "params", "thread-create params"),
        {
          target: "actionhub:room",
          to: "actionhub:room",
          threadName: "Canonical thread",
        },
        "thread-create params",
      );
      expectRecordFields(
        readRecordField(readPluginCall(handleAction, 1), "params", "thread-reply params"),
        {
          target: "actionhub:room/thread-1",
          to: "actionhub:room/thread-1",
          message: "Canonical reply",
        },
        "thread-reply params",
      );
      expectRecordFields(
        readRecordField(readPluginCall(handleAction, 2), "params", "edit params"),
        {
          target: "actionhub:room/thread-1",
          to: "actionhub:room/thread-1",
          messageId: "om_123",
          message: "Canonical edit",
        },
        "edit params",
      );
    });

    it("routes execution context ids into plugin handleAction", async () => {
      const stateDir = path.join("/tmp", "openclaw-plugin-dispatch-media-roots");
      const expectedWorkspaceRoot = path.resolve(stateDir, "workspace-alpha");

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await runMessageAction({
          cfg: {
            channels: {
              actionhub: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "pin",
          params: {
            channel: "actionhub",
            messageId: "om_123",
          },
          defaultAccountId: "ops",
          requesterAccountId: "ops",
          requesterSenderId: "trusted-user",
          conversationReadOrigin: "direct-operator",
          sessionKey: "agent:alpha:main",
          sessionId: "session-123",
          agentId: "alpha",
          inboundEventKind: "room_event",
          toolContext: {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          dryRun: false,
        });

        const call = readLastPluginCall(handleAction);
        expectRecordFields(
          call,
          {
            action: "pin",
            accountId: "ops",
            requesterAccountId: "ops",
            requesterSenderId: "trusted-user",
            conversationReadOrigin: "direct-operator",
            sessionKey: "agent:alpha:main",
            sessionId: "session-123",
            inboundEventKind: "room_event",
            agentId: "alpha",
          },
          "plugin action call",
        );
        expect(Array.isArray(call.mediaLocalRoots)).toBe(true);
        expect((call.mediaLocalRoots as unknown[]).includes(expectedWorkspaceRoot)).toBe(true);
        expectRecordFields(
          readRecordField(call, "toolContext", "plugin tool context"),
          {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          "plugin tool context",
        );
      });
    });
  });
  describe("threaded plugin actions", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({ ok: true, params }),
    );
    const cfg = { channels: { forumchat: { enabled: true } } } as OpenClawConfig;
    const threading: ChannelPlugin["threading"] = {
      resolveAutoThreadId: ({ toolContext, to }) =>
        toolContext?.currentChannelId === to ? toolContext.currentThreadTs : undefined,
    };
    const createThreadedPlugin = (executionMode: "local" | "gateway") =>
      createGatewayActionPlugin({
        pluginId: "forumchat",
        label: "Forum Chat",
        blurb: "Forum chat threaded action dispatch test plugin.",
        actions: ["sticker", "download-file"],
        gatewayActions: executionMode === "gateway" ? ["sticker", "download-file"] : [],
        capabilities: { chatTypes: ["channel"] },
        threading,
        handleAction,
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
      });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it.each(["local", "gateway"] as const)(
      "applies auto threadId before %s plugin dispatch",
      async (executionMode) => {
        setTestPlugin(createThreadedPlugin(executionMode), "forumchat");
        mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });

        await runMessageAction({
          cfg,
          action: "sticker",
          params: {
            channel: "forumchat",
            target: "forum:123",
            stickerName: "wave",
          },
          toolContext: {
            currentChannelProvider: "forumchat",
            currentChannelId: "forum:123",
            currentThreadTs: "42",
          },
          gateway: executionMode === "gateway" ? { clientName: "cli", mode: "cli" } : undefined,
          dryRun: false,
        });

        const dispatchedParams =
          executionMode === "gateway"
            ? readRecordField(
                readRecordField(
                  readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call"),
                  "params",
                  "gateway call params",
                ),
                "params",
                "gateway action params",
              )
            : readRecordField(readFirstPluginCall(handleAction), "params", "plugin params");
        expectRecordFields(
          dispatchedParams,
          { to: "forum:123", threadId: "42" },
          `${executionMode} action params`,
        );
        expect(handleAction).toHaveBeenCalledTimes(executionMode === "local" ? 1 : 0);
      },
    );

    it.each(["local", "gateway"] as const)(
      "does not add an implicit thread scope to download-file before %s dispatch",
      async (executionMode) => {
        setTestPlugin(createThreadedPlugin(executionMode), "forumchat");
        mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });

        await runMessageAction({
          cfg,
          action: "download-file",
          conversationReadOrigin: "direct-operator",
          params: {
            channel: "forumchat",
            channelId: "forum:123",
            fileId: "F123",
          },
          toolContext: {
            currentChannelProvider: "forumchat",
            currentChannelId: "forum:123",
            currentThreadTs: "42",
          },
          gateway: executionMode === "gateway" ? { clientName: "cli", mode: "cli" } : undefined,
          dryRun: false,
        });

        const dispatchedParams =
          executionMode === "gateway"
            ? readRecordField(
                readRecordField(
                  readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call"),
                  "params",
                  "gateway call params",
                ),
                "params",
                "gateway action params",
              )
            : readRecordField(readFirstPluginCall(handleAction), "params", "plugin params");
        expect(dispatchedParams.threadId).toBeUndefined();
        expectRecordFields(
          dispatchedParams,
          { channelId: "forum:123", fileId: "F123" },
          `${executionMode} download-file params`,
        );
      },
    );

    it("preserves an explicit download-file thread scope", async () => {
      setTestPlugin(createThreadedPlugin("local"), "forumchat");

      await runMessageAction({
        cfg,
        action: "download-file",
        conversationReadOrigin: "direct-operator",
        params: {
          channel: "forumchat",
          channelId: "forum:123",
          fileId: "F123",
          threadId: "99",
        },
        toolContext: {
          currentChannelProvider: "forumchat",
          currentChannelId: "forum:123",
          currentThreadTs: "42",
        },
        dryRun: false,
      });

      expectRecordFields(
        readRecordField(readFirstPluginCall(handleAction), "params", "plugin params"),
        { channelId: "forum:123", fileId: "F123", threadId: "99" },
        "local download-file params",
      );
    });
  });
  describe("poll plugin forwarding", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        forwarded: {
          to: params.to ?? null,
          pollQuestion: params.pollQuestion ?? null,
          pollOption: params.pollOption ?? null,
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollPublic: params.pollPublic ?? null,
          threadId: params.threadId ?? null,
        },
      }),
    );

    const pollChatPlugin = createPollForwardingPlugin({
      pluginId: "pollchat",
      label: "Poll Chat",
      blurb: "Poll chat forwarding test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setTestPlugin(pollChatPlugin, "pollchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it("forwards poll params through plugin dispatch", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            pollchat: {
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "pollchat",
          target: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        dryRun: false,
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      const pluginCall = readFirstPluginCall(handleAction);
      expectRecordFields(
        pluginCall,
        {
          action: "poll",
          channel: "pollchat",
        },
        "plugin call",
      );
      expectRecordFields(
        readRecordField(pluginCall, "params", "plugin params"),
        {
          to: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        "plugin params",
      );
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          forwarded: {
            to: "pollchat:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationSeconds: 120,
            pollPublic: true,
            threadId: "42",
          },
        },
        "result payload",
      );
    });
  });
  describe("plugin-owned poll semantics", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        forwarded: {
          to: params.to ?? null,
          pollQuestion: params.pollQuestion ?? null,
          pollOption: params.pollOption ?? null,
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollPublic: params.pollPublic ?? null,
        },
      }),
    );

    const guildPollPlugin = createPollForwardingPlugin({
      pluginId: "guildchat",
      label: "Guild Chat",
      blurb: "Guild chat plugin-owned poll test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setTestPlugin(guildPollPlugin, "guildchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("lets other plugins own extra poll fields", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            guildchat: {
              token: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "guildchat",
          target: "channel:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
        },
        dryRun: false,
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      const pluginCall = readFirstPluginCall(handleAction);
      expectRecordFields(
        pluginCall,
        {
          action: "poll",
          channel: "guildchat",
        },
        "plugin call",
      );
      expectRecordFields(
        readRecordField(pluginCall, "params", "plugin params"),
        {
          to: "channel:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
        },
        "plugin params",
      );
    });
  });

  describe("privileged plugin action final-effect authority revalidation", () => {
    // A privileged plugin mutation (e.g. Feishu chat/membership changes)
    // authorizes once at handler entry, then awaits client/runtime preparation
    // before provider I/O. The closure-bound `revalidateRuntimeAuthority` guard
    // must traverse the normal local message-tool route — `runMessageAction` →
    // `executeMessagePlugin` → `dispatchChannelMessageAction` → `handleAction` —
    // so a delegated turn revoked during that interval cannot reach the provider.
    const mutationMock = vi.fn();
    const handleAction = vi.fn(async (ctx: { revalidateRuntimeAuthority?: () => void }) => {
      // Mimic the Feishu handler shape: await preparation, then revalidate at
      // the final-effect boundary, then issue the provider mutation.
      await Promise.resolve();
      ctx.revalidateRuntimeAuthority?.();
      mutationMock();
      return jsonResult({ ok: true });
    });
    const plugin = createGatewayActionPlugin({
      pluginId: "privileged",
      label: "Privileged",
      blurb: "Privileged action dispatch test plugin.",
      actions: ["channel-create"],
      messaging: {
        targetPrefixes: ["privileged"],
        normalizeTarget: (raw) => raw,
        targetResolver: {
          looksLikeId: () => true,
        },
      },
      handleAction: handleAction as unknown as Parameters<
        typeof createGatewayActionPlugin
      >[0]["handleAction"],
    });

    beforeEach(() => {
      setTestPlugin(plugin, "privileged");
      handleAction.mockClear();
      mutationMock.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    it("forwards revalidateRuntimeAuthority from runMessageAction input to the plugin handler", async () => {
      const guard = vi.fn();
      await runMessageAction({
        cfg: {
          channels: { privileged: { enabled: true } },
        } as OpenClawConfig,
        action: "channel-create",
        params: { channel: "privileged", name: "new" },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
        revalidateRuntimeAuthority: guard,
      });
      // The guard reached the plugin handler and was invoked at the final
      // effect, immediately before the provider mutation.
      expect(guard).toHaveBeenCalledTimes(1);
      expect(mutationMock).toHaveBeenCalledTimes(1);
    });

    it("blocks the provider mutation when authority is revoked after preparation", async () => {
      // Guard throws synchronously when the active delegated authority is gone,
      // simulating a turn revoked during the awaited preparation interval.
      const revoked = (): void => {
        throw new TypeError("agent runtime authority is no longer active");
      };
      await expect(
        runMessageAction({
          cfg: {
            channels: { privileged: { enabled: true } },
          } as OpenClawConfig,
          action: "channel-create",
          params: { channel: "privileged", name: "new" },
          conversationReadOrigin: "direct-operator",
          dryRun: false,
          revalidateRuntimeAuthority: revoked,
        }),
      ).rejects.toThrow("agent runtime authority is no longer active");
      // Preparation ran (handleAction was entered), but the mutation never did.
      expect(handleAction).toHaveBeenCalledTimes(1);
      expect(mutationMock).not.toHaveBeenCalled();
    });
  });
});
