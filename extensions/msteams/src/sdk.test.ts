import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBotFrameworkJwtValidator,
  createMSTeamsAdapter,
  createMSTeamsApp,
  type MSTeamsTeamsSdk,
} from "./sdk.js";
import type {
  MSTeamsCredentials,
  MSTeamsSecretCredentials,
  MSTeamsFederatedCredentials,
} from "./token.js";

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
  decodedPayload: { iss: "https://api.botframework.com" } as { iss?: string } | string | null,
  verifyResult: { sub: "ok" } as unknown,
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
    return jwtState.verifyResult;
  },
};

vi.mock("jsonwebtoken", () => ({
  // Match jsonwebtoken@9 under dynamic ESM import from plugin package deps:
  // Node exposes decode as a named export, while verify is only on default.
  decode: jwtMockImpl.decode,
  default: jwtMockImpl,
}));

vi.mock("jwks-rsa", () => ({
  JwksClient: class JwksClient {
    async getSigningKey(_kid: string) {
      return { getPublicKey: () => "mock-public-key" };
    }
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(
      () => "-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----",
    ),
  };
});

const { mockGetToken } = vi.hoisted(() => {
  const mockGetToken = vi.fn().mockResolvedValue({ token: "mock-managed-token" });
  return { mockGetToken };
});
vi.mock("@azure/identity", () => {
  // Use classes so `new ...Credential()` works after vitest hoisting
  // (function declarations inside vi.mock factories can be transformed
  // into arrow functions during hoisting, which breaks `new`).
  class ManagedIdentityCredential {
    getToken = mockGetToken;
  }
  class DefaultAzureCredential {
    getToken = mockGetToken;
  }
  class ClientCertificateCredential {
    getToken = mockGetToken;
  }
  return { ManagedIdentityCredential, DefaultAzureCredential, ClientCertificateCredential };
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clientConstructorState.calls.length = 0;
  jwtState.verifyCalls.length = 0;
  jwtState.verifyBehavior = "success";
  jwtState.decodedHeader = { kid: "key-1" };
  jwtState.decodedPayload = { iss: "https://api.botframework.com" };
  jwtState.verifyResult = { sub: "ok" };
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

function requireFirstAppInstance(appInstances: Record<string, unknown>[]) {
  const appInstance = appInstances[0];
  if (!appInstance) {
    throw new Error("expected sdk.App constructor call");
  }
  return appInstance;
}

describe("createMSTeamsApp", () => {
  it("creates app without the Express 5 wildcard route regression (#55161)", async () => {
    // Regression test for: https://github.com/openclaw/openclaw/issues/55161
    // createMSTeamsApp passes a no-op httpServerAdapter to prevent the SDK from
    // creating its default HttpPlugin (which registers `/api*` — invalid in Express 5).
    const { App } = await import("@microsoft/teams.apps");
    const { Client } = await import("@microsoft/teams.api");
    const sdk: MSTeamsTeamsSdk = { App, Client };
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    // This would throw "Missing parameter name at index 5: /api*" without the fix
    const app = await createMSTeamsApp(creds, sdk);
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
      type: "secret",
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method?: string; headers?: { Authorization?: string } },
    ];
    expect(url).toBe(
      "https://example.com/v3/conversations/19%3Aconversation%40thread.tacv2/activities/activity-123",
    );
    expect(options.method).toBe("DELETE");
    expect(options.headers?.Authorization).toBe("Bearer bot-token");
  });

  it("passes the OpenClaw User-Agent to the Bot Framework connector client", async () => {
    const creds = {
      type: "secret",
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
    const clientCall = clientConstructorState.calls[0];
    expect(clientCall?.serviceUrl).toBe("https://service.example.com/");
    const options = clientCall?.options as { headers?: { "User-Agent"?: string } } | undefined;
    expect(options?.headers?.["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/);
  });
});

describe("createBotFrameworkJwtValidator", () => {
  const creds = {
    appId: "app-id",
    type: "secret",
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
    jwtState.verifyResult = {
      aud: ["https://api.botframework.com"],
      appid: creds.appId,
    };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer botfw-token")).resolves.toBe(true);

    const opts = jwtState.verifyCalls[0]?.options as Record<string, unknown>;
    expect(opts.audience).toContain("https://api.botframework.com");
  });

  it("accepts global audience tokens when azp matches the configured app id", async () => {
    jwtState.decodedPayload = { iss: "https://api.botframework.com" };
    jwtState.verifyResult = {
      aud: ["https://api.botframework.com"],
      azp: "APP-ID",
    };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer botfw-token-azp")).resolves.toBe(true);
  });

  it("rejects global audience tokens when app binding does not match the configured app id", async () => {
    jwtState.decodedPayload = { iss: "https://api.botframework.com" };
    jwtState.verifyResult = {
      aud: ["https://api.botframework.com"],
      azp: "other-app-id",
    };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer botfw-token-wrong-app")).resolves.toBe(false);
  });

  it("rejects non-object verified payloads", async () => {
    jwtState.decodedPayload = { iss: "https://api.botframework.com" };
    jwtState.verifyResult = "verified-string-payload";

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer botfw-token-string")).resolves.toBe(false);
  });

  it("validates a token with Entra issuer", async () => {
    jwtState.decodedPayload = { iss: `https://login.microsoftonline.com/tenant-id/v2.0` };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-entra")).resolves.toBe(true);

    expect(jwtState.verifyCalls).toHaveLength(1);
    const opts = jwtState.verifyCalls[0]?.options as Record<string, unknown>;
    expect(opts.issuer as string[]).toContain("https://login.microsoftonline.com/tenant-id/v2.0");
  });

  it("validates a SingleTenant token with tenant-scoped STS Windows issuer (#64270)", async () => {
    // Regression for #64270: the sts.windows.net issuer was hardcoded to a
    // single tenant UUID, so every other SingleTenant bot deployment hit 401.
    // The tenant-aware form must accept the deployment's own tenant.
    jwtState.decodedPayload = {
      iss: `https://sts.windows.net/${creds.tenantId}/`,
    };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-sts")).resolves.toBe(true);

    expect(jwtState.verifyCalls).toHaveLength(1);
    const opts = jwtState.verifyCalls[0]?.options as Record<string, unknown>;
    expect(opts.issuer as string[]).toContain(`https://sts.windows.net/${creds.tenantId}/`);
  });

  it("rejects STS Windows tokens issued by a different tenant (#64270)", async () => {
    // Guardrail against regressing back to a hardcoded tenant: the previously
    // hardcoded UUID must NOT be accepted when the bot is configured for a
    // different tenant. This also prevents cross-tenant token reuse.
    jwtState.decodedPayload = {
      iss: "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
    };

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-sts-other-tenant")).resolves.toBe(false);
    expect(jwtState.verifyCalls).toHaveLength(0);
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

  it("rethrows JWKS network errors (ECONNREFUSED) instead of silently returning false (#77674)", async () => {
    // Simulate a firewall blocking egress to login.botframework.com.
    // The top-level vi.mock("jwks-rsa") sets up a class-level mock, so we spy
    // on the prototype to override getSigningKey for this test only.
    const networkErr = Object.assign(new Error("connect ECONNREFUSED 40.126.25.32:443"), {
      code: "ECONNREFUSED",
    });
    const { JwksClient } = await import("jwks-rsa");
    vi.spyOn(JwksClient.prototype, "getSigningKey").mockRejectedValueOnce(networkErr);

    jwtState.decodedPayload = { iss: "https://api.botframework.com" };
    const validator = await createBotFrameworkJwtValidator(creds);
    // Network errors must bubble out — callers can then log them at warn/error
    // level rather than silently returning 401 that looks like a bad credential.
    await expect(validator.validate("Bearer token-firewall")).rejects.toThrow("ECONNREFUSED");
  });

  it("returns false (not throws) for non-network JWKS errors like bad signature (#77674)", async () => {
    // Auth errors (bad signature, expired token) should still return false.
    jwtState.decodedPayload = { iss: "https://api.botframework.com" };
    jwtState.verifyBehavior = "throw";
    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-bad-sig")).resolves.toBe(false);
  });
});

function makeFakeSdk() {
  const appInstances: Record<string, unknown>[] = [];
  const FakeClient = function FakeClient() {};
  const FakeApp = class {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      appInstances.push(opts);
    }
  };
  return { sdk: { App: FakeApp as any, Client: FakeClient as any }, appInstances, FakeApp };
}

describe("createMSTeamsApp – secret credentials", () => {
  it("passes clientId, clientSecret, tenantId to sdk.App", async () => {
    const { sdk, appInstances, FakeApp } = makeFakeSdk();
    const creds: MSTeamsSecretCredentials = {
      type: "secret",
      appId: "my-app-id",
      appPassword: "my-secret",
      tenantId: "my-tenant",
    };
    const app = await createMSTeamsApp(creds, sdk);
    expect(app).toBeInstanceOf(FakeApp);
    const appInstance = requireFirstAppInstance(appInstances);
    expect(appInstance.clientId).toBe("my-app-id");
    expect(appInstance.clientSecret).toBe("my-secret");
    expect(appInstance.tenantId).toBe("my-tenant");
  });
});

describe("createMSTeamsApp – federated certificate credentials", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      "-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----",
    );
  });

  it("reads the certificate and creates app with token function", async () => {
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "fed-app-id",
      tenantId: "fed-tenant",
      certificatePath: "/certs/bot.pem",
      certificateThumbprint: "AABB1122",
    };
    await createMSTeamsApp(creds, sdk);
    expect(fs.readFileSync).toHaveBeenCalledWith("/certs/bot.pem", "utf-8");
    const appInstance = requireFirstAppInstance(appInstances);
    expect(appInstance.clientId).toBe("fed-app-id");
    expect(appInstance.tenantId).toBe("fed-tenant");
    const tokenProvider = appInstance.token as ((scope: string) => Promise<string>) | undefined;
    if (!tokenProvider) {
      throw new Error("expected federated app to expose token provider");
    }
    const token = await tokenProvider("https://api.botframework.com/.default");
    expect(token).toBe("mock-managed-token");
  });

  it("wraps readFileSync errors with descriptive message", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const { sdk } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "fed-app-id",
      tenantId: "fed-tenant",
      certificatePath: "/missing/cert.pem",
    };
    await expect(async () => await createMSTeamsApp(creds, sdk)).rejects.toThrow(
      /Failed to read certificate file at '\/missing\/cert\.pem'/,
    );
  });

  it("throws when federated but no certificatePath and no managedIdentity", async () => {
    const { sdk } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "fed-app-id",
      tenantId: "fed-tenant",
    };
    await expect(async () => await createMSTeamsApp(creds, sdk)).rejects.toThrow(
      /certificate path or managed identity/i,
    );
  });
});

describe("createMSTeamsApp – federated managed identity", () => {
  it("creates app with token function for user-assigned MI", async () => {
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "mi-app-id",
      tenantId: "mi-tenant",
      useManagedIdentity: true,
      managedIdentityClientId: "mi-client-id",
    };
    await createMSTeamsApp(creds, sdk);
    const appInstance = requireFirstAppInstance(appInstances);
    expect(appInstance.clientId).toBe("mi-app-id");
    expect(appInstance.tenantId).toBe("mi-tenant");
    const tokenProvider = appInstance.token as ((scope: string) => Promise<string>) | undefined;
    if (!tokenProvider) {
      throw new Error("expected managed-identity app to expose token provider");
    }
    const token = await tokenProvider("https://api.botframework.com/.default");
    expect(token).toBe("mock-managed-token");
  });

  it("creates app with token function for system-assigned MI", async () => {
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "mi-app-id",
      tenantId: "mi-tenant",
      useManagedIdentity: true,
    };
    await createMSTeamsApp(creds, sdk);
    const tokenProvider = appInstances[0].token as ((scope: string) => Promise<string>) | undefined;
    if (!tokenProvider) {
      throw new Error("expected managed-identity app to expose token provider");
    }
    const token = await tokenProvider("https://api.botframework.com/.default");
    expect(token).toBe("mock-managed-token");
  });

  it("throws from token function when token acquisition fails", async () => {
    mockGetToken.mockResolvedValueOnce(null);
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "mi-app-id",
      tenantId: "mi-tenant",
      useManagedIdentity: true,
    };
    await createMSTeamsApp(creds, sdk);
    const tokenFn = appInstances[0].token as (scope: string) => Promise<string>;
    await expect(tokenFn("https://api.botframework.com/.default")).rejects.toThrow(
      /failed to acquire token/i,
    );
  });
});

// ── createMSTeamsAdapter tests ─────────────────────────────────────────────

function makeFakeApp() {
  return {
    getBotToken: vi.fn().mockResolvedValue({ toString: () => "fake-bot-token" }),
  } as any;
}

function makeFakeApiSdk() {
  const createFn = vi.fn().mockResolvedValue({ id: "new-activity-id" });
  const FakeApp = function FakeApp() {};
  const FakeClient = class {
    conversations = {
      activities: (_convId: string) => ({ create: createFn }),
    };
  };
  return {
    sdk: { App: FakeApp as any, Client: FakeClient as any },
    createFn,
  };
}

describe("createMSTeamsAdapter – continueConversation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("provides sendActivity via REST API client in logic callback", async () => {
    const { sdk, createFn } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const reference = {
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      conversation: { id: "conv-123", conversationType: "personal" },
      channelId: "msteams",
    };

    await adapter.continueConversation("app-id", reference, async (ctx) => {
      await ctx.sendActivity("hello from proactive send");
    });

    expect(createFn).toHaveBeenCalledTimes(1);
    const activity = createFn.mock.calls[0]?.[0] as { type?: string; text?: string } | undefined;
    expect(activity?.type).toBe("message");
    expect(activity?.text).toBe("hello from proactive send");
  });

  it("provides deleteActivity via REST DELETE in logic callback", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const reference = {
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      conversation: { id: "conv-456", conversationType: "personal" },
      channelId: "msteams",
    };

    await adapter.continueConversation("app-id", reference, async (ctx) => {
      await ctx.deleteActivity("activity-789");
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/v3/conversations/conv-456/activities/activity-789");
    expect(opts.method).toBe("DELETE");
    expect(opts.headers.Authorization).toBe("Bearer fake-bot-token");
  });

  it("throws when serviceUrl is missing", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    await expect(
      adapter.continueConversation("app-id", { conversation: { id: "c" } } as any, async () => {}),
    ).rejects.toThrow(/Missing serviceUrl/);
  });

  it("throws when conversation.id is missing", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    await expect(
      adapter.continueConversation(
        "app-id",
        { serviceUrl: "https://example.com" } as any,
        async () => {},
      ),
    ).rejects.toThrow(/Missing conversation\.id/);
  });
});

describe("createMSTeamsAdapter – process", () => {
  it("sends 200 for normal message activities", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const req = { body: { type: "message", text: "hi" } };
    const sendFn = vi.fn();
    const res = { status: vi.fn(() => ({ send: sendFn })) };

    await adapter.process(req, res, async () => {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendFn).toHaveBeenCalled();
  });

  it("sends 200 immediately for invoke activities", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const req = { body: { type: "invoke", name: "adaptiveCard/action" } };
    const sendFn = vi.fn();
    const res = { status: vi.fn(() => ({ send: sendFn })) };

    let statusCalledBeforeLogic = false;
    await adapter.process(req, res, async () => {
      statusCalledBeforeLogic = res.status.mock.calls.length > 0;
    });

    expect(statusCalledBeforeLogic).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
