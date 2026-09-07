import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OutboundDeliveryError,
  type OutboundPayloadDeliveryOutcome,
} from "../../infra/outbound/deliver-types.js";
import type { DeliverOutboundPayloadsParams } from "../../infra/outbound/deliver.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { routeReply } from "./route-reply.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads:
    vi.fn<typeof import("../../infra/outbound/deliver.js").deliverOutboundPayloads>(),
}));
vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => undefined }));

const routeTestReply = (
  params: Pick<Parameters<typeof routeReply>[0], "payload" | "channel" | "to">,
) => routeReply({ cfg: {}, replyKind: "final", ...params });

describe("routeReply custody projections", () => {
  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockReset();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createChannelTestPluginBase({
            id: "slack",
            config: { listAccountIds: () => [] },
          }),
          source: "test",
        },
      ]),
    );
  });
  afterEach(() => setActivePluginRegistry(createTestRegistry()));

  describe.each(["held", "released"] as const)("with %s queue custody", (queueCustody) => {
    it.each([
      ["throw", false, undefined],
      ["throw", true, undefined],
      ["throw", true, "visible-1"],
      ["best-effort return", false, undefined],
      ["best-effort return", true, undefined],
      ["best-effort return", true, "visible-1"],
    ] as const)(
      "projects %s with sentBeforeError=%s and messageId=%s through durable send",
      async (failureMode, sentBeforeError, messageId) => {
        const cause = new Error("transport failed");
        const results = messageId ? [{ channel: "slack" as const, messageId }] : [];
        const outcome = {
          index: 0,
          status: "failed",
          error: cause,
          sentBeforeError,
          stage: "platform_send",
          results,
        } satisfies OutboundPayloadDeliveryOutcome;
        const error = new OutboundDeliveryError(cause.message, {
          cause,
          results,
          payloadOutcomes: [outcome],
          stage: "platform_send",
        });
        error.queueCustody = queueCustody;
        mocks.deliverOutboundPayloads.mockImplementationOnce(
          async ({ onPayloadDeliveryOutcome }: DeliverOutboundPayloadsParams) => {
            if (failureMode === "throw") {
              throw error;
            }
            onPayloadDeliveryOutcome?.({ ...outcome, error });
            return results;
          },
        );

        const result = await routeTestReply({
          payload: { text: "hello" },
          channel: "slack",
          to: "channel:C123",
        });

        expect(result).toEqual({
          ok: false,
          delivered: Boolean(messageId),
          error: "Failed to route reply to slack: transport failed",
          cause: expect.objectContaining({ cause, queueCustody, sentBeforeError }),
          messageId,
          queueCustody,
          ...(!messageId && sentBeforeError ? { ambiguous: true } : {}),
        });
        expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("keeps unidentified adapter acceptance ambiguous without confirming visibility", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({ onPayloadDeliveryOutcome }: DeliverOutboundPayloadsParams) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_identity",
        });
        return [];
      },
    );

    const result = await routeTestReply({
      payload: { text: "hello" },
      channel: "slack",
      to: "channel:C123",
    });

    expect(result).toEqual({
      ok: true,
      delivered: false,
      ambiguous: true,
      reason: "adapter_returned_no_identity",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });
});
