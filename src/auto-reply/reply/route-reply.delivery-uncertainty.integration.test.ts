// Exercises retry safety through the real router, durable sender, and SQLite queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { ReplyPayload } from "../types.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import { deliverFollowupDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import { routeReply } from "./route-reply.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestReplyDispatcher } from "./test-fixtures/acp-runtime.js";
import {
  createMockFollowupRun,
  createMockReplyOperation,
  createMockTypingController,
} from "./test-helpers.js";

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));

const channels = ["telegram", "discord", "slack", "matrix"] as const;
const scenarios = [
  "accepted_without_receipt",
  "not_dispatched",
  "hook_veto",
  "identified",
] as const;
type TestChannel = (typeof channels)[number];
type Scenario = (typeof scenarios)[number];
type SendKind = "text" | "media";

function createFollowupTurn(channel: TestChannel): AdmittedFollowupTurn {
  return {
    runId: "uncertain-followup",
    queued: createMockFollowupRun({
      originatingChannel: channel,
      originatingTo: "recipient",
      run: { messageProvider: channel },
    }),
    operation: createMockReplyOperation().replyOperation,
    config: {},
    session: {
      kind: "detached",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
}

describe.each(channels)("routed %s delivery uncertainty", (channel) => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const attempts: SendKind[] = [];
  const accepted: SendKind[] = [];
  const payload = { text: "recipient accepted this reply" };
  let scenario: Scenario;
  let acceptFallbackText: boolean;
  const messageSendingHook = vi.fn(() => (scenario === "hook_veto" ? { cancel: true } : undefined));

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    attempts.length = 0;
    accepted.length = 0;
    scenario = "accepted_without_receipt";
    acceptFallbackText = false;
    messageSendingHook.mockClear();
    const send = async (
      kind: SendKind,
      { onPlatformSendDispatch }: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0],
    ) => {
      attempts.push(kind);
      const outcome = kind === "text" && acceptFallbackText ? "identified" : scenario;
      if (outcome === "not_dispatched") {
        // Permanent media/payload rejection retires the original queue intent;
        // the caller can still try its distinct text/dispatcher fallback.
        throw new PlatformMessageNotDispatchedError("rejected before recipient delivery", {
          cause: undefined,
          retryable: false,
        });
      }
      await onPlatformSendDispatch?.();
      accepted.push(kind);
      if (outcome === "accepted_without_receipt") {
        throw new Error("connection lost after recipient accepted reply");
      }
      return { channel, messageId: `${kind}-message` };
    };
    const registry = createTestRegistry([
      {
        pluginId: channel,
        source: "test",
        plugin: createOutboundTestPlugin({
          id: channel,
          outbound: {
            deliveryMode: "direct",
            sendText: (context) => send("text", context),
            sendMedia: (context) => send("media", context),
          },
        }),
      },
    ]);
    addTestHook({
      registry,
      pluginId: "delivery-policy",
      hookName: "message_sending",
      handler: messageSendingHook,
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry());
    vi.unstubAllEnvs();
  });

  async function expectCustody() {
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual(
      scenario === "accepted_without_receipt"
        ? [
            expect.objectContaining({
              channel,
              recoveryState: "unknown_after_send",
              retryCount: 1,
            }),
          ]
        : [],
    );
  }

  function expectTextAttempt() {
    expect(attempts).toEqual(scenario === "hook_veto" ? [] : ["text"]);
    expect(accepted).toEqual(
      scenario === "accepted_without_receipt" || scenario === "identified" ? ["text"] : [],
    );
    if (scenario === "hook_veto") {
      expect(messageSendingHook).toHaveBeenCalledOnce();
    }
  }

  it.each(scenarios)("projects %s without conflating delivery and suppression", async (outcome) => {
    scenario = outcome;
    const result = await routeReply({
      payload,
      channel,
      to: "recipient",
      cfg: {},
      replyKind: "final",
      mirror: false,
    });

    await expectCustody();
    expectTextAttempt();
    expect(result).toMatchObject({
      ok: outcome === "identified" || outcome === "hook_veto",
      delivered: outcome === "identified" || outcome === "accepted_without_receipt",
    });
    expect(result.suppressed).toBe(outcome === "hook_veto" ? true : undefined);
    expect(result.messageId).toBe(outcome === "identified" ? "text-message" : undefined);
    if (outcome === "hook_veto") {
      expect(result.reason).toBe("cancelled_by_message_sending_hook");
      expect(result.ambiguous).toBeUndefined();
    } else if (outcome !== "identified") {
      expect(result.error).toContain(
        outcome === "not_dispatched"
          ? "rejected before recipient delivery"
          : "connection lost after recipient accepted reply",
      );
    }
  });

  it.each(scenarios)(
    "dispatches a second follow-up only when %s is proven not sent",
    async (outcome) => {
      scenario = outcome;
      const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
      const turn = createFollowupTurn(channel);
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [payload] },
        turn,
        defaults: {
          defaultModel: "claude",
          typingMode: "never",
          typing: createMockTypingController(),
          opts: { onBlockReply },
        },
        runId: turn.runId,
        runFollowup: vi.fn(async () => {}),
      });

      await expectCustody();
      expectTextAttempt();
      if (outcome === "not_dispatched") {
        expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(payload);
      } else {
        expect(onBlockReply).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["accepted_without_receipt", "not_dispatched"] as const)(
    "gates actual routed ACP media-to-text fallback after %s",
    async (outcome) => {
      scenario = outcome;
      acceptFallbackText = true;
      const dispatcher = createAcpTestReplyDispatcher();
      const coordinator = createAcpDispatchDeliveryCoordinator({
        cfg: {},
        ctx: buildTestCtx({ Provider: channel, Surface: channel }),
        dispatcher,
        inboundAudio: false,
        shouldRouteToOriginating: true,
        originatingChannel: channel,
        originatingTo: "recipient",
      });
      await expect(
        coordinator.deliver(
          "final",
          {
            ...payload,
            mediaUrl: "https://example.com/reply.mp3",
            ttsSupplement: { spokenText: payload.text, visibleTextAlreadyDelivered: false },
          },
          { skipTts: true },
        ),
      ).resolves.toBe(true);

      await expectCustody();
      expect(attempts).toEqual(outcome === "not_dispatched" ? ["media", "text"] : ["media"]);
      expect(accepted).toEqual(outcome === "not_dispatched" ? ["text"] : ["media"]);
      expect(coordinator.getRoutedCounts().final).toBe(1);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );
});
