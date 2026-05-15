import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia, sendGoogleChatMessage } from "./api.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
} from "./targets.js";

const mocks = vi.hoisted(() => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist: vi.fn((hosts: string[]) => ({
    hostnameAllowlist: hosts,
  })),
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init?: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: async () => {},
  })),
  googleAuthCtor: vi.fn(),
  gaxiosCtor: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue({ token: "access-token" }),
  oauthCtor: vi.fn(),
  verifySignedJwtWithCertsAsync: vi.fn(),
  verifyIdToken: vi.fn(),
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => {
  return {
    buildHostnameAllowlistPolicyFromSuffixAllowlist:
      mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("gaxios", () => ({
  Gaxios: class {
    defaults: unknown;
    interceptors = {
      request: { add: vi.fn() },
      response: { add: vi.fn() },
    };

    constructor(defaults?: unknown) {
      this.defaults = defaults;
      mocks.gaxiosCtor(defaults);
    }
  },
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(options?: unknown) {
      mocks.googleAuthCtor(options);
    }

    getClient = vi.fn().mockResolvedValue({
      getAccessToken: mocks.getAccessToken,
    });
  },
  OAuth2Client: class {
    constructor(options?: unknown) {
      mocks.oauthCtor(options);
    }

    verifyIdToken = mocks.verifyIdToken;
    verifySignedJwtWithCertsAsync = mocks.verifySignedJwtWithCertsAsync;
  },
}));

vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return {
    ...actual,
    getGoogleChatAccessToken: mocks.getGoogleChatAccessToken,
  };
});

const authActual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
const { __testing: authTesting, getGoogleChatAccessToken, verifyGoogleChatRequest } = authActual;

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("gaxios");
  vi.doUnmock("google-auth-library");
  vi.doUnmock("./auth.js");
  vi.resetModules();
});

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

function stubSuccessfulSend(name: string) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ name }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function expectDownloadToRejectForResponse(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(
    downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
  ).rejects.toThrow(/max bytes/i);
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

describe("normalizeGoogleChatTarget", () => {
  it("normalizes provider prefixes", () => {
    expect(normalizeGoogleChatTarget("googlechat:users/123")).toBe("users/123");
    expect(normalizeGoogleChatTarget("google-chat:spaces/AAA")).toBe("spaces/AAA");
    expect(normalizeGoogleChatTarget("gchat:user:User@Example.com")).toBe("users/user@example.com");
  });

  it("normalizes email targets to users/<email>", () => {
    expect(normalizeGoogleChatTarget("User@Example.com")).toBe("users/user@example.com");
    expect(normalizeGoogleChatTarget("users/User@Example.com")).toBe("users/user@example.com");
  });

  it("preserves space targets", () => {
    expect(normalizeGoogleChatTarget("space:spaces/BBB")).toBe("spaces/BBB");
    expect(normalizeGoogleChatTarget("spaces/CCC")).toBe("spaces/CCC");
  });
});

describe("target helpers", () => {
  it("detects user and space targets", () => {
    expect(isGoogleChatUserTarget("users/abc")).toBe(true);
    expect(isGoogleChatSpaceTarget("spaces/abc")).toBe(true);
    expect(isGoogleChatUserTarget("spaces/abc")).toBe(false);
  });
});

describe("googlechat group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        googlechat: {
          groups: {
            "spaces/AAA": {
              requireMention: false,
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
    } as any;

    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/AAA" })).toBe(false);
    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/BBB" })).toBe(true);
  });
});

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
    authTesting.resetGoogleChatAuthForTests();
    mocks.fetchWithSsrFGuard.mockClear();
    vi.unstubAllGlobals();
  });

  it("rejects when content-length exceeds max bytes", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "50", "content-type": "application/octet-stream" },
    });
    await expectDownloadToRejectForResponse(response);
  });

  it("rejects when streamed payload exceeds max bytes", async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    await expectDownloadToRejectForResponse(response);
  });
});

describe("sendGoogleChatMessage", () => {
  afterEach(() => {
    authTesting.resetGoogleChatAuthForTests();
    mocks.fetchWithSsrFGuard.mockClear();
    vi.unstubAllGlobals();
  });

  it("adds messageReplyOption when sending to an existing thread", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/123");

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
      thread: "spaces/AAA/threads/xyz",
    });

    const url = mockCallArg(fetchMock);
    const init = mockCallArg(fetchMock, 0, 1) as RequestInit | undefined;
    expect(String(url)).toContain("messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    if (typeof init?.body !== "string") {
      throw new Error("Expected Google Chat request body");
    }
    const body = JSON.parse(init.body) as {
      text?: unknown;
      thread?: { name?: unknown };
    };
    expect(body.text).toBe("hello");
    expect(body.thread?.name).toBe("spaces/AAA/threads/xyz");
  });

  it("does not set messageReplyOption for non-thread sends", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/124");

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
    });

    const url = mockCallArg(fetchMock);
    expect(String(url)).not.toContain("messageReplyOption=");
  });

  it("reports malformed send JSON with a stable API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{ nope", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      sendGoogleChatMessage({
        account,
        space: "spaces/AAA",
        text: "hello",
      }),
    ).rejects.toThrow("Google Chat API request failed: malformed JSON response");
  });
});

function mockTicket(payload: Record<string, unknown>) {
  mocks.verifyIdToken.mockResolvedValue({
    getPayload: () => payload,
  });
}

describe("verifyGoogleChatRequest", () => {
  afterEach(() => {
    authTesting.resetGoogleChatAuthForTests();
    mocks.getAccessToken.mockClear();
    mocks.gaxiosCtor.mockClear();
    mocks.googleAuthCtor.mockClear();
    mocks.oauthCtor.mockClear();
  });

  it("injects a scoped transporter into GoogleAuth access-token clients", async () => {
    await expect(
      getGoogleChatAccessToken({
        ...account,
        credentials: {
          auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "key",
          token_uri: "https://oauth2.googleapis.com/token",
          type: "service_account",
          universe_domain: "googleapis.com",
        },
      }),
    ).resolves.toBe("access-token");

    const googleAuthOptions = mockCallArg(mocks.googleAuthCtor) as {
      clientOptions?: { transporter?: { defaults?: { fetchImplementation?: unknown } } };
      credentials?: { client_email?: string; token_uri?: string };
    };

    expect(mocks.gaxiosCtor).toHaveBeenCalledOnce();
    expect(googleAuthOptions.credentials?.client_email).toBe("bot@example.iam.gserviceaccount.com");
    expect(googleAuthOptions.credentials?.token_uri).toBe("https://oauth2.googleapis.com/token");
    expect(typeof googleAuthOptions.clientOptions?.transporter?.defaults?.fetchImplementation).toBe(
      "function",
    );
    expect(mocks.getAccessToken).toHaveBeenCalledOnce();
    expect("window" in globalThis).toBe(false);
  });

  it("accepts Google Chat app-url tokens from the Chat issuer", async () => {
    mocks.verifyIdToken.mockReset();
    mockTicket({
      email: "chat@system.gserviceaccount.com",
      email_verified: true,
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      }),
    ).resolves.toEqual({ ok: true });

    const oauthOptions = mockCallArg(mocks.oauthCtor) as {
      transporter?: { defaults?: { fetchImplementation?: unknown } };
    };
    expect(typeof oauthOptions.transporter?.defaults?.fetchImplementation).toBe("function");
  });

  it("rejects add-on tokens when no principal binding is configured", async () => {
    mocks.verifyIdToken.mockReset();
    mockTicket({
      email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      email_verified: true,
      sub: "principal-1",
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "missing add-on principal binding",
    });
  });

  it("accepts add-on tokens only when the bound principal matches", async () => {
    mocks.verifyIdToken.mockReset();
    mockTicket({
      email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      email_verified: true,
      sub: "principal-1",
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
        expectedAddOnPrincipal: "principal-1",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects add-on tokens when the bound principal does not match", async () => {
    mocks.verifyIdToken.mockReset();
    mockTicket({
      email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      email_verified: true,
      sub: "principal-2",
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
        expectedAddOnPrincipal: "principal-1",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "unexpected add-on principal: principal-2",
    });
  });

  it("fetches Chat certs through the guarded fetch for project-number tokens", async () => {
    const release = vi.fn();
    mocks.fetchWithSsrFGuard.mockClear();
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ "kid-1": "cert-body" }), { status: 200 }),
      release,
    });
    mocks.verifySignedJwtWithCertsAsync.mockReset().mockResolvedValue(undefined);

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "project-number",
        audience: "123456789",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      url: "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com",
      auditContext: "googlechat.auth.certs",
    });
    expect(mocks.verifySignedJwtWithCertsAsync).toHaveBeenCalledWith(
      "token",
      { "kid-1": "cert-body" },
      "123456789",
      ["chat@system.gserviceaccount.com"],
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports malformed Chat cert JSON with a stable auth error", async () => {
    authTesting.resetGoogleChatAuthForTests();
    const release = vi.fn(async () => {});
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "project-number",
        audience: "123456789",
      }),
    ).rejects.toThrow("Google Chat cert fetch failed: malformed JSON response");
    expect(release).toHaveBeenCalledOnce();
  });
});
