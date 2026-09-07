// Feishu tests cover channel.message adapter durable-final capability declarations.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";

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

  it("routes payload delivery through the message-adapter lifecycle sender", () => {
    // The message adapter defines send.payload so core runs it through
    // runChannelMessageSendWithLifecycle (src/infra/outbound/deliver-channel.ts
    // sendPayload = messagePayload || outbound?.sendPayload). Without it core
    // falls back to outbound.sendPayload, which skips the lifecycle and can
    // mark a payload dispatched before the sender resolves.
    const adapter = requireFeishuMessageAdapter();
    expect(typeof adapter.send?.payload).toBe("function");
    expect(typeof adapter.send?.lifecycle?.beforeSendAttempt).toBe("function");
  });

  it("backs declared durable-final capabilities with adapter proofs", async () => {
    const adapter = requireFeishuMessageAdapter();

    // The verifier iterates the canonical capability list and throws if a
    // declared capability has no proof, so a complete proofs map for every
    // declared capability is itself the contract check (mirrors telegram).
    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "feishuMessageAdapter",
      adapter,
      proofs: {
        text: () => {
          expect(typeof adapter.send?.text).toBe("function");
        },
        media: () => {
          expect(typeof adapter.send?.media).toBe("function");
        },
        // Payload routes through the message-adapter send.payload sender, which
        // participates in the same lifecycle as text/media.
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
          expect(typeof adapter.send?.lifecycle?.beforeSendAttempt).toBe("function");
        },
      },
    });
  });
});
