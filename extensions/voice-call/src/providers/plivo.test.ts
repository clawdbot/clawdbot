import { describe, expect, it } from "vitest";

import { PlivoProvider } from "./plivo.js";

describe("PlivoProvider", () => {
  it("parses answer callback into call.answered and returns keep-alive XML", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });

    const result = provider.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody:
        "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
      url: "https://example.com/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("call.answered");
    expect(result.events[0]?.callId).toBe("internal-call-id");
    expect(result.events[0]?.providerCallId).toBe("call-uuid");
    expect(result.providerResponseBody).toContain("<Wait");
    expect(result.providerResponseBody).toContain('length="300"');
  });
});
