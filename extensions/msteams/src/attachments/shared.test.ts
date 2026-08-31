// Msteams tests cover shared plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  applyAuthorizationHeaderForUrl,
  encodeGraphShareId,
  extractInlineImageCandidates,
  isDownloadableAttachment,
  isLikelyImageAttachment,
  isUrlAllowed,
  normalizeContentType,
  resolveAttachmentFetchPolicy,
  resolveMediaSsrfPolicy,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";

const publicResolve = async () => ({ address: "13.107.136.10" });
const privateResolve = (ip: string) => async () => ({ address: ip });
const failingResolve = async () => {
  throw new Error("DNS failure");
};

const resolveAllowedHosts = (input?: string[]) =>
  resolveAttachmentFetchPolicy({ allowHosts: input }).allowHosts;
const resolveAuthAllowedHosts = (input?: string[]) =>
  resolveAttachmentFetchPolicy({ authAllowHosts: input }).authAllowHosts;
const isGraphSharedLinkUrl = (url: string) =>
  tryBuildGraphSharesUrlForSharedLink(url) !== undefined;

type SafeFetchParams = Omit<Parameters<typeof safeFetchWithPolicy>[0], "policy"> & {
  allowHosts: string[];
  authorizationAllowHosts?: string[];
};

async function safeFetch(params: SafeFetchParams) {
  const { allowHosts, authorizationAllowHosts, ...request } = params;
  return await safeFetchWithPolicy({
    ...request,
    policy: {
      allowHosts,
      authAllowHosts: authorizationAllowHosts ?? [],
    },
    resolveFn: request.resolveFn ?? publicResolve,
  });
}

function mockFetchWithRedirect(redirectMap: Record<string, string>, finalBody = "ok") {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const target = redirectMap[url];
    if (target && init?.redirect === "manual") {
      return new Response(null, {
        status: 302,
        headers: { location: target },
      });
    }
    return new Response(finalBody, { status: 200 });
  });
}

function fetchInitAt(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call[1];
}

async function expectSafeFetchStatus(params: {
  fetchMock: ReturnType<typeof vi.fn>;
  url: string;
  allowHosts: string[];
  expectedStatus: number;
  resolveFn?: typeof publicResolve;
}) {
  const res = await safeFetch({
    url: params.url,
    allowHosts: params.allowHosts,
    fetchFn: params.fetchMock as unknown as typeof fetch,
    resolveFn: params.resolveFn ?? publicResolve,
  });
  expect(res.status).toBe(params.expectedStatus);
  await res.body?.cancel();
  return res;
}

describe("msteams attachment allowlists", () => {
  it("normalizes wildcard host lists", () => {
    expect(resolveAllowedHosts(["*", "graph.microsoft.com"])).toEqual(["*"]);
    expect(resolveAuthAllowedHosts(["*", "graph.microsoft.com"])).toEqual(["*"]);
  });

  it("resolves a normalized attachment fetch policy", () => {
    expect(
      resolveAttachmentFetchPolicy({
        allowHosts: ["sharepoint.com"],
        authAllowHosts: ["graph.microsoft.com"],
      }),
    ).toEqual({
      allowHosts: ["sharepoint.com"],
      authAllowHosts: ["graph.microsoft.com"],
    });
  });

  it("allows Azure China Bot Framework attachment URLs with auth by default", () => {
    const policy = resolveAttachmentFetchPolicy();
    const url = "https://msteams.botframework.azure.cn/teams/v3/attachments/att-1/views/original";
    const headers = new Headers();

    expect(isUrlAllowed(url, policy.allowHosts)).toBe(true);
    applyAuthorizationHeaderForUrl({
      headers,
      url,
      authAllowHosts: policy.authAllowHosts,
      bearerToken: "token-1",
    });

    expect(headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("requires https and host suffix match", () => {
    const allowHosts = resolveAllowedHosts(["sharepoint.com"]);
    expect(isUrlAllowed("https://contoso.sharepoint.com/file.png", allowHosts)).toBe(true);
    expect(isUrlAllowed("http://contoso.sharepoint.com/file.png", allowHosts)).toBe(false);
    expect(isUrlAllowed("https://evil.example.com/file.png", allowHosts)).toBe(false);
  });

  it("builds shared SSRF policy from suffix allowlist", () => {
    expect(resolveMediaSsrfPolicy(["sharepoint.com"])).toEqual({
      hostnameAllowlist: ["sharepoint.com", "*.sharepoint.com"],
    });
    expect(resolveMediaSsrfPolicy(["*"])).toBeUndefined();
  });
});

// ─── safeFetch ───────────────────────────────────────────────────────────────

describe("safeFetch", () => {
  it("fetches a URL directly when no redirect occurs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("ok", { status: 200 });
    });
    await expectSafeFetchStatus({
      fetchMock,
      url: "https://teams.sharepoint.com/file.pdf",
      allowHosts: ["sharepoint.com"],
      expectedStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    // Should have used redirect: "manual"
    expect(fetchInitAt(fetchMock, 0)).toHaveProperty("redirect", "manual");
  });

  it("pins the validated DNS result into the request dispatcher", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("ok", { status: 200 });
    });

    await expectSafeFetchStatus({
      fetchMock,
      url: "https://teams.sharepoint.com/file.pdf",
      allowHosts: ["sharepoint.com"],
      expectedStatus: 200,
    });

    expect(fetchInitAt(fetchMock, 0)).toHaveProperty("dispatcher");
  });

  it("follows a redirect to an allowlisted host with public IP", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://cdn.sharepoint.com/storage/file.pdf",
    });
    await expectSafeFetchStatus({
      fetchMock,
      url: "https://teams.sharepoint.com/file.pdf",
      allowHosts: ["sharepoint.com"],
      expectedStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails explicitly for custom fetch functions that cannot receive the pinned dispatcher", async () => {
    let called = false;
    const customFetch = async () => {
      called = true;
      return new Response("ok", { status: 200 });
    };

    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: customFetch as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("fetchFnSupportsDispatcher");
    expect(called).toBe(false);
  });

  it.each([301, 302, 303, 307, 308])(
    "returns dispatcher-mode %i responses to the outer guard",
    async (status) => {
      const redirectedTo = "https://cdn.sharepoint.com/storage/file.pdf";
      const response = new Response(null, {
        status,
        headers: { location: redirectedTo },
      });
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response);
      const resolveFn = vi.fn(publicResolve);
      const headers = new Headers({ Authorization: "Bearer fixture-token" });
      const res = await safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        authorizationAllowHosts: ["teams.sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        requestInit: { dispatcher: {}, headers } as RequestInit,
        resolveFn,
      });
      expect(res).toBe(response);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(resolveFn).toHaveBeenCalledExactlyOnceWith("teams.sharepoint.com");
      const sentHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(sentHeaders.get("authorization")).toBeNull();
      expect(headers.get("authorization")).toBe("Bearer fixture-token");
    },
  );

  it.each([200, 302])(
    "returns dispatcher-mode %i responses without a location unchanged",
    async (status) => {
      const response = new Response(null, { status });
      const fetchMock = vi.fn(async () => response);
      const res = await safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as typeof fetch,
        requestInit: { dispatcher: {} } as RequestInit,
      });
      expect(res).toBe(response);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["private DNS", privateResolve("127.0.0.1")],
    ["failed DNS", failingResolve],
  ])("blocks dispatcher-mode fetch before dispatch on %s", async (_label, resolveFn) => {
    const fetchMock = vi.fn();
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as typeof fetch,
        requestInit: { dispatcher: {} } as RequestInit,
        resolveFn,
      }),
    ).rejects.toThrow("Initial download URL blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["https://evil.example.com/steal", "blocked by allowlist"],
    ["http://teams.sharepoint.com/file.pdf", "blocked by allowlist"],
    ["https://[invalid", "Invalid redirect URL"],
  ])("rejects dispatcher-mode redirect %s", async (location, error) => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": location,
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        requestInit: { dispatcher: {} } as RequestInit,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow(error);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks a redirect to a non-allowlisted host", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://evil.example.com/steal",
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("allowlist");
    // Should not have fetched the evil URL
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to an allowlisted host that resolves to a private IP (DNS rebinding)", async () => {
    let callCount = 0;
    const rebindingResolve = async () => {
      callCount++;
      // First call (initial URL) resolves to public IP
      if (callCount === 1) {
        return { address: "13.107.136.10" };
      }
      // Second call (redirect target) resolves to private IP
      return { address: "169.254.169.254" };
    };

    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://evil.trafficmanager.net/metadata",
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com", "trafficmanager.net"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: rebindingResolve,
      }),
    ).rejects.toThrow("private/internal");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks when the initial URL resolves to a private IP", async () => {
    const fetchMock = vi.fn();
    await expect(
      safeFetch({
        url: "https://evil.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: privateResolve("10.0.0.1"),
      }),
    ).rejects.toThrow("private/internal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks private hosts with the default resolver", async () => {
    const fetchMock = vi.fn();
    await expect(
      safeFetch({
        url: "https://localhost/file.pdf",
        allowHosts: ["localhost"],
        fetchFn: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("private/internal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks when initial URL DNS resolution fails", async () => {
    const fetchMock = vi.fn();
    await expect(
      safeFetch({
        url: "https://nonexistent.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: failingResolve,
      }),
    ).rejects.toThrow("DNS failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows multiple redirects when all are valid", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://a.sharepoint.com/1" && init?.redirect === "manual") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.sharepoint.com/2" },
        });
      }
      if (url === "https://b.sharepoint.com/2" && init?.redirect === "manual") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://c.sharepoint.com/3" },
        });
      }
      return new Response("final", { status: 200 });
    });

    const res = await safeFetch({
      url: "https://a.sharepoint.com/1",
      allowHosts: ["sharepoint.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws on too many redirects", async () => {
    let counter = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.redirect === "manual") {
        counter++;
        return new Response(null, {
          status: 302,
          headers: { location: `https://loop${counter}.sharepoint.com/x` },
        });
      }
      return new Response("ok", { status: 200 });
    });

    await expect(
      safeFetch({
        url: "https://start.sharepoint.com/x",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("Too many redirects");
  });

  it("blocks redirect to HTTP (non-HTTPS)", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file": "http://internal.sharepoint.com/file",
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("https");
  });

  it("strips authorization across redirects outside auth allowlist", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuth.push(`${url}|${auth}`);
      if (url === "https://graph.microsoft.com/v1.0/me/photo") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.sharepoint.com/storage/file.pdf" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const headers = new Headers({ Authorization: "Bearer secret" });
    const res = await safeFetch({
      url: "https://graph.microsoft.com/v1.0/me/photo",
      allowHosts: ["graph.microsoft.com", "sharepoint.com"],
      authorizationAllowHosts: ["graph.microsoft.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers },
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(seenAuth[0]).toContain("Bearer secret");
    expect(seenAuth[1]).toMatch(/\|$/);
  });

  it("keeps authorization across redirects inside auth allowlist", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuth.push(`${url}|${auth}`);
      if (url === "https://graph.microsoft.com/file.pdf") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.sharepoint.com/storage/file.pdf" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const headers = new Headers({ Authorization: "Bearer secret" });
    const res = await safeFetch({
      url: "https://graph.microsoft.com/file.pdf",
      allowHosts: ["graph.microsoft.com", "sharepoint.com"],
      authorizationAllowHosts: ["graph.microsoft.com", "sharepoint.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers },
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(seenAuth[0]).toContain("Bearer secret");
    expect(seenAuth[1]).toContain("Bearer secret");
  });

  it("keeps authorization across HTTPS redirects when auth allowlist is wildcard", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuth.push(`${url}|${auth}`);
      if (url === "https://graph.microsoft.com/file.pdf") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/storage/file.pdf" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const headers = new Headers({ Authorization: "Bearer secret" });
    const res = await safeFetch({
      url: "https://graph.microsoft.com/file.pdf",
      allowHosts: ["*"],
      authorizationAllowHosts: ["*"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers },
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(seenAuth[0]).toContain("Bearer secret");
    expect(seenAuth[1]).toContain("Bearer secret");
  });

  it("strips authorization from the initial fetch outside auth allowlist", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      expect(url).toBe("https://attacker.trafficmanager.net/v3/attachments/att-1");
      return new Response("ok", { status: 200 });
    });

    const res = await safeFetch({
      url: "https://attacker.trafficmanager.net/v3/attachments/att-1",
      allowHosts: ["trafficmanager.net"],
      authorizationAllowHosts: ["smba.trafficmanager.net"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers: { Authorization: "Bearer secret" } },
      resolveFn: publicResolve,
    });

    expect(res.status).toBe(200);
    expect(seenAuth).toEqual([""]);
  });
});

describe("attachment fetch auth helpers", () => {
  it("sets and clears authorization header by auth allowlist", () => {
    const headers = new Headers();
    applyAuthorizationHeaderForUrl({
      headers,
      url: "https://graph.microsoft.com/v1.0/me",
      authAllowHosts: ["graph.microsoft.com"],
      bearerToken: "token-1",
    });
    expect(headers.get("authorization")).toBe("Bearer token-1");

    applyAuthorizationHeaderForUrl({
      headers,
      url: "https://evil.example.com/collect",
      authAllowHosts: ["graph.microsoft.com"],
      bearerToken: "token-1",
    });
    expect(headers.get("authorization")).toBeNull();
  });

  it("safeFetchWithPolicy forwards policy allowlists", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("ok", { status: 200 });
    });
    const res = await safeFetchWithPolicy({
      url: "https://teams.sharepoint.com/file.pdf",
      policy: resolveAttachmentFetchPolicy({
        allowHosts: ["sharepoint.com"],
        authAllowHosts: ["graph.microsoft.com"],
      }),
      fetchFn: fetchMock as unknown as typeof fetch,
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("Graph shared-link helpers", () => {
  it.each([
    ["https://contoso.sharepoint.com/personal/user/Documents/report.pdf", true],
    ["https://contoso.sharepoint.us/sites/team/file.docx", true],
    ["https://contoso.sharepoint.cn/file", true],
    ["https://tenant-my.sharepoint.com/:b:/g/personal/file", true],
    ["https://1drv.ms/b/s!AkxYabc", true],
    ["https://onedrive.live.com/view.aspx?resid=ABC", true],
    ["https://onedrive.com/share/abc", true],
    ["https://graph.microsoft.com/v1.0/me", false],
    ["https://smba.trafficmanager.net/amer/v3", false],
    ["https://example.com/file.pdf", false],
    ["https://notonedrive.com/x", false],
    ["https://evil1drv.ms/x", false],
    ["https://fakeonedrive.live.com/x", false],
    ["https://evilsharepoint.com/x", false],
    ["http://onedrive.com/x", false],
    ["not-a-url", false],
  ])("isGraphSharedLinkUrl(%s) === %s", (url, expected) => {
    expect(isGraphSharedLinkUrl(url)).toBe(expected);
  });

  it("encodeGraphShareId uses u! + base64url without padding", () => {
    // Graph docs example: encoding "https://onedrive.live.com/redir?resid=..."
    // should yield u!aHR0cHM6... (base64url, no '+', '/', or trailing '=').
    const url = "https://contoso.sharepoint.com/sites/a/Shared Documents/file.pdf";
    const shareId = encodeGraphShareId(url);
    expect(shareId.startsWith("u!")).toBe(true);
    const encoded = shareId.slice(2);
    // base64url alphabet is A-Z, a-z, 0-9, '-', '_' (no padding).
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    // Round-trip check: decoding yields the original URL.
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decoded).toBe(url);
  });

  it("encodeGraphShareId swaps '+' and '/' for '-' and '_'", () => {
    // A URL whose standard base64 contains '+' and '/' chars.
    // Choose an input that base64 encodes with those characters.
    const url = "https://host.sharepoint.com/sites/path?x=???";
    const shareId = encodeGraphShareId(url);
    const encoded = shareId.slice(2);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("tryBuildGraphSharesUrlForSharedLink rewrites SharePoint URLs", () => {
    const url = "https://contoso.sharepoint.com/personal/user/Documents/report.pdf";
    const result = tryBuildGraphSharesUrlForSharedLink(url);
    expect(result).toBe(
      `https://graph.microsoft.com/v1.0/shares/${encodeGraphShareId(url)}/driveItem/content`,
    );
  });

  it("tryBuildGraphSharesUrlForSharedLink rewrites OneDrive URLs", () => {
    const url = "https://1drv.ms/b/s!AkxYabcdefg";
    const result = tryBuildGraphSharesUrlForSharedLink(url);
    expect(result).toBe(
      `https://graph.microsoft.com/v1.0/shares/${encodeGraphShareId(url)}/driveItem/content`,
    );
  });

  it("tryBuildGraphSharesUrlForSharedLink returns undefined for non-shared URLs", () => {
    expect(
      tryBuildGraphSharesUrlForSharedLink("https://graph.microsoft.com/v1.0/me"),
    ).toBeUndefined();
    expect(tryBuildGraphSharesUrlForSharedLink("https://example.com/file.pdf")).toBeUndefined();
    expect(tryBuildGraphSharesUrlForSharedLink("not-a-url")).toBeUndefined();
  });
});

describe("msteams inline image limits", () => {
  const smallPngDataUrl = "data:image/png;base64,aGVsbG8="; // "hello" (5 bytes)

  it.each([
    ["AA==", "00"],
    ["AAA=", "0000"],
    ["AAAA", "000000"],
    ["Z E = =", "64"],
    ["A\tA==", "00"],
  ])("enforces exact decoded-size limits for %s", (payload, hex) => {
    const data = Buffer.from(hex, "hex");
    const attachments = [
      {
        contentType: "text/html",
        content: `<img src="data:image/png;base64,${payload}" />`,
      },
    ];
    expect(
      extractInlineImageCandidates(attachments, { maxInlineBytes: data.length - 1 }),
    ).toStrictEqual([{ kind: "unavailable" }]);
    expect(
      extractInlineImageCandidates(attachments, { maxInlineBytes: data.length }),
    ).toStrictEqual([{ kind: "data", data, contentType: "image/png" }]);
  });

  it.each(["aGV=sbG8=", "A===", "AA", "-AAA", "A!AA"])(
    "rejects malformed inline base64 %s",
    (payload) => {
      const attachments = [
        {
          contentType: "text/html",
          content: `<img src="data:image/png;base64,${payload}" />`,
        },
      ];
      const out = extractInlineImageCandidates(attachments, { maxInlineBytes: 10 });
      expect(out).toStrictEqual([{ kind: "unavailable" }]);
    },
  );

  it.each([
    [9, ["data", "unavailable", "unavailable"]],
    [10, ["data", "data", "unavailable"]],
  ])(
    "enforces cumulative inline size limit %i across attachments",
    (maxInlineTotalBytes, kinds) => {
      const attachments = [
        {
          contentType: "text/html",
          content: `<img src="${smallPngDataUrl}" />`,
        },
        {
          contentType: "text/html",
          content: `<img src="${smallPngDataUrl}" />`,
        },
        {
          contentType: "text/html",
          content: `<img src="${smallPngDataUrl}" />`,
        },
      ];
      const out = extractInlineImageCandidates(attachments, {
        maxInlineBytes: 10,
        maxInlineTotalBytes,
      });
      expect(out.map((candidate) => candidate.kind)).toEqual(kinds);
    },
  );
});

describe("normalizeContentType case-insensitivity", () => {
  // MIME types are case-insensitive (RFC 2045); relay payloads routinely emit
  // mixed-case values. normalizeContentType must lowercase so the downstream
  // startsWith/=== comparisons (which assume lowercase) match.
  it("lowercases mixed-case content types", () => {
    expect(normalizeContentType("Image/PNG")).toBe("image/png");
    expect(normalizeContentType("TEXT/HTML")).toBe("text/html");
    expect(normalizeContentType("Application/Vnd.Microsoft.Teams.File.Download.Info")).toBe(
      "application/vnd.microsoft.teams.file.download.info",
    );
  });

  it("trims surrounding whitespace before lowercasing", () => {
    expect(normalizeContentType("  Image/PNG  ")).toBe("image/png");
  });

  it("preserves case-sensitive parameter values", () => {
    expect(normalizeContentType('  Text/HTML ; charset="X-Custom"  ')).toBe(
      'text/html; charset="X-Custom"',
    );
  });

  it("returns undefined for non-string, empty, or whitespace input", () => {
    expect(normalizeContentType(undefined)).toBeUndefined();
    expect(normalizeContentType(123 as unknown as string)).toBeUndefined();
    expect(normalizeContentType("   ")).toBeUndefined();
    expect(normalizeContentType("")).toBeUndefined();
  });
});

describe("isLikelyImageAttachment mixed-case content type", () => {
  it("recognizes an image with a mixed-case content type and no filename hint", () => {
    expect(isLikelyImageAttachment({ contentType: "Image/PNG", name: "download" })).toBe(true);
    expect(isLikelyImageAttachment({ contentType: "image/png", name: "download" })).toBe(true);
  });

  it("still rejects non-image types (regression)", () => {
    expect(isLikelyImageAttachment({ contentType: "Application/PDF", name: "doc" })).toBe(false);
  });
});

describe("isDownloadableAttachment mixed-case download-info type", () => {
  it("recognizes the Teams download-info attachment type regardless of casing", () => {
    const content = { downloadUrl: "https://example.com/file" };
    expect(
      isDownloadableAttachment({
        contentType: "Application/Vnd.Microsoft.Teams.File.Download.Info",
        content,
      }),
    ).toBe(true);
    expect(
      isDownloadableAttachment({
        contentType: "application/vnd.microsoft.teams.file.download.info",
        content,
      }),
    ).toBe(true);
  });
});
