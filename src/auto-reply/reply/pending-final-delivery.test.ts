// Tests pending final delivery records and deferred message-tool send behavior.
import { describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  buildPendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
  sanitizePendingFinalDeliveryText,
} from "./pending-final-delivery.js";

describe("sanitizePendingFinalDeliveryText", () => {
  it("strips internal metadata from durable pending delivery text", () => {
    const text = [
      "Visible reply",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");

    expect(sanitizePendingFinalDeliveryText(text)).toBe("Visible reply");
  });

  it("drops silent reply sentinel payloads", () => {
    expect(sanitizePendingFinalDeliveryText(" NO_REPLY ")).toBe("");
    expect(sanitizePendingFinalDeliveryText('"NO_REPLY"')).toBe("");
    expect(sanitizePendingFinalDeliveryText('{"action":"NO_REPLY"}')).toBe("");
  });

  it("strips mixed silent reply sentinels like normal delivery", () => {
    expect(sanitizePendingFinalDeliveryText("NO_REPLYThe user is saying hello")).toBe(
      "The user is saying hello",
    );
    expect(sanitizePendingFinalDeliveryText("HEARTBEAT_OK NO_REPLY")).toBe("HEARTBEAT_OK");
  });

  it("preserves heartbeat ack text for ack-aware classification", () => {
    expect(sanitizePendingFinalDeliveryText("HEARTBEAT_OK short")).toBe("HEARTBEAT_OK short");
  });
});

describe("normalizePendingFinalRecoveryPayloads", () => {
  it("keeps media directives in the durable recovery text while sendable delivery parses them", () => {
    const rawPayloads = [{ text: "Rendered chart\nMEDIA:/tmp/chart.png" }];

    const recoveryPayloads = normalizePendingFinalRecoveryPayloads(rawPayloads);
    expect(buildPendingFinalDeliveryText(recoveryPayloads)).toBe(
      "Rendered chart\nMEDIA:/tmp/chart.png",
    );

    const deliveryPayloads = normalizePendingFinalDeliveryPayloads(rawPayloads);
    expect(buildPendingFinalDeliveryText(deliveryPayloads)).toBe("Rendered chart");
  });

  it("keeps media-only directives as durable recovery text", () => {
    const recoveryPayloads = normalizePendingFinalRecoveryPayloads([
      { text: "MEDIA:/tmp/chart.png" },
    ]);

    expect(buildPendingFinalDeliveryText(recoveryPayloads)).toBe("MEDIA:/tmp/chart.png");
    expect(normalizePendingFinalDeliveryPayloads(recoveryPayloads)).toHaveLength(1);
  });

  it("encodes structured media URLs as durable media directives", () => {
    expect(
      buildRecoverablePendingFinalDeliveryText([
        { text: "Rendered chart", mediaUrl: "/tmp/chart.png" },
      ]),
    ).toBe("Rendered chart\nMEDIA:/tmp/chart.png");
    expect(
      buildRecoverablePendingFinalDeliveryText([{ mediaUrls: ["/tmp/a.png", "/tmp/b.png"] }]),
    ).toBe("MEDIA:/tmp/a.png\nMEDIA:/tmp/b.png");
  });

  it("refuses payload shapes the text marker cannot replay without loss", () => {
    expect(
      buildRecoverablePendingFinalDeliveryText([
        { text: "Pick one", interactive: { blocks: [{ type: "buttons", buttons: [] }] } },
      ]),
    ).toBeUndefined();
    expect(
      buildRecoverablePendingFinalDeliveryText([
        { text: "Secret image", mediaUrl: "/tmp/secret.png", sensitiveMedia: true },
      ]),
    ).toBeUndefined();
    expect(
      buildRecoverablePendingFinalDeliveryText([{ text: "[[reply_to_current]] visible final" }]),
    ).toBeUndefined();
  });

  it("refuses multi-payload media finals because text recovery loses payload boundaries", () => {
    expect(
      buildRecoverablePendingFinalDeliveryText([
        { text: "A", mediaUrl: "/tmp/a.png" },
        { text: "B", mediaUrl: "/tmp/b.png" },
      ]),
    ).toBeUndefined();
    expect(
      buildRecoverablePendingFinalDeliveryText([{ text: "A\nMEDIA:/tmp/a.png" }, { text: "B" }]),
    ).toBeUndefined();
  });

  it("allows a single structured media payload to recover through media directives", () => {
    expect(
      buildRecoverablePendingFinalDeliveryText([
        { text: "Rendered chart", mediaUrls: ["/tmp/a.png", "/tmp/b.png"] },
      ]),
    ).toBe("Rendered chart\nMEDIA:/tmp/a.png\nMEDIA:/tmp/b.png");
  });

  it("omits payloads that normal delivery suppresses", () => {
    expect(
      buildRecoverablePendingFinalDeliveryText([
        { text: "No channel reply." },
        { text: "visible final" },
      ]),
    ).toBe("visible final");
    expect(
      buildRecoverablePendingFinalDeliveryText([{ text: "No channel reply." }]),
    ).toBeUndefined();
  });
});
