// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createActionHubPluginFixture,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const requireLabeledRecord = createRequireRecord("record", "expected-label");

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
    it("owns terminal source-reply receipts before dispatching to a remote gateway", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat remote source reply test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      mocks.reconcileTerminalSourceReplyDelivery.mockResolvedValue("delivered");
      const deliveredPayload = { ok: true, messageId: "gw-send-1" };
      mocks.callGatewayLeastPrivilege.mockResolvedValue(deliveredPayload);
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => undefined);
      const policySessionKey = "agent:main:gatewaychat:policy:user-123";

      await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "gatewaychat",
          target: "user-123",
          message: "terminal answer",
        },
        messageActionAuthorization: {
          toolContext: {
            currentChannelProvider: "gatewaychat",
            currentChannelId: "user-123",
            currentSourceTurnId: "source-turn-1",
          },
        },
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        sessionKey: policySessionKey,
        sourceReplySessionKey: receipt.sessionKey,
        sessionId: receipt.sessionId,
        agentId: "main",
        gateway: {
          resolveAgentRuntimeIdentityToken,
          terminalSourceReplyReceiptOwner: "caller",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expect(mocks.beginTerminalSourceReplyDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "send",
          channel: "gatewaychat",
          idempotencyKey: "idem-gateway-action",
          sessionId: receipt.sessionId,
          sessionKey: receipt.sessionKey,
          sourceReplyFinal: true,
          toolCallId: receipt.toolCallId,
          toolContext: expect.objectContaining({ currentSourceTurnId: "source-turn-1" }),
        }),
      );
      expect(mocks.beginTerminalSourceReplyDelivery.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.callGatewayLeastPrivilege.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledWith({
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
      });
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith({
        deliveredPayload,
        mirror: expect.objectContaining({
          idempotencyKey: "idem-gateway-action",
          sourceReplyFinal: true,
          toolCallId: "message-call-1",
        }),
        receipt,
      });
    });

    it("allows claimless remote terminal dispatch when no receipt applies", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat missing receipt test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(undefined);
      mocks.reconcileTerminalSourceReplyDelivery.mockResolvedValue("not-applicable");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-send-claimless",
      });

      await runMessageAction({
        cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        gateway: {
          terminalSourceReplyReceiptOwner: "caller",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ receipt: undefined }),
      );
    });

    it("returns an ambiguous terminal outcome without remote provider I/O", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat ambiguous source reply test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue({
        outcome: "delivery_ambiguous",
        result: {
          status: "delivery_ambiguous",
          delivered: false,
          message: "The completed reply may already have been delivered. Do not retry it.",
        },
      });

      const result = await runMessageAction({
        cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        gateway: {
          terminalSourceReplyReceiptOwner: "caller",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expect(result).toMatchObject({
        payload: {
          status: "delivery_ambiguous",
          delivered: false,
        },
      });
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("cancels caller receipts after confirmed gateway request rejection", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat rejected request test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const rejection = Object.assign(new Error("unsupported message action"), {
        name: "GatewayClientRequestError",
        gatewayCode: "FORBIDDEN",
        retryable: false,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
      expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("cancels caller receipts after structured gateway startup rejection", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat startup rejection test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const rejection = Object.assign(new Error("gateway is still starting"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        details: { method: "message.action", reason: "gateway-starting" },
        retryable: true,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
    });

    it("keeps caller receipts pending after unstructured provider unavailability", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat provider failure test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue({
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      });
      const rejection = Object.assign(new Error("provider failed"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        retryable: false,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("keeps caller receipts pending when reattach ends in a confirmed rejection", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat ambiguous reattach rejection test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      const rejection = Object.assign(new Error("gateway is still starting"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        details: { method: "message.action", reason: "gateway-starting" },
        retryable: true,
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockRejectedValueOnce(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
      expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("preserves caller receipts when reattach returns an explicit failure", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat ambiguous reattach result test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      const failedPayload = { ok: false, status: "failed" };
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce(failedPayload);

      await runMessageAction({
        cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
        sourceReplyFinal: true,
        sourceReplyToolCallId: receipt.toolCallId,
        gateway: {
          terminalSourceReplyReceiptOwner: "caller",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith({
        deliveredPayload: failedPayload,
        mirror: expect.objectContaining({ toolCallId: receipt.toolCallId }),
        preservePendingOnExplicitFailure: true,
        receipt,
      });
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("runs terminal gateway identity preflight before arming the caller receipt", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat identity preflight test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const rejection = new Error("terminal source reply requires an active turn capability");
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => {
        throw rejection;
      });

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
          gateway: {
            resolveAgentRuntimeIdentityToken,
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.beginTerminalSourceReplyDelivery).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("keeps caller receipts pending after an ambiguous gateway timeout", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat ambiguous timeout test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), { kind: "timeout" });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(timeout);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(timeout);
      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("reattaches a timed-out gateway send once with the original idempotency key", async () => {
      const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat timeout reconciliation test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: handleActionResult,
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const timeout = Object.assign(new Error("gateway timeout after 30000ms"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({ ok: true, messageId: "gw-send-late" });
      const controller = new AbortController();

      const actionInput = {
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "gatewaychat",
          target: "user-123",
          message: "hello from agent",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
          timeoutMs: 120_000,
        },
        dryRun: false,
      } satisfies Parameters<typeof runMessageAction>[0];
      const result = await runMessageAction({ ...actionInput, abortSignal: controller.signal });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      const firstCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "first gateway least privilege call",
      );
      const secondCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "second gateway least privilege call",
        1,
      );
      expect(firstCall.timeoutMs).toBe(30_000);
      expect(secondCall).toMatchObject({
        ...firstCall,
        timeoutMs: null,
        signal: expect.any(AbortSignal),
      });
      expect(secondCall.signal).toBeInstanceOf(AbortSignal);
      expect(secondCall.signal).not.toBe(firstCall.signal);
      const gatewayParams = readRecordField(firstCall, "params", "gateway call params");
      expectRecordFields(
        gatewayParams,
        {
          channel: "gatewaychat",
          action: "send",
          idempotencyKey: "idem-gateway-action",
        },
        "gateway call params",
      );
      expect(handleActionResult).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        kind: "send",
        channel: "gatewaychat",
        action: "send",
        handledBy: "plugin",
        payload: { ok: true, messageId: "gw-send-late" },
      });

      mocks.callGatewayLeastPrivilege.mockReset();
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({ ok: true, messageId: "gw-send-bounded" });

      const boundedResult = await runMessageAction(actionInput);

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      const boundedReconciliationCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "bounded gateway reconciliation call",
        1,
      );
      expect(boundedReconciliationCall).toMatchObject({ timeoutMs: 60_000, signal: undefined });
      const boundedParams = readRecordField(
        boundedReconciliationCall,
        "params",
        "bounded gateway reconciliation params",
      );
      expect(boundedParams.idempotencyKey).toBe("idem-gateway-action");
      expect(boundedResult).toMatchObject({
        kind: "send",
        payload: { ok: true, messageId: "gw-send-bounded" },
      });
    });

    it("does not reconnect a timed-out gateway send after cancellation", async () => {
      const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat cancellation test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: handleActionResult,
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      const controller = new AbortController();
      const timeout = Object.assign(new Error("gateway timeout after 30000ms"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockImplementationOnce(async (call: { signal?: AbortSignal }) => {
          controller.abort();
          expect(call.signal?.aborted).toBe(true);
          throw Object.assign(new Error("gateway request aborted"), { name: "AbortError" });
        });

      await expect(
        runMessageAction({
          cfg: {
            channels: {
              gatewaychat: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "send",
          params: {
            channel: "gatewaychat",
            target: "user-123",
            message: "hello from agent",
          },
          gateway: {
            clientName: "cli",
            mode: "cli",
          },
          abortSignal: controller.signal,
          dryRun: false,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(handleActionResult).not.toHaveBeenCalled();
    });
  });
});
