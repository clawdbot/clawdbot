// Feishu tests cover channel.message adapter durable-final capability declarations.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { feishuPlugin } from "./channel-plugin-api.js";

type FeishuMessageAdapter = NonNullable<typeof feishuPlugin.message>;

function requireFeishuMessageAdapter(): FeishuMessageAdapter {
  const adapter = feishuPlugin.message;
  if (!adapter) {
    throw new Error("Expected Feishu message adapter");
  }
  return adapter;
}

describe("feishu channel message adapter", () => {
  it("declares the durable-final capabilities Feishu supports at runtime", () => {
    const adapter = requireFeishuMessageAdapter();
    const capabilities = adapter.durableFinal?.capabilities;

    // Capabilities Feishu supports and must declare so the core delivery layer
    // does not reject durable sends carrying these requirements.
    expect(capabilities?.text).toBe(true);
    expect(capabilities?.media).toBe(true);
    expect(capabilities?.payload).toBe(true);
    expect(capabilities?.replyTo).toBe(true);
    expect(capabilities?.thread).toBe(true);
    expect(capabilities?.messageSendingHooks).toBe(true);
  });

  it("does not declare durable-final capabilities Feishu lacks", () => {
    const adapter = requireFeishuMessageAdapter();
    const capabilities = adapter.durableFinal?.capabilities;

    // silent/batch/poll/nativeQuote are not supported by the Feishu send path;
    // declaring them would let core assume guarantees the channel cannot honor.
    expect(capabilities?.silent).not.toBe(true);
    expect(capabilities?.batch).not.toBe(true);
    expect(capabilities?.poll).not.toBe(true);
    expect(capabilities?.nativeQuote).not.toBe(true);
  });

  it("backs declared durable-final capabilities with adapter proofs", async () => {
    const adapter = requireFeishuMessageAdapter();

    const results = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "feishuMessageAdapter",
      adapter,
      proofs: {
        text: () => {
          expect(typeof adapter.send?.text).toBe("function");
        },
        media: () => {
          expect(typeof adapter.send?.media).toBe("function");
        },
        payload: () => {
          expect(typeof adapter.send?.payload).toBe("function");
        },
        replyTo: () => {
          expect(typeof adapter.send?.text).toBe("function");
        },
        thread: () => {
          expect(typeof adapter.send?.text).toBe("function");
        },
        messageSendingHooks: () => {
          // beforeSendAttempt lifecycle hook backs the messageSendingHooks claim.
          expect(typeof adapter.send?.lifecycle?.beforeSendAttempt).toBe("function");
        },
      },
    });

    // Every declared capability must be backed by a proof that passed.
    for (const result of results) {
      expect(result.status).toBe("verified");
    }
  });
});
