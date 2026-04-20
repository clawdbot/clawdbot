import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import {
  blueBubblesHeaderAuth,
  blueBubblesQueryStringAuth,
  BlueBubblesClient,
  clearBlueBubblesClientCache,
  createBlueBubblesClient,
  invalidateBlueBubblesClient,
  resolveBlueBubblesClientSsrfPolicy,
} from "./client.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import type { PluginRuntime } from "./runtime-api.js";
import { setBlueBubblesRuntime } from "./runtime.js";
import {
  createBlueBubblesFetchGuardPassthroughInstaller,
  installBlueBubblesFetchTestHooks,
} from "./test-harness.js";
import type { BlueBubblesAttachment } from "./types.js";
import { _setFetchGuardForTesting } from "./types.js";

// --- Test infrastructure ---------------------------------------------------

const mockFetch = vi.fn();

const fetchRemoteMediaMock = vi.fn(
  async (params: {
    url: string;
    maxBytes?: number;
    ssrfPolicy?: SsrFPolicy;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(params.url);
    if (!res.ok) {
      throw new Error(`media fetch failed: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
      const error = new Error(`payload exceeds maxBytes ${params.maxBytes}`) as Error & {
        code?: string;
      };
      error.code = "max_bytes";
      throw error;
    }
    return {
      buffer,
      contentType: res.headers.get("content-type") ?? undefined,
      fileName: undefined,
    };
  },
);

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock: vi.mocked(getCachedBlueBubblesPrivateApiStatus),
});

const runtimeStub = {
  channel: {
    media: {
      fetchRemoteMedia:
        fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
    },
  },
} as unknown as PluginRuntime;

beforeEach(() => {
  fetchRemoteMediaMock.mockClear();
  clearBlueBubblesClientCache();
  setBlueBubblesRuntime(runtimeStub);
});

afterEach(() => {
  clearBlueBubblesClientCache();
});

// --- resolveBlueBubblesClientSsrfPolicy ------------------------------------

describe("resolveBlueBubblesClientSsrfPolicy (3-mode policy)", () => {
  it("mode 1: user opts in → { allowPrivateNetwork: true } for any hostname", () => {
    const result = resolveBlueBubblesClientSsrfPolicy({
      baseUrl: "http://localhost:1234",
      allowPrivateNetwork: true,
    });
    expect(result.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(result.trustedHostname).toBe("localhost");
    expect(result.trustedHostnameIsPrivate).toBe(true);
  });

  it("mode 2: private hostname + no opt-out → narrow allowlist { allowedHostnames: [host] }", () => {
    const result = resolveBlueBubblesClientSsrfPolicy({
      baseUrl: "http://192.168.1.50:1234",
      allowPrivateNetwork: false,
    });
    expect(result.ssrfPolicy).toEqual({ allowedHostnames: ["192.168.1.50"] });
    expect(result.trustedHostnameIsPrivate).toBe(true);
  });

  it("mode 2: localhost + no opt-out → narrow allowlist keeps BB reachable without full opt-in", () => {
    const result = resolveBlueBubblesClientSsrfPolicy({
      baseUrl: "http://localhost:1234",
      allowPrivateNetwork: false,
    });
    expect(result.ssrfPolicy).toEqual({ allowedHostnames: ["localhost"] });
  });

  it("mode 2: public hostname + no opt-in → narrow allowlist for the public host", () => {
    const result = resolveBlueBubblesClientSsrfPolicy({
      baseUrl: "https://bb.example.com",
      allowPrivateNetwork: false,
    });
    expect(result.ssrfPolicy).toEqual({ allowedHostnames: ["bb.example.com"] });
    expect(result.trustedHostnameIsPrivate).toBe(false);
  });

  it("mode 3: private hostname + explicit opt-out → {} (guarded default-deny, honors the opt-out) (aisle #68234)", () => {
    // Previously returned `undefined`, which routed through the unguarded
    // fetch fallback and effectively bypassed SSRF protection exactly when
    // the user had explicitly asked to disable private-network access.
    const result = resolveBlueBubblesClientSsrfPolicy({
      baseUrl: "http://192.168.1.50:1234",
      allowPrivateNetwork: false,
      allowPrivateNetworkConfig: false,
    });
    expect(result.ssrfPolicy).toEqual({});
    expect(result.trustedHostnameIsPrivate).toBe(true);
  });

  it("mode 3: unparseable baseUrl → {} (fail-safe guarded, never bypass)", () => {
    const result = resolveBlueBubblesClientSsrfPolicy({
      baseUrl: "not a url",
      allowPrivateNetwork: false,
    });
    expect(result.ssrfPolicy).toEqual({});
    expect(result.trustedHostname).toBeUndefined();
  });

  it("never returns undefined ssrfPolicy — every mode is guarded (aisle #68234 invariant)", () => {
    // This invariant is what closes the SSRF bypass aisle flagged. Any
    // refactor that reintroduces `ssrfPolicy: undefined` should break here.
    const cases = [
      { baseUrl: "http://localhost:1234", allowPrivateNetwork: true },
      { baseUrl: "http://localhost:1234", allowPrivateNetwork: false },
      {
        baseUrl: "http://192.168.1.50:1234",
        allowPrivateNetwork: false,
        allowPrivateNetworkConfig: false,
      },
      { baseUrl: "https://bb.example.com", allowPrivateNetwork: false },
      { baseUrl: "not a url", allowPrivateNetwork: false },
    ];
    for (const c of cases) {
      const result = resolveBlueBubblesClientSsrfPolicy(c);
      expect(result.ssrfPolicy).toBeDefined();
    }
  });
});

// --- Auth strategies -------------------------------------------------------

describe("auth strategies", () => {
  it("blueBubblesQueryStringAuth sets ?password= on URL", () => {
    const strategy = blueBubblesQueryStringAuth("s3cret");
    const url = new URL("http://localhost:1234/api/v1/ping");
    const init: RequestInit = {};
    strategy.decorate({ url, init });
    expect(url.searchParams.get("password")).toBe("s3cret");
    expect(init.headers).toBeUndefined();
  });

  it("blueBubblesHeaderAuth sets the auth header and leaves URL clean", () => {
    const strategy = blueBubblesHeaderAuth("s3cret");
    const url = new URL("http://localhost:1234/api/v1/ping");
    const init: RequestInit = {};
    strategy.decorate({ url, init });
    expect(url.searchParams.has("password")).toBe(false);
    expect(new Headers(init.headers).get("X-BB-Password")).toBe("s3cret");
  });

  it("blueBubblesHeaderAuth accepts a custom header name", () => {
    const strategy = blueBubblesHeaderAuth("s3cret", "Authorization");
    const url = new URL("http://localhost:1234/api/v1/ping");
    const init: RequestInit = {};
    strategy.decorate({ url, init });
    expect(new Headers(init.headers).get("Authorization")).toBe("s3cret");
  });

  it("auth runs on every request made through the client", async () => {
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    mockFetch.mockImplementation(() => Promise.resolve(new Response("", { status: 200 })));
    await client.ping();
    await client.getServerInfo();
    const calls = mockFetch.mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.[0])).toContain("password=s3cret");
    expect(String(calls[1]?.[0])).toContain("password=s3cret");
  });

  it("swapping to header auth at factory level keeps URL clean", async () => {
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
      authStrategy: blueBubblesHeaderAuth,
    });
    mockFetch.mockResolvedValue(new Response("", { status: 200 }));
    await client.ping();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] ?? [];
    expect(String(calledUrl)).not.toContain("password=");
    const headers = new Headers((calledInit as RequestInit | undefined)?.headers);
    expect(headers.get("X-BB-Password")).toBe("s3cret");
  });

  it("header-auth headers flow through requestMultipart (Greptile #68234 P1)", async () => {
    // Before this fix, requestMultipart discarded prepared.init entirely
    // and postMultipartFormData built its own hardcoded Content-Type header.
    // Under header-auth that silently omitted the auth header on every
    // attachment upload and group-icon set.
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
      authStrategy: blueBubblesHeaderAuth,
    });
    mockFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    await client.requestMultipart({
      path: "/api/v1/chat/chat-guid/icon",
      boundary: "----boundary",
      parts: [new Uint8Array([1, 2, 3])],
    });
    const [, calledInit] = mockFetch.mock.calls[0] ?? [];
    const headers = new Headers((calledInit as RequestInit | undefined)?.headers);
    expect(headers.get("X-BB-Password")).toBe("s3cret");
    // And the multipart Content-Type must still be set correctly.
    expect(headers.get("Content-Type")).toContain("multipart/form-data; boundary=----boundary");
  });

  it("header-auth headers flow through downloadAttachment fetchImpl (Greptile #68234 P1)", async () => {
    // Before this fix, downloadAttachment built prepared.init.headers with
    // the auth header but never forwarded it to the fetchImpl callback,
    // so header-auth would silently 401 on attachment downloads.
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
      authStrategy: blueBubblesHeaderAuth,
    });
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    await client.downloadAttachment({ attachment: { guid: "att-1", mimeType: "image/png" } });
    // fetchRemoteMediaMock delegates to fetchImpl, which calls mockFetch.
    const [, calledInit] = mockFetch.mock.calls[0] ?? [];
    const headers = new Headers((calledInit as RequestInit | undefined)?.headers);
    expect(headers.get("X-BB-Password")).toBe("s3cret");
  });
});

// --- Core request path -----------------------------------------------------

describe("client.request — SSRF policy threading", () => {
  it("threads the same resolved policy to the SSRF guard on every call", async () => {
    const capturedPolicies: unknown[] = [];
    const installPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();
    installPassthrough((policy) => {
      capturedPolicies.push(policy);
    });
    mockFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));

    // Public hostname with no explicit opt-in → mode 2 (narrow allowlist).
    const client = createBlueBubblesClient({
      cfg: {
        channels: {
          bluebubbles: {
            serverUrl: "https://bb.example.com",
            password: "s3cret",
          },
        },
      } as never,
    });

    await client.ping();
    await client.getServerInfo();

    // Both calls used the same narrow allowlist policy (mode 2).
    expect(capturedPolicies).toHaveLength(2);
    expect(capturedPolicies[0]).toEqual({ allowedHostnames: ["bb.example.com"] });
    expect(capturedPolicies[1]).toEqual({ allowedHostnames: ["bb.example.com"] });
  });

  it("private hostname auto-allows (mode 1) without explicit opt-in — preserves existing behavior", async () => {
    const capturedPolicies: unknown[] = [];
    const installPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();
    installPassthrough((policy) => {
      capturedPolicies.push(policy);
    });
    mockFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));

    // 192.168/16 hostname with no config → resolveBlueBubblesEffectiveAllowPrivateNetwork
    // auto-allows (accounts-normalization.ts:98-107) → mode 1.
    const client = createBlueBubblesClient({
      serverUrl: "http://192.168.1.50:1234",
      password: "s3cret",
    });

    await client.ping();
    await client.getServerInfo();

    expect(capturedPolicies).toHaveLength(2);
    expect(capturedPolicies[0]).toEqual({ allowPrivateNetwork: true });
    expect(capturedPolicies[1]).toEqual({ allowPrivateNetwork: true });
  });

  it("applies full-open policy when user opts into private networks", async () => {
    const capturedPolicies: unknown[] = [];
    const installPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();
    installPassthrough((policy) => {
      capturedPolicies.push(policy);
    });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const client = createBlueBubblesClient({
      cfg: {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "s3cret",
            network: { dangerouslyAllowPrivateNetwork: true },
          },
        },
      } as never,
    });

    await client.ping();
    expect(capturedPolicies[0]).toEqual({ allowPrivateNetwork: true });
  });
});

// --- #59722 regression: reactions use same policy as other calls -----------

describe("client.react (regression for #59722)", () => {
  it("uses the same SSRF policy as every other client request (no asymmetric {} fallback)", async () => {
    const capturedPolicies: unknown[] = [];
    const installPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();
    installPassthrough((policy) => {
      capturedPolicies.push(policy);
    });
    mockFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));

    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });

    // Both should carry the same mode-2 allowlist — before this client existed,
    // reactions.ts passed `{}` (empty guard) while attachments.ts passed
    // `{ allowedHostnames: [...] }`. The asymmetry is what #59722 reported.
    await client.ping();
    await client.react({
      chatGuid: "iMessage;+;+15551234567",
      selectedMessageGuid: "msg-1",
      reaction: "like",
    });

    expect(capturedPolicies).toHaveLength(2);
    // The critical assertion: both calls resolved the SAME policy, no
    // `{}` vs `{ allowedHostnames }` asymmetry like before consolidation.
    expect(capturedPolicies[0]).toEqual(capturedPolicies[1]);
    // Localhost auto-allows (private hostname, no explicit opt-out).
    expect(capturedPolicies[1]).toEqual({ allowPrivateNetwork: true });
  });

  it("sends the reaction payload with the correct shape and method", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    await client.react({
      chatGuid: "chat-guid",
      selectedMessageGuid: "msg-1",
      reaction: "love",
      partIndex: 2,
    });

    const [calledUrl, calledInit] = mockFetch.mock.calls[0] ?? [];
    expect(String(calledUrl)).toContain("/api/v1/message/react");
    const init = calledInit as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      chatGuid: "chat-guid",
      selectedMessageGuid: "msg-1",
      reaction: "love",
      partIndex: 2,
    });
  });
});

// --- #34749 regression: downloadAttachment threads policy end-to-end -------

describe("client.downloadAttachment (regression for #34749)", () => {
  it("threads the client's ssrfPolicy to fetchRemoteMedia", async () => {
    mockFetch.mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    await client.downloadAttachment({
      attachment: { guid: "att-1", mimeType: "image/png" },
    });

    expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1);
    const call = fetchRemoteMediaMock.mock.calls[0]?.[0];
    expect(call?.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(call?.url).toContain("/api/v1/attachment/att-1/download");
  });

  it("threads the client's ssrfPolicy to the fetchImpl callback (closes #34749 gap)", async () => {
    const capturedPolicies: unknown[] = [];
    const installPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();
    installPassthrough((policy) => {
      capturedPolicies.push(policy);
    });
    mockFetch.mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    await client.downloadAttachment({
      attachment: { guid: "att-1", mimeType: "image/png" },
    });

    // fetchImpl ran (the mock runtime delegates to globalThis.fetch via fetchFn),
    // which means blueBubblesFetchWithTimeout was called WITH the ssrfPolicy.
    // Before this fix, attachments.ts built its fetchImpl without forwarding
    // the policy — the guarded path never ran for the actual attachment bytes.
    expect(capturedPolicies).toHaveLength(1);
    expect(capturedPolicies[0]).toEqual({ allowPrivateNetwork: true });
  });

  it("throws when attachment guid is missing", async () => {
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    await expect(
      client.downloadAttachment({ attachment: {} as BlueBubblesAttachment }),
    ).rejects.toThrow("guid is required");
  });

  it("surfaces max_bytes error with clear message", async () => {
    mockFetch.mockResolvedValue(
      new Response(Buffer.alloc(10 * 1024 * 1024), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    await expect(
      client.downloadAttachment({
        attachment: { guid: "att-big" },
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/too large \(limit 1024 bytes\)/);
  });
});

// --- Attachment metadata ---------------------------------------------------

describe("client.getMessageAttachments", () => {
  it("fetches and extracts attachment metadata", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            attachments: [
              { guid: "att-xyz", transferName: "IMG_0001.JPG", mimeType: "image/jpeg" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    const result = await client.getMessageAttachments({ messageGuid: "msg-1" });
    expect(result).toHaveLength(1);
    expect(result[0]?.guid).toBe("att-xyz");
    expect(result[0]?.mimeType).toBe("image/jpeg");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/api/v1/message/msg-1");
  });

  it("returns [] on non-ok response rather than throwing", async () => {
    mockFetch.mockResolvedValue(new Response("not found", { status: 404 }));
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    const result = await client.getMessageAttachments({ messageGuid: "missing" });
    expect(result).toEqual([]);
  });
});

// --- Cache + invalidation --------------------------------------------------

describe("client cache", () => {
  it("returns the same instance for the same accountId + baseUrl", () => {
    const cfg = {
      channels: {
        bluebubbles: { serverUrl: "http://localhost:1234", password: "s3cret" },
      },
    } as never;
    const a = createBlueBubblesClient({ cfg });
    const b = createBlueBubblesClient({ cfg });
    expect(a).toBe(b);
  });

  it("returns a different instance after invalidate", () => {
    const cfg = {
      channels: {
        bluebubbles: { serverUrl: "http://localhost:1234", password: "s3cret" },
      },
    } as never;
    const a = createBlueBubblesClient({ cfg });
    invalidateBlueBubblesClient(a.accountId);
    const b = createBlueBubblesClient({ cfg });
    expect(a).not.toBe(b);
  });

  it("cache entry is keyed so different serverUrls cannot collide", () => {
    const a = createBlueBubblesClient({
      serverUrl: "http://host-a:1234",
      password: "s3cret",
    });
    invalidateBlueBubblesClient(a.accountId);
    const b = createBlueBubblesClient({
      serverUrl: "http://host-b:1234",
      password: "s3cret",
    });
    expect(b.baseUrl).toBe("http://host-b:1234");
  });

  it("different authStrategy for the same account + credential rebuilds the client (Greptile #68234 P2)", () => {
    // Before this fix the fingerprint keyed only on {baseUrl, password}.
    // A second call with a different authStrategy would silently return
    // the cached first strategy's client.
    const a = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
      // default: blueBubblesQueryStringAuth
    });
    const b = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
      authStrategy: blueBubblesHeaderAuth,
    });
    expect(a).not.toBe(b);
  });
});

describe("client construction", () => {
  it("throws when serverUrl is missing", () => {
    expect(() => createBlueBubblesClient({ password: "s3cret" })).toThrow(/serverUrl is required/);
  });

  it("throws when password is missing", () => {
    expect(() => createBlueBubblesClient({ serverUrl: "http://localhost:1234" })).toThrow(
      /password is required/,
    );
  });

  it("is a BlueBubblesClient instance and exposes read-only policy", () => {
    const client = createBlueBubblesClient({
      serverUrl: "http://localhost:1234",
      password: "s3cret",
    });
    expect(client).toBeInstanceOf(BlueBubblesClient);
    // localhost auto-allows (accounts-normalization.ts) → mode 1.
    expect(client.getSsrfPolicy()).toEqual({ allowPrivateNetwork: true });
    expect(client.trustedHostname).toBe("localhost");
    expect(client.trustedHostnameIsPrivate).toBe(true);
    expect(client.accountId).toBeTruthy();
  });
});

// Reference unused import so lint doesn't complain while we keep parity with
// the existing test-harness module contract (#68xxx).
void _setFetchGuardForTesting;
