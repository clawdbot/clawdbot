import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../../types.js";
import { decideTwimlResponse, readTwimlRequestView } from "./twiml-policy.js";

function createContext(rawBody: string, query?: WebhookContext["query"]): WebhookContext {
  return {
    headers: {},
    rawBody,
    url: "https://example.ngrok.app/voice/twilio",
    method: "POST",
    query,
  };
}

describe("twiml policy", () => {
  it("returns stored twiml decision for initial notify callback", () => {
    const view = readTwimlRequestView(
      createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA123", {
        callId: "call-1",
      }),
    );

    const decision = decideTwimlResponse({
      ...view,
      hasStoredTwiml: true,
      isNotifyCall: true,
      hasActiveStreams: false,
      canStream: true,
    });

    expect(decision.kind).toBe("stored");
  });

  it("returns queue for inbound when another stream is active", () => {
    const view = readTwimlRequestView(
      createContext("CallStatus=ringing&Direction=inbound&CallSid=CA456"),
    );

    const decision = decideTwimlResponse({
      ...view,
      hasStoredTwiml: false,
      isNotifyCall: false,
      hasActiveStreams: true,
      canStream: true,
    });

    expect(decision.kind).toBe("queue");
  });

  it("returns stream + activation for inbound call when available", () => {
    const view = readTwimlRequestView(
      createContext("CallStatus=ringing&Direction=inbound&CallSid=CA789"),
    );

    const decision = decideTwimlResponse({
      ...view,
      hasStoredTwiml: false,
      isNotifyCall: false,
      hasActiveStreams: false,
      canStream: true,
    });

    expect(decision.kind).toBe("stream");
    expect(decision.activateStreamCallSid).toBe("CA789");
  });

  it("returns empty for status callbacks", () => {
    const view = readTwimlRequestView(
      createContext("CallStatus=completed&Direction=inbound&CallSid=CA123", {
        type: "status",
      }),
    );

    const decision = decideTwimlResponse({
      ...view,
      hasStoredTwiml: false,
      isNotifyCall: false,
      hasActiveStreams: false,
      canStream: true,
    });

    expect(decision.kind).toBe("empty");
  });
});
