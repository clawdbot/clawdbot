import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import {
  createBroker,
  createRequest,
  createResponseHarness,
} from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("Expected string request body");
  }
  return body;
}

describe("GA OAuth offer broker", () => {
  it.each([
    {
      name: "missing",
      gaSession: undefined,
      message: "require an initial session policy",
    },
    {
      name: "mismatched",
      gaSession: { type: "realtime", model: "gpt-realtime-2" },
      message: "policy model must match the requested model",
    },
  ])("rejects a $name GA policy before reserving provider state", async (testCase) => {
    const fetchImpl = vi.fn();
    const { realtime, sockets } = createBroker({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await expect(
        realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: "gpt-realtime-2.1",
            voice: "cedar",
            ...(testCase.gaSession ? { gaSession: testCase.gaSession } : {}),
          },
          { type: "oauth", token: "oauth-token", accountId: "account-123" },
        ),
      ).rejects.toThrow(testCase.message);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sockets).toEqual([]);
      expect(realtime.getSessionCounts()).toEqual({
        pending: 0,
        inFlight: 0,
        active: 0,
        reservations: 0,
      });
    } finally {
      await realtime.cleanup();
    }
  });

  it("sends the browser policy as multipart without opening a sideband", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        init,
      });
      return new Response("v=ga-answer\r\n", { status: 201 });
    }) as unknown as typeof fetch;
    const { realtime, sockets } = createBroker({ fetchImpl });
    try {
      const gaSession = {
        type: "realtime",
        model: "gpt-realtime-2.1",
        instructions: "Use tools.",
        audio: {
          input: { transcription: { model: "gpt-4o-mini-transcribe" } },
          output: { voice: "cedar" },
        },
        tools: [{ type: "function", name: "openclaw_agent_consult", parameters: {} }],
        tool_choice: "auto",
      };
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-realtime-2.1", voice: "cedar", gaSession },
        { type: "oauth", token: "oauth-token", accountId: "account-123" },
      );
      expect(reservation).toMatchObject({
        offerUrl: OPENAI_QUICKSILVER_OFFER_PATH,
        model: "gpt-realtime-2.1",
        voice: "cedar",
      });
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }

      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: "v=ga-offer\r\n" }),
        response.res,
      );

      expect(response.res.statusCode).toBe(201);
      expect(response.readBody()).toBe("v=ga-answer\r\n");
      expect(sockets).toEqual([]);
      expect(requests[0]).toMatchObject({
        url: "https://api.openai.com/v1/realtime/calls",
        init: {
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer oauth-token",
            "chatgpt-account-id": "account-123",
            "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
          }),
        },
      });
      expect(requests[0]?.init?.headers).not.toHaveProperty("OpenAI-Alpha");
      const body = requireStringBody(requests[0]?.init?.body);
      expect(body).toContain('name="sdp"\r\nContent-Type: application/sdp');
      expect(body).toContain('name="session"\r\nContent-Type: application/json');
      expect(body).toContain(JSON.stringify(gaSession));

      const replay = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), replay.res);
      expect(replay.res.statusCode).toBe(401);
    } finally {
      await realtime.cleanup();
    }
  });

  it("redacts OAuth identity from a bounded browser-visible provider failure", async () => {
    const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.signature";
    const accountId = "7a1f92f3-7f0d-4d18-b1a0-8e6bd215c12f";
    const detail = `safe diagnostic token=${token} account=${accountId} ${"x".repeat(1_000)}`;
    const fetchImpl = vi.fn(
      async () => new Response(detail, { status: 429 }),
    ) as unknown as typeof fetch;
    const { realtime, sockets } = createBroker({ fetchImpl });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-realtime-2.1",
          voice: "cedar",
          gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
        },
        { type: "oauth", token, accountId },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }

      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: "v=ga-offer\r\n" }),
        response.res,
      );

      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).toContain("safe diagnostic");
      expect(response.readBody()).not.toContain(token);
      expect(response.readBody()).not.toContain(accountId);
      expect(response.readBody().length).toBeLessThan(700);
      expect(sockets).toEqual([]);
      expect(realtime.getSessionCounts()).toEqual({
        pending: 0,
        inFlight: 0,
        active: 0,
        reservations: 0,
      });

      const replay = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), replay.res);
      expect(replay.res.statusCode).toBe(401);
    } finally {
      await realtime.cleanup();
    }
  });

  it.each([
    {
      name: "token",
      selectSecret: (token: string) => token,
    },
    {
      name: "account id",
      selectSecret: (_token: string, accountId: string) => accountId,
    },
  ])("redacts an OAuth $name that straddles the detail cutoff", async (testCase) => {
    const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJib3VuZGFyeSJ9.signature";
    const accountId = "7a1f92f3-7f0d-4d18-b1a0-8e6bd215c12f";
    const secret = testCase.selectSecret(token, accountId);
    const secretPrefix = secret.slice(0, 12);
    const detail = `${"x".repeat(490)}${secret}${"y".repeat(1_000)}`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(detail, {
          status: 429,
        }),
    ) as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-realtime-2.1",
          gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
        },
        { type: "oauth", token, accountId },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }

      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: "v=ga-offer\r\n" }),
        response.res,
      );

      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).not.toContain(secret);
      expect(response.readBody()).not.toContain(secretPrefix);
      expect(response.readBody()).toContain("[REDACTED]");
      expect(response.readBody().length).toBeLessThan(700);
    } finally {
      await realtime.cleanup();
    }
  });

  it.each([
    {
      name: "token",
      tokenLength: 1_927,
      selectSecret: (token: string) => token,
    },
    {
      name: "account id",
      tokenLength: 2_045,
      selectSecret: (_token: string, accountId: string) => accountId,
    },
  ])("drops a provider error when an OAuth $name straddles the body cap", async (testCase) => {
    const token = `eyJ${"a".repeat(testCase.tokenLength - 3)}`;
    const accountId = "7a1f92f3-7f0d-4d18-b1a0-8e6bd215c12f";
    const secret = testCase.selectSecret(token, accountId);
    const splitAt = Math.floor(secret.length / 2);
    const shrinkablePrefix = token.repeat(8);
    const fillerLength = 16 * 1024 - shrinkablePrefix.length - splitAt;
    expect(fillerLength).toBeGreaterThanOrEqual(0);
    const detail = `${shrinkablePrefix}${" ".repeat(fillerLength)}${secret} trailing provider detail`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(detail, {
          status: 429,
        }),
    ) as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-realtime-2.1",
          gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
        },
        { type: "oauth", token, accountId },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }

      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: "v=ga-offer\r\n" }),
        response.res,
      );

      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).not.toContain(secret.slice(0, splitAt));
      expect(response.readBody()).not.toContain(secret.slice(splitAt));
      expect(response.readBody()).not.toContain("trailing provider detail");
      expect(response.readBody()).toBe("OpenAI Realtime call creation failed (429)");
    } finally {
      await realtime.cleanup();
    }
  });
});
