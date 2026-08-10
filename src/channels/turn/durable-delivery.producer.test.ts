// Producer-boundary integration test for #119169: drives the REAL durable-send
// producer (sendDurableMessageBatch -> deliverOutboundPayloadsInternal/deliverCore)
// with a real channel adapter that returns no identity, and asserts the outcome
// reaches settlement as potentially visible (handled_visible). Unlike the unit
// tests in durable-delivery.test.ts, sendDurableMessageBatch is NOT mocked here;
// only the channel adapter is a fixture, which is the legitimate platform boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { ChannelOutboundAdapter } from "../plugins/types.public.js";
import type { RecordInboundSession } from "../session.types.js";
import {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";

const matrixPluginId = "matrix";

function ctxPayload() {
  return {
    CommandAuthorized: true,
    CommandTurn: { kind: "normal", source: "message", authorized: false },
  } as Parameters<typeof deliverInboundReplyWithMessageSendContext>[0]["ctxPayload"];
}

describe("durable inbound reply delivery — real producer boundary (#119169)", () => {
  let pluginRuntimeSnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

  beforeEach(() => {
    // Snapshot the full plugin-runtime state (registry + cache key + subagent
    // mode + workspace dir) before installing the fixture adapter, restored in
    // afterEach. setActivePluginRegistry defaults those metadata fields, so
    // restoring only an empty registry would leak reset metadata into later
    // tests. restoreActivePluginRegistrySnapshot is the canonical pair.
    pluginRuntimeSnapshot = captureActivePluginRegistrySnapshot();
    // Adapter was invoked but returned no identity (empty messageId): the
    // platform may have delivered. sendTextOnlyErrorPayloads routes error
    // payloads through sendPayload so the no-identity branch is exercised.
    const noIdentityAdapter: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendTextOnlyErrorPayloads: true,
      deliveryCapabilities: {
        durableFinal: { text: true, payload: true, messageSendingHooks: true },
      },
      sendText: async () => ({ channel: matrixPluginId, messageId: "unused-text" }),
      sendPayload: async () => ({ channel: matrixPluginId, messageId: "" }),
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: matrixPluginId,
          source: "test",
          plugin: createOutboundTestPlugin({ id: matrixPluginId, outbound: noIdentityAdapter }),
        },
      ]),
    );
  });

  afterEach(() => {
    restoreActivePluginRegistrySnapshot(pluginRuntimeSnapshot);
  });

  it("treats a real producer adapter-no-identity outcome as potentially visible", async () => {
    const result = await deliverInboundReplyWithMessageSendContext({
      cfg: {},
      channel: matrixPluginId,
      to: "!room:example",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final error reply", isError: true },
      ctxPayload: ctxPayload(),
    });

    // Real producer: sendDurableMessageBatch -> deliverCore -> sendPayload
    // returned no identity -> suppressed/adapter_returned_no_identity.
    // Settlement: durable-delivery maps it to handled_visible, not handled_no_send.
    // Explicit status guard narrows the result union so `.delivery` typechecks
    // (vitest's expect().toBe() does not narrow; matches the adjacent unit test).
    if (result.status !== "handled_visible") {
      throw new Error(`expected handled_visible, got ${result.status}`);
    }
    expect(result.delivery.visibleReplySent).toBe(true);

    // Lifecycle settlement boundary (lifecycle.ts:519-522): the durable result
    // must (1) not throw as a failed delivery, (2) be classified handled so the
    // caller skips fallback, and (3) carry visibleReplySent=true so the private
    // isExplicitlyNonVisibleChannelDelivery predicate (lifecycle.ts:129,
    // `visibleReplySent === false`) settles it as a visible send — emitting
    // message_sent and suppressing a duplicate fallback reply. Current main
    // returns handled_no_send (visibleReplySent=false) for this outcome, which
    // settles as explicitly non-visible and would allow a duplicate reply.
    expect(() => throwIfDurableInboundReplyDeliveryFailed(result)).not.toThrow();
    expect(isDurableInboundReplyDeliveryHandled(result)).toBe(true);
    expect(result.delivery.visibleReplySent).toBe(true);
  });

  it("settles the no-identity outcome through the real lifecycle delivery owner as visible", async () => {
    // Drives the real durable producer (sendDurableMessageBatch -> deliverCore,
    // NOT mocked) through dispatchAssembledChannelTurn, the real lifecycle
    // delivery owner. The faked dispatchReplyWithBufferedBlockDispatcher is the
    // legitimate model/reply boundary: it calls the real
    // dispatcherOptions.deliver (constructed inside lifecycle.ts:475-525), which
    // runs delivery.durable -> deliverInboundReplyWithMessageSendContext ->
    // sendDurableMessageBatch -> the real no-identity adapter. The durable-handled
    // branch (lifecycle.ts:515-522) then invokes runChannelDeliveryObserver
    // (the settlement callback) and recordSettledDelivery — the owner whose
    // visibleReplySent flag controls isExplicitlyNonVisibleChannelDelivery
    // (lifecycle.ts:129) and thus final accounting. Current main returns
    // handled_no_send (visibleReplySent=false) here, so onDelivered would receive
    // visibleReplySent=false and the delivery would settle as non-visible.
    const cfg = {} as OpenClawConfig;
    const turnCtxPayload = {
      Body: "hi",
      From: "sender",
      To: "!room:example",
      OriginatingTo: "!room:example",
      SessionKey: "agent:main:matrix:peer",
      Provider: "matrix",
      Surface: "matrix",
    } as FinalizedMsgContext;
    const recordInboundSession = vi.fn(async () => undefined) as unknown as RecordInboundSession;
    const onDelivered = vi.fn();
    const replyPayload: ReplyPayload = { text: "final error reply", isError: true };

    // Faked reply dispatcher (model/reply boundary, NOT the delivery producer):
    // enqueues one final reply through the real dispatcherOptions.deliver, which
    // lifecycle.ts constructs to run delivery.durable against the real producer.
    // The type assertion matches the kernel.test.ts createDispatch() pattern: the
    // fake only uses dispatcherOptions.deliver, the legitimate test seam.
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: {
        dispatcherOptions: { deliver: (p: ReplyPayload, i: { kind: string }) => Promise<unknown> };
      }) => {
        await params.dispatcherOptions.deliver(replyPayload, { kind: "final" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    ) as DispatchReplyWithBufferedBlockDispatcher;

    const result = await dispatchAssembledChannelTurn({
      cfg,
      channel: matrixPluginId,
      agentId: "main",
      routeSessionKey: "agent:main:matrix:peer",
      storePath: "/tmp/openclaw-producer-settlement.json",
      ctxPayload: turnCtxPayload,
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: vi.fn(),
        durable: { to: "!room:example", replyToMode: "first" },
        onDelivered,
      },
    });

    // The real lifecycle settlement owner observed the delivery: onDelivered is
    // the settlement callback (lifecycle.ts:516-520, runChannelDeliveryObserver).
    expect(onDelivered).toHaveBeenCalledTimes(1);
    const settledCall = onDelivered.mock.calls[0] as unknown as [
      ReplyPayload,
      { kind: string },
      { visibleReplySent: boolean },
    ];
    const settledResult = settledCall[2];
    // PR fix: the no-identity adapter outcome is handled_visible, so the
    // settlement callback receives visibleReplySent=true — the delivery is
    // accounted as a visible send, suppressing a duplicate fallback reply.
    expect(settledResult.visibleReplySent).toBe(true);
    // Dispatch succeeded and recorded the final reply count from the faked
    // dispatcher (settlement did not override the queued-final accounting).
    expect(result.dispatched).toBe(true);
  });
});
