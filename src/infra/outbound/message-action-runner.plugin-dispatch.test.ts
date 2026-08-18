// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createAlwaysConfiguredPluginConfig,
  createActionHubPluginFixture,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";
import type { MessageSendResult } from "./message.js";

const requireLabeledRecord = createRequireRecord("record", "expected-label");

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
    it("rejects unsupported read actions before conversation authorization", async () => {
      await expect(
        runMessageAction({
          cfg: {
            channels: {
              actionhub: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "react",
          params: {
            channel: "actionhub",
            target: "other-conversation",
            messageId: "om_123",
            emoji: "eyes",
          },
          conversationReadOrigin: "delegated",
          dryRun: false,
        }),
      ).rejects.toThrow("Message action react not supported for channel actionhub.");
      expect(handleAction).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "rejects an external exact-current alias with the wrong account before target resolution (dryRun=%s)",
      async (dryRun) => {
        const looksLikeId = vi.fn(() => true);
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "actionhub",
              source: "test",
              origin: "config",
              plugin: {
                ...actionHubPlugin,
                messaging: {
                  ...actionHubPlugin.messaging,
                  targetResolver: {
                    looksLikeId,
                  },
                },
              },
            },
          ]),
        );

        await expect(
          runMessageAction({
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
              target: "room:current",
              messageId: "om_123",
            },
            defaultAccountId: "other",
            requesterAccountId: "default",
            conversationReadOrigin: "delegated",
            toolContext: {
              currentChannelId: "actionhub:current",
              currentChannelProvider: "actionhub",
              currentChatType: "group",
            },
            dryRun,
          }),
        ).rejects.toThrow("requires the exact current conversation and account");
        expect(looksLikeId).not.toHaveBeenCalled();
        expect(handleAction).not.toHaveBeenCalled();
      },
    );

    it("rejects directory-only external aliases before resolver or plugin code", async () => {
      const looksLikeId = vi.fn(() => false);
      const resolveTarget = vi.fn(async () => ({
        to: "actionhub:current",
        kind: "group" as const,
      }));
      const listGroups = vi.fn(async () => [
        { kind: "group" as const, id: "actionhub:current", name: "current-room" },
      ]);
      const listGroupsLive = vi.fn(async () => [
        { kind: "group" as const, id: "actionhub:current", name: "current-room" },
      ]);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "actionhub",
            source: "test",
            origin: "config",
            plugin: {
              ...actionHubPlugin,
              messaging: {
                ...actionHubPlugin.messaging,
                targetResolver: { looksLikeId, resolveTarget },
              },
              directory: { listGroups, listGroupsLive },
            },
          },
        ]),
      );

      await expect(
        runMessageAction({
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
            target: "current-room",
            messageId: "om_123",
          },
          defaultAccountId: "default",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelId: "actionhub:current",
            currentChannelProvider: "actionhub",
            currentChatType: "group",
          },
          dryRun: false,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");

      expect(looksLikeId).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(listGroups).not.toHaveBeenCalled();
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("rejects unauthorized gateway-mode dry runs without resolving a target", async () => {
      const looksLikeId = vi.fn(() => true);
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat dry-run authorization test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        messaging: {
          targetResolver: {
            looksLikeId,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            origin: "config",
            plugin: gatewayPlugin,
          },
        ]),
      );

      await expect(
        runMessageAction({
          cfg: {
            channels: {
              gatewaychat: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "react",
          params: {
            channel: "gatewaychat",
            target: "room:current",
            messageId: "message-1",
            emoji: "eyes",
          },
          defaultAccountId: "other",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelId: "gatewaychat:current",
            currentChannelProvider: "gatewaychat",
            currentChatType: "group",
          },
          gateway: {
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: true,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(looksLikeId).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("preserves gateway send receipts in broadcast results", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-broadcast-1",
      });

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: true,
              payload: {
                ok: true,
                messageId: "gw-broadcast-1",
              },
            },
          ],
        },
      });
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });

    it.each<{
      name: string;
      delivery: Partial<MessageSendResult>;
      outcome: { ok: boolean; error?: string; sentBeforeError?: true };
    }>([
      {
        name: "sent",
        delivery: { deliveryStatus: "sent" },
        outcome: { ok: true },
      },
      {
        name: "suppressed",
        delivery: {
          deliveryStatus: "suppressed",
          suppressionReason: "cancelled_by_message_sending_hook",
        },
        outcome: {
          ok: false,
          error: "Broadcast send suppressed: cancelled_by_message_sending_hook.",
        },
      },
      {
        name: "failed",
        delivery: {
          deliveryStatus: "failed",
          error: "provider rejected the message",
        },
        outcome: { ok: false, error: "provider rejected the message" },
      },
      {
        name: "failed without an error",
        delivery: { deliveryStatus: "failed" },
        outcome: { ok: false, error: "Broadcast send failed." },
      },
      {
        name: "partial_failed",
        delivery: {
          deliveryStatus: "partial_failed",
          error: "second payload failed",
          sentBeforeError: true,
        },
        outcome: { ok: false, error: "second payload failed", sentBeforeError: true },
      },
      {
        name: "partial_failed without an error",
        delivery: { deliveryStatus: "partial_failed", sentBeforeError: true },
        outcome: {
          ok: false,
          error: "Broadcast send partially failed.",
          sentBeforeError: true,
        },
      },
      {
        name: "legacy result without deliveryStatus",
        delivery: {
          via: "gateway",
          result: { messageId: "legacy-message-1" },
        },
        outcome: { ok: true },
      },
    ])("derives broadcast truth from a $name send result", async ({ delivery, outcome }) => {
      const nestedPayload = { ok: true, nested: "payload" };
      const sendResult = {
        channel: "gatewaychat",
        to: "user-123",
        via: "direct",
        mediaUrl: null,
        ...delivery,
      } satisfies MessageSendResult;
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat delivery truth test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.executeSendAction.mockResolvedValue({
        handledBy: "core",
        payload: nestedPayload,
        sendResult,
      });

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
      });

      expect(result.kind).toBe("broadcast");
      if (result.kind !== "broadcast") {
        throw new Error("expected broadcast result");
      }
      expect(result.payload.results).toEqual([
        {
          channel: "gatewaychat",
          to: "user-123",
          ...outcome,
          payload: nestedPayload,
          result: sendResult,
        },
      ]);
      expect(result.payload.results[0]?.payload).toBe(nestedPayload);
      expect(result.payload.results[0]?.result).toBe(sendResult);
    });

    it("preserves partial-delivery evidence from failed broadcast sends", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat partial broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockRejectedValue(
        Object.assign(new Error("second payload failed"), { sentBeforeError: true }),
      );

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: false,
              sentBeforeError: true,
              error: "second payload failed",
            },
          ],
        },
      });
    });
  });
  describe("presentation parsing", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        presentation: params.presentation ?? null,
      }),
    );

    const componentsPlugin: ChannelPlugin = {
      id: "componentchat",
      meta: {
        id: "componentchat",
        label: "Component Chat",
        selectionLabel: "Component Chat",
        docsPath: "/channels/componentchat",
        blurb: "Component chat send test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig({}),
      actions: {
        describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(componentsPlugin, "componentchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("parses presentation JSON strings before plugin dispatch", async () => {
      const presentation = {
        blocks: [{ type: "buttons", buttons: [{ label: "A", value: "a" }] }],
      };
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "componentchat",
          target: "channel:123",
          message: "hi",
          presentation: JSON.stringify(presentation),
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(handleAction).toHaveBeenCalled();
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          presentation,
        },
        "result payload",
      );
    });

    it("throws on invalid presentation JSON strings", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          params: {
            channel: "componentchat",
            target: "channel:123",
            message: "hi",
            presentation: "{not-json}",
          },
          dryRun: false,
        }),
      ).rejects.toThrow(/--presentation must be valid JSON/);

      expect(handleAction).not.toHaveBeenCalled();
    });
  });
  describe("accountId defaults", () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const listGroupsLive = vi.fn(async () => [
      { id: "channel:resolved", name: "resolved", kind: "group" as const },
    ]);
    const accountPlugin: ChannelPlugin = {
      id: "accountchat",
      meta: {
        id: "accountchat",
        label: "Account Chat",
        selectionLabel: "Account Chat",
        docsPath: "/channels/accountchat",
        blurb: "Account chat test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default", "ops", "disabled"],
        resolveAccount: (_cfg, accountId) => ({ enabled: accountId !== "disabled" }),
      },
      directory: { listGroupsLive },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(accountPlugin, "accountchat");
      handleAction.mockClear();
      listGroupsLive.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it("rejects an unknown broadcast account before live target resolution", async () => {
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "accountchat",
          targets: ["resolved"],
          accountId: "missing",
          message: "hi",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [{ ok: false, error: expect.stringContaining("Unknown account") }],
        },
      });
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("preserves planned per-channel broadcast rejection without resolving a target", async () => {
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "broadcast",
        params: {
          targets: ["resolved"],
          accountId: "missing",
          message: "hi",
        },
        broadcastAccountPlan: {
          accountId: "missing",
          candidateChannels: ["accountchat"],
          secretChannels: [],
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "accountchat",
              ok: false,
              error: expect.stringContaining("Unknown account"),
            },
          ],
        },
      });
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("rejects an empty broadcast account plan instead of reporting empty success", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "broadcast",
          params: {
            targets: ["resolved"],
            accountId: "missing",
            message: "hi",
          },
          broadcastAccountPlan: {
            accountId: "missing",
            candidateChannels: [],
            secretChannels: [],
          },
        }),
      ).rejects.toThrow("Broadcast requires at least one configured channel");

      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });
  });
});
