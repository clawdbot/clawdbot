// Voice Call tests cover api plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../../api.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { resolveTwilioApiBaseUrl } from "../twilio-region.js";
import { TwilioApiError, twilioApiRequest } from "./api.js";

const DEFAULT_BASE_URL = resolveTwilioApiBaseUrl({ accountSid: "AC123" });

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

function cancelTrackedTextResponse(
  text: string,
  init?: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
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
        baseUrl: DEFAULT_BASE_URL,
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
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
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

  it("derives the regional hostname for the request and SSRF policy", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ sid: "CA123" }), { status: 200 }),
      release,
    });
    const baseUrl = resolveTwilioApiBaseUrl({
      accountSid: "AC123",
      region: "ie1",
    });

    await twilioApiRequest({
      baseUrl,
      accountSid: "AC123",
      authToken: "secret",
      endpoint: "/Calls.json",
      body: {},
    });

    const { url, policy } = requireFirstFetchGuardRequest();
    expect(url).toBe("https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    expect(policy).toEqual({ allowedHostnames: ["api.dublin.ie1.twilio.com"] });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported API hosts before the SSRF guard", async () => {
    await expect(
      twilioApiRequest({
        baseUrl: "https://metadata.google.internal/2010-04-01/Accounts/AC123",
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {},
      }),
    ).rejects.toThrow("Unsupported Twilio API hostname: metadata.google.internal");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("maps AU1 to Twilio's Sydney regional hostname", () => {
    expect(resolveTwilioApiBaseUrl({ accountSid: "AC123", region: "au1" })).toBe(
      "https://api.sydney.au1.twilio.com/2010-04-01/Accounts/AC123",
    );
  });

  it("passes through URLSearchParams, allows 404s, and returns undefined for empty bodies", async () => {
    const missing = cancelTrackedTextResponse("missing", { status: 404 });
    const responses = [new Response(null, { status: 204 }), missing.response];
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: responses.shift()!,
      release,
    }));

    await expect(
      twilioApiRequest({
        baseUrl: DEFAULT_BASE_URL,
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: new URLSearchParams({ To: "+14155550123" }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      twilioApiRequest({
        baseUrl: DEFAULT_BASE_URL,
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls/missing.json",
        body: {},
        allowNotFound: true,
      }),
    ).resolves.toBeUndefined();
    expect(missing.wasCanceled()).toBe(true);
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
        baseUrl: DEFAULT_BASE_URL,
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {},
      }),
    ).rejects.toThrow("Twilio API error: 400 bad request");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds twilio error bodies and cancels unread overflow", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedTextResponse("x".repeat(9 * 1024), { status: 400 });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release,
    });

    try {
      await twilioApiRequest({
        baseUrl: DEFAULT_BASE_URL,
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {},
      });
      throw new Error("expected Twilio API request to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(TwilioApiError);
      const twilioError = error as TwilioApiError;
      expect(twilioError.message).toContain("Twilio API error: 400 ");
      expect(twilioError.message).toContain("... [truncated]");
      expect(twilioError.responseText.length).toBeLessThan(8_300);
    }
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("wraps malformed json success responses with an owned error", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("{not json", { status: 200 }),
      release,
    });

    await expect(
      twilioApiRequest({
        baseUrl: DEFAULT_BASE_URL,
        accountSid: "AC123",
        authToken: "secret",
        endpoint: "/Calls.json",
        body: {},
      }),
    ).rejects.toThrow("Twilio API returned malformed JSON.");
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
        baseUrl: DEFAULT_BASE_URL,
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
