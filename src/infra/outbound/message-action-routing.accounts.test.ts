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
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  return requireRecord(call);
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
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
    it.each([
      {
        name: "uses defaultAccountId override",
        args: {
          cfg: {} as OpenClawConfig,
          defaultAccountId: "ops",
        },
        expectedAccountId: "ops",
      },
      {
        name: "falls back to agent binding account",
        args: {
          cfg: {
            bindings: [
              { agentId: "agent-b", match: { channel: "accountchat", accountId: "account-b" } },
            ],
          } as OpenClawConfig,
          agentId: "agent-b",
        },
        expectedAccountId: "account-b",
      },
      {
        name: "prefers the account bound to the target peer",
        args: {
          cfg: {
            bindings: [
              {
                agentId: "agent-b",
                match: {
                  channel: "accountchat",
                  accountId: "wrong-peer",
                  peer: { kind: "channel", id: "C_OTHER" },
                },
              },
              {
                agentId: "agent-b",
                match: {
                  channel: "accountchat",
                  accountId: "account-peer",
                  peer: { kind: "channel", id: "C_TARGET" },
                },
              },
              {
                agentId: "agent-b",
                match: { channel: "accountchat", accountId: "agent-fallback" },
              },
            ],
          } as OpenClawConfig,
          agentId: "agent-b",
          target: "channel:C_TARGET",
        },
        expectedAccountId: "account-peer",
      },
    ])("$name", async ({ args, expectedAccountId }) => {
      await runMessageAction({
        ...args,
        action: "send",
        params: {
          channel: "accountchat",
          target: "target" in args ? args.target : "channel:123",
          message: "hi",
        },
      });

      expect(handleAction).toHaveBeenCalled();
      const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
        | {
            accountId?: string | null;
            params: Record<string, unknown>;
          }
        | undefined;
      if (!ctx) {
        throw new Error("expected action context");
      }
      expect(ctx.accountId).toBe(expectedAccountId);
      expect(ctx.params.accountId).toBe(expectedAccountId);
    });

    it("allows an explicitly selected configured account", async () => {
      await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "accountchat",
          target: "channel:123",
          accountId: "Ops",
          message: "hi",
        },
      });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(readFirstPluginCall(handleAction).accountId).toBe("ops");
    });

    it("leaves an omitted account absent when delegating an action to the Gateway", async () => {
      setTestPlugin(
        {
          ...accountPlugin,
          config: { ...accountPlugin.config, defaultAccountId: () => "ops" },
          actions: { ...accountPlugin.actions, resolveExecutionMode: () => "gateway" },
        },
        "accountchat",
      );
      mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });
      await runMessageAction({
        cfg: {},
        action: "send",
        params: { channel: "accountchat", target: "channel:123", message: "hi" },
        gateway: { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
      });
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
      const rpc = requireRecord(readFirstPluginCall(mocks.callGatewayLeastPrivilege).params);
      expect(rpc.accountId).toBeUndefined();
      expect(requireRecord(rpc.params).accountId).toBeUndefined();
    });

    it.each([false, true])(
      "leaves omitted outbound Gateway account selection remote (dryRun=%s)",
      async (dryRun) => {
        setTestPlugin(
          {
            ...accountPlugin,
            config: { ...accountPlugin.config, defaultAccountId: () => "ops" },
            outbound: { deliveryMode: "gateway" },
          },
          "accountchat",
        );
        const { prepareMessageRoute } = await import("./message-action-routing.js");
        const route = await prepareMessageRoute({
          input: { cfg: {}, action: "send", params: {}, dryRun },
          actionParams: { channel: "accountchat", target: "channel:123", message: "hi" },
        });
        expect(route.accountId).toBeUndefined();
        expect(route.params).not.toHaveProperty("accountId");
      },
    );

    it.each([
      { name: "malformed", accountId: "!!!", error: "Invalid account ID" },
      { name: "unknown", accountId: "missing", error: "Unknown account" },
      { name: "disabled", accountId: "disabled", error: "disabled" },
    ])("rejects an explicitly selected $name account before plugin code", async (testCase) => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          params: {
            channel: "accountchat",
            target: "channel:123",
            accountId: testCase.accountId,
            message: "hi",
          },
        }),
      ).rejects.toThrow(testCase.error);

      expect(handleAction).not.toHaveBeenCalled();
    });

    it("preserves an unlisted host-derived binding account", async () => {
      await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "accountchat",
          target: "channel:123",
          message: "hi",
        },
        defaultAccountId: "binding-alias",
      });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(readFirstPluginCall(handleAction).accountId).toBe("binding-alias");
    });
  });
});
