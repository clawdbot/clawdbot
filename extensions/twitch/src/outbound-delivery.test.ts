import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverOutboundPayloadsCore } from "../../../src/infra/outbound/deliver-core.js";
import { prepareOutboundPayloadBatch } from "../../../src/infra/outbound/deliver-prepare.js";
import {
  countPhysicalOutboundSends,
  type OutboundPayloadDeliveryOutcome,
} from "../../../src/infra/outbound/deliver-types.js";
import { completedOutboundAuditTerminals } from "../../../src/infra/outbound/outbound-audit.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../src/test-utils/channel-plugins.js";
import {
  getClientManager,
  getOrCreateClientManager,
  removeClientManager,
} from "./client-manager-registry.js";
import { twitchMessageAdapter, twitchOutbound } from "./outbound.js";
import { BASE_TWITCH_TEST_ACCOUNT, makeTwitchTestConfig } from "./test-fixtures.js";

const cfg = makeTwitchTestConfig({
  ...BASE_TWITCH_TEST_ACCOUNT,
  accessToken: "twitch-test-token",
});

describe("Twitch outbound delivery accounting", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "twitch",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({ id: "twitch", outbound: twitchOutbound }),
            message: twitchMessageAdapter,
          },
        },
      ]),
    );
  });

  afterEach(async () => {
    await removeClientManager("default");
    setActivePluginRegistry(createTestRegistry());
    vi.restoreAllMocks();
  });

  async function deliver(text: string) {
    const params = { cfg, channel: "twitch", to: "testchannel", payloads: [{ text }] };
    const outcomes: OutboundPayloadDeliveryOutcome[] = [];
    const onDeliveryResult = vi.fn();
    const onMessageSentEvent = vi.fn();
    const preparedBatch = await prepareOutboundPayloadBatch(params);
    const results = await deliverOutboundPayloadsCore({
      ...params,
      preparedBatch,
      onDeliveryResult,
      onMessageSentEvent,
      onPayloadDeliveryOutcome: (outcome) => outcomes.push(outcome),
    });
    return { results, outcomes, onDeliveryResult, onMessageSentEvent };
  }

  it("records markdown-only text as an intentional non-outcome without a client", async () => {
    expect(getClientManager("default")).toBeUndefined();
    const { results, outcomes, onDeliveryResult, onMessageSentEvent } = await deliver("---");

    expect(countPhysicalOutboundSends(results)).toBe(0);
    expect(results).toEqual([]);
    expect(outcomes).toEqual([
      { index: 0, status: "suppressed", reason: "adapter_returned_no_send" },
    ]);
    expect(onDeliveryResult).not.toHaveBeenCalled();
    expect(onMessageSentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.anything(),
    );
    expect(
      completedOutboundAuditTerminals({ payloadCount: 1, results, payloadOutcomes: outcomes }),
    ).toEqual([
      {
        payloadIndex: 0,
        terminal: { outcome: "suppressed", reasonCode: "no_visible_payload" },
      },
    ]);
  });

  it("exposes no physical send through the direct Twitch adapter", async () => {
    const result = await twitchOutbound.sendText!({ cfg, to: "testchannel", text: "---" });

    expect(result).toMatchObject({ outcome: "not_sent", messageId: "" });
    expect(countPhysicalOutboundSends([result])).toBe(0);
    expect(getClientManager("default")).toBeUndefined();
  });

  it("still dispatches and counts an ordinary Twitch message", async () => {
    const manager = getOrCreateClientManager("default", {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });
    const send = vi.spyOn(manager, "sendMessage").mockResolvedValue({
      ok: true,
      messageId: "twitch-accepted",
    });
    const { results, outcomes, onDeliveryResult, onMessageSentEvent } =
      await deliver("Hello Twitch!");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[2]).toBe("Hello Twitch!");
    expect(countPhysicalOutboundSends(results)).toBe(1);
    expect(outcomes).toMatchObject([{ index: 0, status: "sent" }]);
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onMessageSentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, messageId: "twitch-accepted" }),
      0,
    );
  });
});
