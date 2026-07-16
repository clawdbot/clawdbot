// Googlechat tests cover targets plugin behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia, sendGoogleChatMessage, updateGoogleChatMessage } from "./api.js";
import {
  registerGoogleChatManualApprovalFollowupSuppression,
  unregisterGoogleChatManualApprovalFollowupSuppression,
} from "./approval-card-actions.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";
import {
  isGoogleChatGroupSpace,
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSessionRoute,
} from "./targets.js";

const mocks = vi.hoisted(() => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist: vi.fn((hosts: string[]) => ({
    hostnameAllowlist: hosts,
  })),
  fetchWithSsrFGuard: vi.fn(
    async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => ({
      response: await fetch(params.url, params.init),
      release: async () => {},
    }),
  ),
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

vi.mock("google-auth-library", () => ({
  gaxios: {
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
  },
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
const { getGoogleChatAccessToken, verifyGoogleChatRequest } = authActual;

let googleChatCertFetchNowMs = Date.now();

function expireGoogleChatCertCache(): void {
  googleChatCertFetchNowMs += 11 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(googleChatCertFetchNowMs);
}

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("google-auth-library");
  vi.doUnmock("./auth.js");
  vi.resetModules();
});

let accountCounter = 0;
let account = {
  accountId: "test-0",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

beforeEach(() => {
  accountCounter += 1;
  account = { ...account, accountId: `test-${accountCounter}` };
});

function stubSuccessfulSend(name: string, threadName?: string) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ name, ...(threadName ? { thread: { name: threadName } } : {}) }),
      {
        status: 200,
      },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function createStalledResponse(status = 200): Response {
  return new Response(
    new ReadableStream({
      start() {},
    }),
    { status },
  );
}

async function expectDownloadToRejectForResponse(
  response: Response,
  expected: string | RegExp = /max bytes/i,
) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(
    downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
  ).rejects.toThrow(expected);
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function lastGuardedFetchOptions(): { timeoutMs?: number } {
  const call = mocks.fetchWithSsrFGuard.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected guarded fetch call");
  }
  return call[0] as { timeoutMs?: number };
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

  it("classifies current and legacy space metadata through the group boundary", () => {
    expect(isGoogleChatGroupSpace({ spaceType: "DIRECT_MESSAGE", type: "ROOM" })).toBe(false);
    expect(isGoogleChatGroupSpace({ spaceType: "SPACE", type: "DM" })).toBe(true);
    expect(isGoogleChatGroupSpace({ singleUserBotDm: true })).toBe(false);
    expect(isGoogleChatGroupSpace({ type: "ROOM" })).toBe(true);
    expect(isGoogleChatGroupSpace({})).toBe(true);
  });
});

describe("outbound session routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { spaceType: "DIRECT_MESSAGE", chatType: "direct", peerKind: "direct" },
    { spaceType: "SPACE", chatType: "group", peerKind: "group" },
  ] as const)("classifies API space type $spaceType", async ({ spaceType, chatType, peerKind }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ name: "spaces/AAA", spaceType }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const route = await resolveGoogleChatOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "googlechat:spaces/AAA",
    });

    expect(route).toMatchObject({
      peer: { kind: peerKind, id: "spaces/AAA" },
      chatType,
      from: "googlechat:spaces/AAA",
      to: "spaces/AAA",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://chat.googleapis.com/v1/spaces/AAA", {
      method: "GET",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    });
  });

  it("rejects an unclassified space response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ name: "spaces/AAA" }), { status: 200 })),
    );

    await expect(
      resolveGoogleChatOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: "spaces/AAA",
      }),
    ).resolves.toBeNull();
  });

  it("keeps session-route classification failures non-fatal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("read unavailable")));

    await expect(
      resolveGoogleChatOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: "spaces/AAA",
      }),
    ).resolves.toBeNull();
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
    } as OpenClawConfig;

    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/AAA" })).toBe(false);
    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/BBB" })).toBe(true);
  });
});

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
    unregisterGoogleChatManualApprovalFollowupSuppression("12345678-1234-1234-1234-123456789012");
    mocks.fetchWithSsrFGuard.mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    expect(lastGuardedFetchOptions().timeoutMs).toBe(30_001);
  });

  it("rejects malformed content-length before reading media", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": "0x3",
        "content-type": "application/octet-stream",
      }),
      arrayBuffer,
    } as unknown as Response;

    await expectDownloadToRejectForResponse(response, "invalid content-length header: 0x3");
    expect(arrayBuffer).not.toHaveBeenCalled();
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

  it("cancels a media body that stops producing chunks", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStalledResponse()));

    const result = expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow("Media download stalled: no data received for 30000ms");
    await vi.advanceTimersByTimeAsync(30_001);
    await result;
  });

  it("cancels a stalled media error body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStalledResponse(500)));

    const result = expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow("Google Chat API error response stalled after 30000ms");
    await vi.advanceTimersByTimeAsync(30_001);
    await result;
  });
});

describe("supported Google Chat request bounds", () => {
  afterEach(() => {
    mocks.fetchWithSsrFGuard.mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("derives a bounded transfer deadline from the payload size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    );

    await downloadGoogleChatMedia({
      account,
      resourceName: "media/123",
      maxBytes: 1024 * 1024,
    });

    expect(lastGuardedFetchOptions().timeoutMs).toBe(34_000);
  });

  it("cancels a stalled JSON response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStalledResponse()));

    const result = expect(
      sendGoogleChatMessage({
        account,
        space: "spaces/AAA",
        text: "hello",
      }),
    ).rejects.toThrow("Google Chat API request failed: response body stalled after 30000ms");
    await vi.advanceTimersByTimeAsync(30_001);
    await result;
  });
});

describe("sendGoogleChatMessage", () => {
  afterEach(() => {
    mocks.fetchWithSsrFGuard.mockClear();
    vi.unstubAllGlobals();
  });

  it("adds messageReplyOption when sending to an existing thread", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/123", "spaces/AAA/threads/xyz");

    const result = await sendGoogleChatMessage({
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
    expect(result).toEqual({
      messageName: "spaces/AAA/messages/123",
      threadName: "spaces/AAA/threads/xyz",
    });
    expect(lastGuardedFetchOptions().timeoutMs).toBe(30_000);
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

  it("sends cardsV2 with the text fallback", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/125");
    const cardsV2 = [
      {
        cardId: "approval",
        card: {
          header: { title: "Approval" },
          sections: [{ widgets: [{ textParagraph: { text: "Approve?" } }] }],
        },
      },
    ];

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "Approval required",
      cardsV2,
    });

    const init = mockCallArg(fetchMock, 0, 1) as RequestInit | undefined;
    if (typeof init?.body !== "string") {
      throw new Error("Expected Google Chat request body");
    }
    expect(JSON.parse(init.body)).toEqual({
      text: "Approval required",
      cardsV2,
    });
  });

  it("suppresses text-only duplicate manual approval follow-ups at the API send boundary", async () => {
    registerGoogleChatManualApprovalFollowupSuppression({
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      expiresAtMs: Date.now() + 60_000,
    });

    const result = await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "Please reply with:\n/approve 12345678 allow-once",
    });

    expect(result).toBeNull();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
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

describe("updateGoogleChatMessage", () => {
  afterEach(() => {
    mocks.fetchWithSsrFGuard.mockClear();
    vi.unstubAllGlobals();
  });

  it("updates text and cardsV2 with a matching update mask", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/123");
    const cardsV2 = [
      {
        cardId: "approval",
        card: {
          header: { title: "Resolved" },
          sections: [{ widgets: [{ textParagraph: { text: "Done" } }] }],
        },
      },
    ];

    await updateGoogleChatMessage({
      account,
      messageName: "spaces/AAA/messages/123",
      text: "Resolved",
      cardsV2,
    });

    expect(String(mockCallArg(fetchMock))).toContain(
      "spaces/AAA/messages/123?updateMask=text,cardsV2",
    );
    const init = mockCallArg(fetchMock, 0, 1) as RequestInit | undefined;
    if (typeof init?.body !== "string") {
      throw new Error("Expected Google Chat request body");
    }
    expect(JSON.parse(init.body)).toEqual({ text: "Resolved", cardsV2 });
  });
});

function mockTicket(payload: Record<string, unknown>) {
  mocks.verifyIdToken.mockResolvedValue({
    getPayload: () => payload,
  });
}

describe("verifyGoogleChatRequest", () => {
  afterEach(() => {
    mocks.getAccessToken.mockClear();
    mocks.gaxiosCtor.mockClear();
    mocks.googleAuthCtor.mockClear();
    mocks.oauthCtor.mockClear();
    vi.restoreAllMocks();
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
    expireGoogleChatCertCache();
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
      timeoutMs: 30_000,
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
    expireGoogleChatCertCache();
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
    ).resolves.toEqual({
      ok: false,
      reason: "Google Chat cert fetch failed: malformed JSON response",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  describe("bounded JSON read (readProviderJsonResponse delegation)", () => {
    afterEach(() => {
      mocks.fetchWithSsrFGuard.mockClear();
      vi.unstubAllGlobals();
    });

    it("cancels oversized cert fetch JSON body via the 16 MiB provider cap", async () => {
      expireGoogleChatCertCache();
      const ONE_MIB = 1024 * 1024;
      const TOTAL_CHUNKS = 32;
      const chunk = new Uint8Array(ONE_MIB);

      let bytesPulled = 0;
      let canceled = false;
      const oversizedJson = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (bytesPulled >= TOTAL_CHUNKS * ONE_MIB) {
              controller.close();
              return;
            }
            bytesPulled += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
      const release = vi.fn(async () => {});
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: oversizedJson,
        release,
      });

      const result = await verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "project-number",
        audience: "123456789",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/JSON response exceeds 16777216 bytes/);
      expect(canceled).toBe(true);
      expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
      expect(release).toHaveBeenCalledOnce();
    });

    it("rejects oversized sendMessage JSON body via the 16 MiB provider cap", async () => {
      const ONE_MIB = 1024 * 1024;
      const TOTAL_CHUNKS = 32;
      const chunk = new Uint8Array(ONE_MIB);

      let bytesPulled = 0;
      let canceled = false;
      const oversizedJson = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (bytesPulled >= TOTAL_CHUNKS * ONE_MIB) {
              controller.close();
              return;
            }
            bytesPulled += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
      const release = vi.fn(async () => {});
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: oversizedJson,
        release,
      });

      await expect(
        sendGoogleChatMessage({
          account,
          space: "spaces/AAA",
          text: "hello",
        }),
      ).rejects.toThrow(/Google Chat API request failed: JSON response exceeds 16777216 bytes/);

      expect(canceled).toBe(true);
      expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
    });

    it("caps non-OK sendMessage error bodies before formatting the API error", async () => {
      const ONE_MIB = 1024 * 1024;
      const TOTAL_CHUNKS = 32;
      const chunk = new TextEncoder().encode("x".repeat(ONE_MIB));

      let bytesPulled = 0;
      let canceled = false;
      const oversizedError = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (bytesPulled >= TOTAL_CHUNKS * ONE_MIB) {
              controller.close();
              return;
            }
            bytesPulled += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 500, statusText: "Internal Server Error" },
      );
      const release = vi.fn(async () => {});
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: oversizedError,
        release,
      });

      await expect(
        sendGoogleChatMessage({
          account,
          space: "spaces/AAA",
          text: "hello",
        }),
      ).rejects.toThrow(/^Google Chat API 500: x+/);

      expect(canceled).toBe(true);
      expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
      expect(release).toHaveBeenCalledOnce();
    });
  });
});
