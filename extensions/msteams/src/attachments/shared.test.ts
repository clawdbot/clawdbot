import { describe, expect, it, vi } from "vitest";
import {
  applyAuthorizationHeaderForUrl,
  encodeGraphShareId,
  extractInlineImageCandidates,
  isGraphSharedLinkUrl,
  isPrivateOrReservedIP,
  isUrlAllowed,
  resolveAndValidateIP,
  resolveAttachmentFetchPolicy,
  resolveAllowedHosts,
  resolveAuthAllowedHosts,
  resolveMediaSsrfPolicy,
  safeFetch,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";

const publicResolve = async () => ({ address: "13.107.136.10" });
const privateResolve = (ip: string) => async () => ({ address: ip });
const failingResolve = async () => {
  throw new Error("DNS failure");
};

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

  it.each([
    ["999.999.999.999", true],
    ["256.0.0.1", true],
    ["10.0.0.256", true],
    ["-1.0.0.1", false],
    ["1.2.3.4.5", false],
    ["0:0:0:0:0:0:0:1", true],
  ] as const)("malformed/expanded %s → %s (SDK fails closed)", (ip, expected) => {
    expect(isPrivateOrReservedIP(ip)).toBe(expected);
  });
});

// ─── resolveAndValidateIP ────────────────────────────────────────────────────

describe("resolveAndValidateIP", () => {
  it("accepts a hostname resolving to a public IP", async () => {
    const ip = await resolveAndValidateIP("teams.sharepoint.com", publicResolve);
    expect(ip).toBe("13.107.136.10");
  });

  it("rejects a hostname resolving to 10.x.x.x", async () => {
    await expect(resolveAndValidateIP("evil.test", privateResolve("10.0.0.1"))).rejects.toThrow(
      "private/reserved IP",
    );
  });

  it("rejects a hostname resolving to 169.254.169.254", async () => {
    await expect(
      resolveAndValidateIP("evil.test", privateResolve("169.254.169.254")),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects a hostname resolving to loopback", async () => {
    await expect(resolveAndValidateIP("evil.test", privateResolve("127.0.0.1"))).rejects.toThrow(
      "private/reserved IP",
    );
  });

  it("rejects a hostname resolving to IPv6 loopback", async () => {
    await expect(resolveAndValidateIP("evil.test", privateResolve("::1"))).rejects.toThrow(
      "private/reserved IP",
    );
  });

  it("throws on DNS resolution failure", async () => {
    await expect(resolveAndValidateIP("nonexistent.test", failingResolve)).rejects.toThrow(
      "DNS resolution failed",
    );
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
    expect(fetchMock.mock.calls[0][1]).toHaveProperty("redirect", "manual");
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

  it("returns the redirect response when dispatcher is provided by an outer guard", async () => {
    const redirectedTo = "https://cdn.sharepoint.com/storage/file.pdf";
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": redirectedTo,
    });
    const res = await safeFetch({
      url: "https://teams.sharepoint.com/file.pdf",
      allowHosts: ["sharepoint.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { dispatcher: {} } as RequestInit,
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(redirectedTo);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still enforces allowlist checks before returning dispatcher-mode redirects", async () => {
    const fetchMock = mockFetchWithRedirect({
      "https://teams.sharepoint.com/file.pdf": "https://evil.example.com/steal",
    });
    await expect(
      safeFetch({
        url: "https://teams.sharepoint.com/file.pdf",
        allowHosts: ["sharepoint.com"],
        fetchFn: fetchMock as unknown as typeof fetch,
        requestInit: { dispatcher: {} } as RequestInit,
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("blocked by allowlist");
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
    ).rejects.toThrow("blocked by allowlist");
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
    ).rejects.toThrow("private/reserved IP");
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
    ).rejects.toThrow("Initial download URL blocked");
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
    ).rejects.toThrow("Initial download URL blocked");
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
    ).rejects.toThrow("Initial download URL blocked");
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
    ).rejects.toThrow("blocked by allowlist");
  });

  it("strips authorization across redirects outside auth allowlist", async () => {
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuth.push(`${url}|${auth}`);
      if (url === "https://teams.sharepoint.com/file.pdf") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.sharepoint.com/storage/file.pdf" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const headers = new Headers({ Authorization: "Bearer secret" });
    const res = await safeFetch({
      url: "https://teams.sharepoint.com/file.pdf",
      allowHosts: ["sharepoint.com"],
      authorizationAllowHosts: ["graph.microsoft.com"],
      fetchFn: fetchMock as unknown as typeof fetch,
      requestInit: { headers },
      resolveFn: publicResolve,
    });
    expect(res.status).toBe(200);
    expect(seenAuth[0]).toContain("Bearer secret");
    expect(seenAuth[1]).toMatch(/\|$/);
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
    expect(result).toBeDefined();
    expect(result).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/shares\/u![A-Za-z0-9_-]+\/driveItem\/content$/,
    );
  });

  it("tryBuildGraphSharesUrlForSharedLink rewrites OneDrive URLs", () => {
    const url = "https://1drv.ms/b/s!AkxYabcdefg";
    const result = tryBuildGraphSharesUrlForSharedLink(url);
    expect(result).toBeDefined();
    expect(result).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/shares\/u![A-Za-z0-9_-]+\/driveItem\/content$/,
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

  it("rejects inline data images above per-image limit", () => {
    const attachments = [
      {
        contentType: "text/html",
        content: `<img src="${smallPngDataUrl}" />`,
      },
    ];
    const out = extractInlineImageCandidates(attachments, { maxInlineBytes: 4 });
    expect(out).toEqual([]);
  });

  it("accepts inline data images within limit", () => {
    const attachments = [
      {
        contentType: "text/html",
        content: `<img src="${smallPngDataUrl}" />`,
      },
    ];
    const out = extractInlineImageCandidates(attachments, { maxInlineBytes: 10 });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("data");
    if (out[0]?.kind === "data") {
      expect(out[0].data.byteLength).toBeGreaterThan(0);
      expect(out[0].contentType).toBe("image/png");
    }
  });

  it("enforces cumulative inline size limit across attachments", () => {
    const attachments = [
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
      maxInlineTotalBytes: 6,
    });
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("data");
  });
});
