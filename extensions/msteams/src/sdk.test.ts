// Msteams tests cover sdk plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMSTeamsQaBotFrameworkServer } from "./qa/bot-framework-server.js";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";

const privateQaRuntimeSymbol = Symbol.for("openclaw.msteams.privateQaRuntime");
const privateQaBotToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ appid: "test-app-id", tid: "test-tenant" })).toString("base64url"),
  "qa",
].join(".");

const { readSecretFile } = vi.hoisted(() => ({
  readSecretFile: vi
    .fn<(filePath: string, label: string) => Promise<string>>()
    .mockResolvedValue("-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----"),
}));

vi.mock("openclaw/plugin-sdk/secret-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/secret-file")>();
  return {
    ...actual,
    readSecretFile,
  };
});

const { mockGetToken } = vi.hoisted(() => {
  const mockGetTokenLocal = vi.fn().mockResolvedValue({ token: "mock-managed-token" });
  return { mockGetToken: mockGetTokenLocal };
});
vi.mock("@azure/identity", () => {
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

afterEach(() => {
  vi.unstubAllEnvs();
  delete (
    globalThis as typeof globalThis & {
      [privateQaRuntimeSymbol]?: unknown;
    }
  )[privateQaRuntimeSymbol];
  vi.restoreAllMocks();
  readSecretFile
    .mockReset()
    .mockResolvedValue("-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----");
});

async function createMSTeamsApp(...args: Parameters<typeof loadMSTeamsSdkWithAuth>) {
  return (await loadMSTeamsSdkWithAuth(...args)).app;
}

describe("createMSTeamsApp", () => {
  it("does not crash with express 5 path-to-regexp (#55161)", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
    expect(app.tokenManager).toBeDefined();
  });

  it("creates app with secret credentials", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",

      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
  });

  it("keeps private QA App options absent in production", async () => {
    const app = await createMSTeamsApp({
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    });
    const options = (app as unknown as { options?: Record<string, unknown> }).options;
    expect(options?.skipAuth).toBeUndefined();
    expect(options?.token).toBeUndefined();
  });

  it("passes the complete private QA bootstrap into the SDK App", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("CLIENT_SECRET", "ambient-private-qa-secret");
    (
      globalThis as typeof globalThis & {
        [privateQaRuntimeSymbol]?: {
          connectorUrl: string;
          nonce: string;
          botToken: string;
        };
      }
    )[privateQaRuntimeSymbol] = {
      connectorUrl: "http://127.0.0.1:43123/",
      nonce: "qa-nonce",
      botToken: privateQaBotToken,
    };

    const app = await createMSTeamsApp({
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    });
    const options = (app as unknown as { options?: Record<string, unknown> }).options;
    expect(options?.skipAuth).toBe(true);
    expect(options?.clientSecret).toBe("");
    expect(options?.client).toEqual(expect.objectContaining({ clone: expect.any(Function) }));
    expect(options?.token).toEqual(expect.any(Function));
    const token = options?.token;
    if (typeof token !== "function") {
      throw new Error("expected private QA token factory");
    }
    await expect(token()).resolves.toBe(privateQaBotToken);
    const credentials = (
      app as unknown as {
        credentials?: Record<string, unknown>;
      }
    ).credentials;
    expect(credentials).toMatchObject({
      clientId: "test-app-id",
      token: expect.any(Function),
    });
    expect(credentials).not.toHaveProperty("clientSecret");
    expect(String(await app.tokenManager.getBotToken())).toBe(privateQaBotToken);
  });

  it("routes a private QA proactive send through the loopback Connector", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("CLIENT_SECRET", "ambient-private-qa-secret");
    const outbound: Array<{
      activity: Record<string, unknown>;
      activityId: string;
      conversationId: string;
      threadId?: string;
    }> = [];
    const connector = await startMSTeamsQaBotFrameworkServer({
      botToken: privateQaBotToken,
      nonce: "qa-nonce",
      onOutbound: async (activity) => {
        outbound.push(activity);
      },
    });
    (
      globalThis as typeof globalThis & {
        [privateQaRuntimeSymbol]?: {
          connectorUrl: string;
          nonce: string;
          botToken: string;
        };
      }
    )[privateQaRuntimeSymbol] = {
      connectorUrl: connector.baseUrl,
      nonce: "qa-nonce",
      botToken: privateQaBotToken,
    };

    try {
      const app = await createMSTeamsApp({
        type: "secret",
        appId: "test-app-id",
        appPassword: "test-secret",
        tenantId: "test-tenant",
      });
      const result = await sendMSTeamsActivityWithReference(
        app,
        {
          serviceUrl: "https://smba.trafficmanager.net/qa",
          agent: { id: "test-app-id", name: "OpenClaw QA", role: "bot" },
          user: { id: "qa-driver" },
          conversation: {
            id: "19:qa-primary@thread.tacv2",
            conversationType: "channel",
            tenantId: "test-tenant",
          },
          channelId: "msteams",
        },
        { type: "message", text: "qa outbound" },
        { threadActivityId: "thread-root" },
      );

      expect(result.id).toMatch(/^qa-outbound-/u);
      expect(outbound).toEqual([
        {
          activity: expect.objectContaining({
            type: "message",
            text: "qa outbound",
          }),
          activityId: result.id,
          conversationId: "19:qa-primary@thread.tacv2",
          threadId: "thread-root",
        },
      ]);
    } finally {
      await connector.close();
    }
  });

  it("creates app with federated certificate credentials", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      certificatePath: "/path/to/cert.pem",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
    expect(readSecretFile).toHaveBeenCalledWith("/path/to/cert.pem", "Microsoft Teams certificate");
  });

  it("throws when certificate file is missing", async () => {
    readSecretFile.mockRejectedValue(new Error("ENOENT: no such file"));

    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      certificatePath: "/bad/path.pem",
    };

    await expect(createMSTeamsApp(creds)).rejects.toThrow("Failed to read certificate file");
  });

  it("creates app with managed identity credentials", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",

      appId: "test-app-id",
      tenantId: "test-tenant",

      useManagedIdentity: true,
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
  });

  it("creates app with user-assigned managed identity", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      useManagedIdentity: true,
      managedIdentityClientId: "custom-mi-id",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
  });

  it("throws when federated credentials lack certificate and managed identity", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
    };

    await expect(createMSTeamsApp(creds)).rejects.toThrow(
      "Federated credentials require either a certificate path or managed identity",
    );
  });

  it("preserves both Teams SDK and OpenClaw User-Agent fragments", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds);
    const headers = (
      app as unknown as { client?: { options?: { headers?: Record<string, string> } } }
    ).client?.options?.headers;

    expect(headers?.["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/\S+ OpenClaw\/\S+$/);
  });

  it("bounds Teams SDK API requests", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds);
    const timeout = (app as unknown as { client?: { options?: { timeout?: number } } }).client
      ?.options?.timeout;

    expect(timeout).toBe(30_000);
  });

  it("accepts custom messagingEndpoint", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds, {
      messagingEndpoint: "/custom/webhook",
    });
    expect(app).toBeDefined();
  });

  it("passes configured cloud and serviceUrl to the SDK App", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds, {
      cloud: "USGov",
      serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams/",
    });

    const internals = app as unknown as {
      api?: { serviceUrl?: string };
      cloud?: { botScope?: string; graphScope?: string };
    };
    expect(internals.api?.serviceUrl).toBe("https://smba.infra.gov.teams.microsoft.us/teams");
    expect(internals.cloud?.botScope).toBe("https://api.botframework.us/.default");
    expect(internals.cloud?.graphScope).toBe("https://graph.microsoft.us/.default");
  });

  it("passes China cloud to the SDK App without requiring a configured serviceUrl", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds, {
      cloud: "China",
    });

    const internals = app as unknown as {
      api?: { serviceUrl?: string };
      cloud?: { botScope?: string; graphScope?: string };
    };
    // @microsoft/teams.apps still gives app-level sends its public serviceUrl
    // default. OpenClaw proactive sends use stored reference serviceUrls instead.
    expect(internals.api?.serviceUrl).toBe("https://smba.trafficmanager.net/teams");
    expect(internals.cloud?.botScope).toBe("https://api.botframework.azure.cn/.default");
    expect(internals.cloud?.graphScope).toBe("https://microsoftgraph.chinacloudapi.cn/.default");
  });

  it("fails closed for Graph tokens when China cloud is configured", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };
    const app = await createMSTeamsApp(creds, { cloud: "China" });
    const tokenProvider = createMSTeamsTokenProvider(app);

    await expect(tokenProvider.getAccessToken("https://graph.microsoft.com")).rejects.toThrow(
      /Graph operations are not supported .*cloud=China/,
    );
  });

  it("rejects configured serviceUrls outside the Bot Framework allowlist", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    await expect(
      createMSTeamsApp(creds, {
        serviceUrl: "https://attacker.example.com/teams/",
      }),
    ).rejects.toThrow(/Blocked Microsoft Teams serviceUrl host: attacker\.example\.com/);
  });

  it("uses the configured cloud serviceUrl for proactive HTTP posts", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };
    const post = vi.fn(async () => ({ data: { id: "sent-1" } }));
    const httpClient = {
      request: vi.fn(),
      post,
      clone: vi.fn(() => httpClient),
    };

    const app = await createMSTeamsApp(creds, {
      cloud: "USGov",
      serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams",
      httpClient,
    });

    await app.send("19:conversation@thread.tacv2", { type: "message", text: "hello" });

    expect(post).toHaveBeenCalledWith(
      "https://smba.infra.gov.teams.microsoft.us/teams/v3/conversations/19:conversation@thread.tacv2/activities",
      expect.objectContaining({
        type: "message",
        text: "hello",
        conversation: { id: "19:conversation@thread.tacv2" },
      }),
    );
  });
});

describe("createMSTeamsTokenProvider", () => {
  function createMockApp() {
    return {
      tokenManager: {
        getBotToken: async () => ({ toString: () => "bot-token" }),
        getGraphToken: async () => ({ toString: () => "graph-token" }),
      },
    } as unknown as import("./sdk.js").MSTeamsApp;
  }

  it("returns bot token for bot framework scope", async () => {
    const app = createMockApp();
    const provider = createMSTeamsTokenProvider(app);

    const token = await provider.getAccessToken("https://api.botframework.com");
    expect(token).toBe("bot-token");
  });

  it("returns graph token for graph scope", async () => {
    const app = createMockApp();
    const provider = createMSTeamsTokenProvider(app);

    const token = await provider.getAccessToken("https://graph.microsoft.com");
    expect(token).toBe("graph-token");
  });

  it("returns empty string when token is null", async () => {
    const app = {
      tokenManager: {
        getBotToken: async () => null,
        getGraphToken: async () => null,
      },
    } as unknown as import("./sdk.js").MSTeamsApp;
    const provider = createMSTeamsTokenProvider(app);

    expect(await provider.getAccessToken("https://api.botframework.com")).toBe("");
    expect(await provider.getAccessToken("https://graph.microsoft.com")).toBe("");
  });
});
