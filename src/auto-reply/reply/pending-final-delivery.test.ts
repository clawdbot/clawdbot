// Tests pending final delivery records and deferred message-tool send behavior.
import { describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
  resolvePendingFinalDeliveryCompletion,
  sanitizePendingFinalDeliveryText,
} from "./pending-final-delivery.js";

describe("resolvePendingFinalDeliveryCompletion", () => {
  it("persists the session writer authority with durable final custody", () => {
    const payload = setReplyPayloadMetadata(
      { text: "settled final" },
      {
        pendingFinalDeliveryCompletion: {
          deliveryId: "delivery-1",
          intentId: "intent-1",
          sessionId: "session-1",
          sessionKey: "agent:main:telegram:direct:1",
          storePath: "/tmp/sessions.json",
        },
        sessionWriterDeliveryAuthority: {
          agentId: "main",
          expectedLifecycleRevision: "revision-a",
          expectedSessionId: "session-1",
          expectedWriterRunId: "run-a",
          sessionKey: "agent:main:telegram:direct:1",
          storePath: "/tmp/sessions.json",
        },
      },
    );

    expect(resolvePendingFinalDeliveryCompletion([payload])).toEqual({
      kind: "pending-final",
      deliveryId: "delivery-1",
      intentId: "intent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:1",
      storePath: "/tmp/sessions.json",
      sessionWriterDeliveryAuthority: {
        agentId: "main",
        expectedLifecycleRevision: "revision-a",
        expectedSessionId: "session-1",
        expectedWriterRunId: "run-a",
        sessionKey: "agent:main:telegram:direct:1",
        storePath: "/tmp/sessions.json",
      },
    });
  });
});

describe("sanitizePendingFinalDeliveryText", () => {
  it("strips internal metadata from durable pending delivery text", () => {
    const text = [
      "Visible reply",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      markInboundContextLabel("Conversation info:"),
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

  it.each([
    ["NO_REPLY\n\nThe user is saying hello", "The user is saying hello"],
    ["NO_REPLY\r\nThe user is saying hello", "The user is saying hello"],
    ["NO_REPLY NO_REPLY\nThe user is saying hello", "The user is saying hello"],
    ["NO_REPLY\n✅ Done", "✅ Done"],
    ["NO_REPLY\n- Done", "- Done"],
    ["NO_REPLY\n—note", "—note"],
    ["NO_REPLY\n: explanation", ": explanation"],
    ["NO_REPLY\n**Done**", "**Done**"],
    ['NO_REPLY\n"Hello"', '"Hello"'],
    ["NO_REPLY\n```ts\nconst done = true;\n```", "```ts\nconst done = true;\n```"],
  ])("strips newline-separated leading silent tokens from recovery text: %j", (text, expected) => {
    expect(sanitizePendingFinalDeliveryText(text)).toBe(expected);
  });

  it.each([
    "Done as requested!NO_REPLY",
    "question?NO_REPLY",
    "note,NO_REPLY",
    "item;NO_REPLY",
    "label:NO_REPLY",
  ])("preserves punctuation-attached silent-token literals in recovery: %j", (text) => {
    expect(sanitizePendingFinalDeliveryText(text)).toBe(text);
  });

  it("strips repeated trailing silent tokens from recovery text", () => {
    expect(sanitizePendingFinalDeliveryText("Done. NO_REPLY NO_REPLY")).toBe("Done.");
  });

  it.each([
    "interject.NO_REPLY",
    "The example is interject.NO_REPLY",
    "Done as requested.NO_REPLY",
    "NO_REPLY NO_REPLY: explanation",
    "NO_REPLY\nNO_REPLY: explanation",
    "NO_REPLY\nNO_REPLY—note",
    "NO_REPLY\nNO_REPLY-note",
    "NO_REPLY\nNO_REPLY -- nope",
  ])("preserves substantive dotted and punctuation-start recovery literals: %j", (text) => {
    expect(sanitizePendingFinalDeliveryText(text)).toBe(text);
  });

  it("preserves heartbeat ack text for ack-aware classification", () => {
    expect(sanitizePendingFinalDeliveryText("HEARTBEAT_OK short")).toBe("HEARTBEAT_OK short");
  });
});

describe("normalizePendingFinalRecoveryPayloads", () => {
  it("keeps media directives in the durable recovery text while sendable delivery parses them", () => {
    const rawPayloads = [{ text: "Rendered chart\nMEDIA:/tmp/chart.png" }];

    const recoveryPayloads = normalizePendingFinalRecoveryPayloads(rawPayloads);
    expect(recoveryPayloads.map((payload) => payload.text)).toEqual([
      "Rendered chart\nMEDIA:/tmp/chart.png",
    ]);

    const deliveryPayloads = normalizePendingFinalDeliveryPayloads(rawPayloads);
    expect(deliveryPayloads.map((payload) => payload.text)).toEqual(["Rendered chart"]);
  });

  it("keeps media-only directives as durable recovery text", () => {
    const recoveryPayloads = normalizePendingFinalRecoveryPayloads([
      { text: "MEDIA:/tmp/chart.png" },
    ]);

    expect(recoveryPayloads.map((payload) => payload.text)).toEqual(["MEDIA:/tmp/chart.png"]);
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

  it("separates implicit delivery threading from explicit reply semantics", () => {
    expect(
      buildRecoverablePendingFinalDeliveryText([
        { text: "Visible final", replyToId: "source-message" },
      ]),
    ).toBe("Visible final");

    const explicitReply = { text: "Visible final", replyToId: "source-message" };
    setReplyPayloadMetadata(explicitReply, { replyToIdExplicit: true });
    expect(buildRecoverablePendingFinalDeliveryText([explicitReply])).toBeUndefined();
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
