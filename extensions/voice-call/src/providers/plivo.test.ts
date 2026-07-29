// Voice Call tests cover plivo plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { PlivoProvider } from "./plivo.js";

function requireEvent<T>(event: T | undefined, message: string): T {
  if (!event) {
    throw new Error(message);
  }
  return event;
}

function requireResponseBody(body: string | undefined): string {
  if (!body) {
    throw new Error("Plivo provider did not return a response body");
  }
  return body;
}

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
    const event = requireEvent(result.events[0], "expected Plivo answer event");
    expect(event.type).toBe("call.answered");
    expect(event.callId).toBe("internal-call-id");
    expect(event.providerCallId).toBe("call-uuid");
    const responseBody = requireResponseBody(result.providerResponseBody);
    expect(responseBody).toContain("<Wait");
    expect(responseBody).toContain('length="300"');
  });

  it("uses verified request key when provided", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });

    const result = provider.parseWebhookEvent(
      {
        headers: { host: "example.com", "x-plivo-signature-v3-nonce": "nonce-1" },
        rawBody:
          "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
        url: "https://example.com/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
        method: "POST",
        query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
      },
      { verifiedRequestKey: "plivo:v3:verified" },
    );

    expect(result.events).toHaveLength(1);
    expect(requireEvent(result.events[0], "expected verified Plivo event").dedupeKey).toBe(
      "plivo:v3:verified",
    );
  });

  it("pins stored callback bases to publicUrl instead of request Host", () => {
    const provider = new PlivoProvider(
      {
        authId: "MA000000000000000000",
        authToken: "test-token",
      },
      {
        publicUrl: "https://voice.openclaw.ai/voice/webhook?provider=plivo",
      },
    );

    provider.parseWebhookEvent({
      headers: { host: "attacker.example" },
      rawBody:
        "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
      url: "https://attacker.example/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
    });

    const callbackMap = (provider as unknown as { callUuidToWebhookUrl: Map<string, string> })
      .callUuidToWebhookUrl;

    expect(callbackMap.get("call-uuid")).toBe("https://voice.openclaw.ai/voice/webhook");
  });

  it("pins call-control transfer URLs to the configured publicUrl path", async () => {
    const provider = new PlivoProvider(
      {
        authId: "MA000000000000000000",
        authToken: "test-token",
      },
      {
        publicUrl: "https://voice.openclaw.ai/voice/webhook?provider=plivo",
      },
    );
    const apiRequest = vi.fn(async (_params: unknown) => ({}));
    (
      provider as unknown as {
        apiRequest: (params: unknown) => Promise<unknown>;
      }
    ).apiRequest = apiRequest;

    provider.parseWebhookEvent({
      headers: { host: "attacker.example" },
      rawBody:
        "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
      url: "https://attacker.example/admin?provider=plivo&flow=answer&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
    });

    await provider.playTts({
      callId: "internal-call-id",
      providerCallId: "call-uuid",
      text: "How can I help?",
    });

    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/Call/call-uuid/",
        body: expect.objectContaining({
          aleg_url:
            "https://voice.openclaw.ai/voice/webhook?provider=plivo&flow=xml-speak&callId=internal-call-id",
        }),
      }),
    );
  });

  it("renders an auto-response as the prompt for the next speech input", async () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });
    const apiRequest = vi.fn(async (_params: unknown) => ({}));
    (
      provider as unknown as {
        apiRequest: (params: unknown) => Promise<unknown>;
      }
    ).apiRequest = apiRequest;
    (
      provider as unknown as {
        callIdToWebhookUrl: Map<string, string>;
      }
    ).callIdToWebhookUrl.set("internal-call-id", "https://example.com/voice/webhook");

    await provider.playTts({
      callId: "internal-call-id",
      providerCallId: "call-uuid",
      text: "How can I help?",
      locale: "en-US",
      listenAfterPlayback: true,
    });

    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/Call/call-uuid/",
        body: expect.objectContaining({
          aleg_url: expect.stringContaining("flow=xml-speak"),
        }),
      }),
    );

    const result = provider.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody: "CallUUID=call-uuid",
      url: "https://example.com/voice/webhook?provider=plivo&flow=xml-speak&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "xml-speak", callId: "internal-call-id" },
    });
    const responseBody = requireResponseBody(result.providerResponseBody);
    expect(responseBody).toContain('<GetInput inputType="speech"');
    expect(responseBody).toContain('speechEndTimeout="2"');
    expect(responseBody).toContain("flow=getinput");
    expect(responseBody).toContain('<Speak language="en-US">How can I help?</Speak>');
    expect(responseBody.indexOf("<GetInput")).toBeLessThan(responseBody.indexOf("<Speak"));
  });
});
