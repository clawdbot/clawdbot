import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia, sendGoogleChatMessage } from "./api.js";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";
import { isSenderAllowed } from "./monitor.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
} from "./targets.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init?: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: async () => {},
  })),
  verifyIdToken: vi.fn(),
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("google-auth-library", () => ({
  GoogleAuth: function GoogleAuth() {},
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));

vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return {
    ...actual,
    getGoogleChatAccessToken: mocks.getGoogleChatAccessToken,
  };
});

const { verifyGoogleChatRequest } = await import("./auth.js");

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

describe("isSenderAllowed", () => {
  it("matches raw email entries only when dangerous name matching is enabled", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"])).toBe(false);
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"], true)).toBe(true);
  });

  it("does not treat users/<email> entries as email allowlist (deprecated form)", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["users/jane@example.com"])).toBe(
      false,
    );
  });

  it("still matches user id entries", () => {
    expect(isSenderAllowed("users/abc", "jane@example.com", ["users/abc"])).toBe(true);
  });

  it("rejects non-matching raw email entries", () => {
    expect(isSenderAllowed("users/123", "jane@example.com", ["other@example.com"], true)).toBe(
      false,
    );
  });
});

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
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

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      text: "hello",
      thread: { name: "spaces/AAA/threads/xyz" },
    });
  });

  it("does not set messageReplyOption for non-thread sends", async () => {
    const fetchMock = stubSuccessfulSend("spaces/AAA/messages/124");

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("messageReplyOption=");
  });
});

function mockTicket(payload: Record<string, unknown>) {
  mocks.verifyIdToken.mockResolvedValue({
    getPayload: () => payload,
  });
}

describe("verifyGoogleChatRequest", () => {
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
});
