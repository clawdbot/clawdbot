import { describe, expect, it, vi } from "vitest";
import {
  buildOpenAIRealtimeSidebandUrl,
  createOpenAIQuicksilverCall,
  hangupOpenAIRealtimeCall,
} from "./realtime-quicksilver-wire.js";

describe("OpenAI Realtime sideband call wire", () => {
  it("posts bounded server-owned session config and returns the fixed sideband URL", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-platform" }); // pragma: allowlist secret
      expect(init?.headers).toMatchObject({
        "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
      });
      if (typeof init?.body !== "string") {
        throw new Error("Expected string multipart body");
      }
      const form = init.body;
      expect(form).toContain('name="sdp"');
      expect(form).toContain("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
      expect(form).toContain('name="session"');
      expect(form).toContain('"type":"realtime","model":"gpt-realtime-2.1"');
      return new Response("v=0\r\na=answer\r\n", {
        status: 201,
        headers: { Location: "/v1/realtime/calls/call_test-123" },
      });
    });

    await expect(
      createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "sk-platform" }, // pragma: allowlist secret
        requestIds: {
          realtimeSessionId: "realtime-test",
          sessionId: "session-test",
          threadId: "thread-test",
        },
        sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        session: { type: "realtime", model: "gpt-realtime-2.1" },
        gaSideband: true,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      kind: "ga-sideband",
      answerSdp: "v=0\r\na=answer\r\n",
      callId: "call_test-123",
      sidebandUrl: "wss://api.openai.com/v1/realtime?call_id=call_test-123",
      status: 201,
    });
  });

  it.each([
    [null, "missing"],
    ["https://attacker.example/v1/realtime/calls/rtc_test", "unexpected target"],
    ["/v1/files/rtc_test", "no valid call id"],
    ["/v1/realtime/calls/bad.id", "no valid call id"],
    [`/v1/realtime/calls/${"x".repeat(129)}`, "no valid call id"],
    [`/v1/realtime/calls/rtc_test?${"x".repeat(600)}`, "too large"],
  ])("rejects an untrusted Location header", async (location, message) => {
    await expect(
      createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "sk-platform" }, // pragma: allowlist secret
        requestIds: {
          realtimeSessionId: "realtime-location",
          sessionId: "session-location",
          threadId: "thread-location",
        },
        sdp: "v=0\r\n",
        session: { type: "realtime", model: "gpt-realtime-2.1" },
        gaSideband: true,
        fetchImpl: vi.fn(
          async () =>
            new Response("v=answer\r\n", {
              status: 201,
              ...(location === null ? {} : { headers: { Location: location } }),
            }),
        ) as typeof fetch,
      }),
    ).rejects.toThrow(message);
  });

  it("constructs and validates the sideband URL locally", () => {
    expect(buildOpenAIRealtimeSidebandUrl("call-a_b_1")).toBe(
      "wss://api.openai.com/v1/realtime?call_id=call-a_b_1",
    );
    expect(() => buildOpenAIRealtimeSidebandUrl("https://attacker.example")).toThrow("invalid");
  });

  it("hangs up only the fixed validated WebRTC call endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await hangupOpenAIRealtimeCall({
      apiKey: "sk-platform", // pragma: allowlist secret
      callId: "call_test-123",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls/call_test-123/hangup",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("redacts bounded provider error details", async () => {
    const leaked = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const fetchImpl = vi.fn(
      async () => new Response(`request rejected Authorization: Bearer ${leaked}`, { status: 403 }),
    );
    let error: unknown;
    try {
      await createOpenAIQuicksilverCall({
        auth: { type: "api-key", token: "sk-platform" }, // pragma: allowlist secret
        requestIds: {
          realtimeSessionId: "realtime-error",
          sessionId: "session-error",
          threadId: "thread-error",
        },
        sdp: "v=0\r\n",
        session: { type: "realtime", model: "gpt-realtime-2.1" },
        gaSideband: true,
        fetchImpl: fetchImpl as typeof fetch,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("OpenAI Realtime call creation failed (403)");
    expect((error as Error).message).not.toContain(leaked);
  });
});
