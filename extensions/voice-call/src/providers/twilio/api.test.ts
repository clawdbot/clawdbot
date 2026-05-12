import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../../api.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { TwilioApiError, twilioApiRequest } from "./api.js";

type FetchGuardRequest = {
  url?: string;
  init?: RequestInit;
  auditContext?: string;
  policy?: unknown;
  timeoutMs?: number;
};

function requireFirstFetchGuardRequest(): FetchGuardRequest {
  const [call] = fetchWithSsrFGuardMock.mock.calls;
  if (!call) {
    throw new Error("expected guarded fetch call");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected guarded fetch request");
  }
  return request as FetchGuardRequest;
}

describe("twilioApiRequest", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("posts form bodies with basic auth and parses json", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ sid: "CA123" }), { status: 200 }),
      release,
    });

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {
          To: "+14155550123",
          StatusCallbackEvent: ["initiated", "completed"],
        },
      }),
    ).resolves.toEqual({ sid: "CA123" });

    const { url, init, auditContext, policy, timeoutMs } = requireFirstFetchGuardRequest();
    expect(url).toBe("https://api.twilio.com/Calls.json");
    expect(auditContext).toBe("voice-call.twilio.api");
    expect(policy).toEqual({ allowedHostnames: ["api.twilio.com"] });
    expect(timeoutMs).toBe(30_000);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const requestBody = init?.body;
    if (!(requestBody instanceof URLSearchParams)) {
      throw new Error("expected URLSearchParams request body");
    }
    expect(requestBody.toString()).toBe(
      "To=%2B14155550123&StatusCallbackEvent=initiated&StatusCallbackEvent=completed",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("passes through URLSearchParams, allows 404s, and returns undefined for empty bodies", async () => {
    const responses = [
      new Response(null, { status: 204 }),
      new Response("missing", { status: 404 }),
    ];
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: responses.shift()!,
      release,
    }));

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: new URLSearchParams({ To: "+14155550123" }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls/missing.json",
        body: {},
        allowNotFound: true,
      }),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("throws twilio api errors for non-ok responses", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("bad request", { status: 400 }),
      release,
    });

    await expect(
      twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {},
      }),
    ).rejects.toThrow("Twilio API error: 400 bad request");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("exposes structured Twilio error codes from json error bodies", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          code: 21220,
          message: "Call is not in-progress. Cannot redirect.",
        }),
        { status: 400 },
      ),
      release,
    });

    try {
      await twilioApiRequest({
        baseUrl: "https://api.twilio.com",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls/CA123.json",
        body: {},
      });
      throw new Error("expected Twilio API request to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(TwilioApiError);
      const twilioError = error as TwilioApiError;
      expect(twilioError.name).toBe("TwilioApiError");
      expect(twilioError.httpStatus).toBe(400);
      expect(twilioError.twilioCode).toBe(21220);
      expect(twilioError.message).toBe(
        "Twilio API error: 400 Call is not in-progress. Cannot redirect.",
      );
    }
    expect(release).toHaveBeenCalledTimes(1);
  });
});
