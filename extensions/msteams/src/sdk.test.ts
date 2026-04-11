import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBotFrameworkJwtValidator,
  createMSTeamsAdapter,
  createMSTeamsApp,
  type MSTeamsTeamsSdk,
} from "./sdk.js";
import type { MSTeamsCredentials } from "./token.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      fetchImpl?: typeof fetch;
    }) => ({
      response: await (params.fetchImpl ?? fetch)(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

const clientConstructorState = vi.hoisted(() => ({
  calls: [] as Array<{ serviceUrl: string; options: unknown }>,
}));

// Track jwt.verify calls to assert audience/issuer/algorithm config.
const jwtState = vi.hoisted(() => ({
  verifyBehavior: "success" as "success" | "throw",
  decodedHeader: { kid: "key-1" } as { kid?: string } | null,
  decodedPayload: { iss: "https://api.botframework.com" } as { iss?: string } | null,
  verifyCalls: [] as Array<{ token: string; options: unknown }>,
}));

const jwtMockImpl = {
  decode: (token: string, opts?: { complete?: boolean }) => {
    if (opts?.complete) {
      return jwtState.decodedHeader ? { header: jwtState.decodedHeader } : null;
    }
    return jwtState.decodedPayload;
  },
  verify: (token: string, _key: string, options: unknown) => {
    jwtState.verifyCalls.push({ token, options });
    if (jwtState.verifyBehavior === "throw") {
      throw new Error("invalid signature");
    }
    return { sub: "ok" };
  },
};

vi.mock("jsonwebtoken", () => ({
  ...jwtMockImpl,
  default: jwtMockImpl,
}));

vi.mock("jwks-rsa", () => ({
  JwksClient: class JwksClient {
    async getSigningKey(_kid: string) {
      return { getPublicKey: () => "mock-public-key" };
    }
  },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clientConstructorState.calls.length = 0;
  jwtState.verifyCalls.length = 0;
  jwtState.verifyBehavior = "success";
  jwtState.decodedHeader = { kid: "key-1" };
  jwtState.decodedPayload = { iss: "https://api.botframework.com" };
  vi.restoreAllMocks();
});

function createSdkStub(): MSTeamsTeamsSdk {
  class AppStub {
    async getBotToken() {
      return {
        toString() {
          return "bot-token";
        },
      };
    }
  }

  class ClientStub {
    constructor(serviceUrl: string, options: unknown) {
      clientConstructorState.calls.push({ serviceUrl, options });
    }

    conversations = {
      activities: (_conversationId: string) => ({
        create: async (_activity: unknown) => ({ id: "created" }),
      }),
    };
  }

  return {
    App: AppStub as unknown as MSTeamsTeamsSdk["App"],
    Client: ClientStub as unknown as MSTeamsTeamsSdk["Client"],
  };
}

describe("createMSTeamsApp", () => {
  it("does not crash with express 5 path-to-regexp (#55161)", async () => {
    // Regression test for: https://github.com/openclaw/openclaw/issues/55161
    // createMSTeamsApp passes a no-op httpServerAdapter to prevent the SDK from
    // creating its default HttpPlugin (which registers `/api*` — invalid in Express 5).
    const { App } = await import("@microsoft/teams.apps");
    const { Client } = await import("@microsoft/teams.api");
    const sdk: MSTeamsTeamsSdk = { App, Client };
    const creds: MSTeamsCredentials = {
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    // This would throw "Missing parameter name at index 5: /api*" without the fix
    const app = await createMSTeamsApp(creds, sdk);
    expect(app).toBeDefined();
    // Verify token methods are available (the reason we use the App class)
    expect(typeof (app as unknown as Record<string, unknown>).getBotToken).toBe("function");
  });
});

describe("createMSTeamsAdapter", () => {
  it("provides deleteActivity in proactive continueConversation contexts", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const creds = {
      appId: "app-id",
      appPassword: "secret",
      tenantId: "tenant-id",
    } satisfies MSTeamsCredentials;
    const sdk = createSdkStub();
    const app = new sdk.App({
      clientId: creds.appId,
      clientSecret: creds.appPassword,
      tenantId: creds.tenantId,
    });
    const adapter = createMSTeamsAdapter(app, sdk);

    await adapter.continueConversation(
      creds.appId,
      {
        serviceUrl: "https://example.com/",
        conversation: { id: "19:conversation@thread.tacv2" },
        channelId: "msteams",
      },
      async (ctx) => {
        await ctx.deleteActivity("activity-123");
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v3/conversations/19%3Aconversation%40thread.tacv2/activities/activity-123",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer bot-token",
        }),
      }),
    );
  });

  it("passes the OpenClaw User-Agent to the Bot Framework connector client", async () => {
    const creds = {
      appId: "app-id",
      appPassword: "secret",
      tenantId: "tenant-id",
    } satisfies MSTeamsCredentials;
    const sdk = createSdkStub();
    const app = new sdk.App({
      clientId: creds.appId,
      clientSecret: creds.appPassword,
      tenantId: creds.tenantId,
    });
    const adapter = createMSTeamsAdapter(app, sdk);

    await adapter.continueConversation(
      creds.appId,
      {
        serviceUrl: "https://service.example.com/",
        conversation: { id: "19:conversation@thread.tacv2" },
        channelId: "msteams",
      },
      async (ctx) => {
        await ctx.sendActivity("hello");
      },
    );

    expect(clientConstructorState.calls).toHaveLength(1);
    expect(clientConstructorState.calls[0]).toMatchObject({
      serviceUrl: "https://service.example.com/",
      options: {
        headers: {
          "User-Agent": expect.stringMatching(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/),
        },
      },
    });
  });
});

describe("createBotFrameworkJwtValidator", () => {
  const creds = {
    appId: "app-id",
    appPassword: "secret",
    tenantId: "tenant-id",
  } satisfies MSTeamsCredentials;

  it("validates a token with Bot Framework issuer and correct audience list", async () => {
    jwtState.decodedPayload = { iss: "https://api.botframework.com" };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-bf")).resolves.toBe(true);

    expect(jwtState.verifyCalls).toHaveLength(1);
    const opts = jwtState.verifyCalls[0]?.options as Record<string, unknown>;
    expect(opts.audience).toEqual(["app-id", "api://app-id", "https://api.botframework.com"]);
    expect(opts.algorithms).toEqual(["RS256"]);
    expect(opts.clockTolerance).toBe(300);
  });

  it("accepts tokens with aud: https://api.botframework.com (#58249)", async () => {
    // This is the critical fix: the old JwtValidator rejected this audience.
    jwtState.decodedPayload = { iss: "https://api.botframework.com" };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer botfw-token")).resolves.toBe(true);

    const opts = jwtState.verifyCalls[0]?.options as Record<string, unknown>;
    expect((opts.audience as string[]).includes("https://api.botframework.com")).toBe(true);
  });

  it("validates a token with Entra issuer", async () => {
    jwtState.decodedPayload = { iss: `https://login.microsoftonline.com/tenant-id/v2.0` };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-entra")).resolves.toBe(true);

    expect(jwtState.verifyCalls).toHaveLength(1);
    const opts = jwtState.verifyCalls[0]?.options as Record<string, unknown>;
    expect(opts.issuer as string[]).toContain("https://login.microsoftonline.com/tenant-id/v2.0");
  });

  it("validates a token with STS Windows issuer", async () => {
    jwtState.decodedPayload = {
      iss: "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
    };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-sts")).resolves.toBe(true);

    expect(jwtState.verifyCalls).toHaveLength(1);
    const opts = jwtState.verifyCalls[0]?.options as Record<string, unknown>;
    expect(opts.issuer as string[]).toContain(
      "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
    );
  });

  it("rejects tokens with unknown issuer", async () => {
    jwtState.decodedPayload = { iss: "https://evil.example.com" };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-evil")).resolves.toBe(false);
    expect(jwtState.verifyCalls).toHaveLength(0);
  });

  it("returns false when signature verification fails", async () => {
    jwtState.verifyBehavior = "throw";

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-bad")).resolves.toBe(false);
  });

  it("returns false for empty bearer token", async () => {
    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer ")).resolves.toBe(false);
    expect(jwtState.verifyCalls).toHaveLength(0);
  });

  it("returns false when token has no kid header", async () => {
    jwtState.decodedHeader = { kid: undefined };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer no-kid")).resolves.toBe(false);
    expect(jwtState.verifyCalls).toHaveLength(0);
  });

  it("returns false when token has no issuer claim", async () => {
    jwtState.decodedPayload = { iss: undefined };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer no-iss")).resolves.toBe(false);
    expect(jwtState.verifyCalls).toHaveLength(0);
  });
});
