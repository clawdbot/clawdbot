import { describe, expect, it, vi } from "vitest";
import {
  CONSENT_UPLOAD_HOST_ALLOWLIST,
  isPrivateOrReservedIP,
  uploadToConsentUrl,
  validateConsentUploadUrl,
} from "./file-consent.js";
import { buildUserAgent } from "./user-agent.js";

// Helper: a resolveFn that returns a public IP by default
const publicResolve = async () => ({ address: "13.107.136.10" });
// Helper: a resolveFn that returns a private IP
const privateResolve = (ip: string) => async () => ({ address: ip });
// Helper: a resolveFn that returns multiple addresses
const multiResolve = (ips: string[]) => async () => ips.map((address) => ({ address }));
// Helper: a resolveFn that fails
const failingResolve = async () => {
  throw new Error("DNS failure");
};

const firstFetchCall = (fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) => {
  const [call] = fetchFn.mock.calls;
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call;
};

// ─── isPrivateOrReservedIP ───────────────────────────────────────────────────

describe("isPrivateOrReservedIP", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["169.254.0.1", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["13.107.136.10", false],
    ["52.96.0.1", false],
  ] as const)("IPv4 %s → %s", (ip, expected) => {
    expect(isPrivateOrReservedIP(ip)).toBe(expected);
  });

  it.each([
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fe80::", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["2001:0db8::1", true],
    ["2620:1ec:c11::200", false],
    // IPv4-mapped IPv6 addresses
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:192.168.1.1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:8.8.8.8", false],
    ["::ffff:13.107.136.10", false],
  ] as const)("IPv6 %s → %s", (ip, expected) => {
    expect(isPrivateOrReservedIP(ip)).toBe(expected);
  });

  it.each([
    ["999.999.999.999", true],
    ["256.0.0.1", true],
    ["10.0.0.256", true],
    ["-1.0.0.1", false],
    ["1.2.3.4.5", false],
  ] as const)("malformed IPv4 %s → %s", (ip, expected) => {
    expect(isPrivateOrReservedIP(ip)).toBe(expected);
  });
});

// ─── validateConsentUploadUrl ────────────────────────────────────────────────

describe("validateConsentUploadUrl", () => {
  it("accepts a valid SharePoint HTTPS URL", async () => {
    await expect(
      validateConsentUploadUrl("https://contoso.sharepoint.com/sites/uploads/file.pdf", {
        resolveFn: publicResolve,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts subdomains of allowlisted domains", async () => {
    await expect(
      validateConsentUploadUrl(
        "https://contoso-my.sharepoint.com/personal/user/Documents/file.docx",
        { resolveFn: publicResolve },
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts graph.microsoft.com", async () => {
    await expect(
      validateConsentUploadUrl("https://graph.microsoft.com/v1.0/me/drive/items/123/content", {
        resolveFn: publicResolve,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects non-HTTPS URLs", async () => {
    await expect(
      validateConsentUploadUrl("http://contoso.sharepoint.com/file.pdf", {
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("must use HTTPS");
  });

  it("rejects invalid URLs", async () => {
    await expect(
      validateConsentUploadUrl("not a url", { resolveFn: publicResolve }),
    ).rejects.toThrow("not a valid URL");
  });

  it("rejects hosts not in the allowlist", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.example.com/exfil", { resolveFn: publicResolve }),
    ).rejects.toThrow("not in the allowed domains");
  });

  it("rejects an SSRF attempt with internal metadata URL", async () => {
    await expect(
      validateConsentUploadUrl("https://169.254.169.254/latest/meta-data/", {
        resolveFn: publicResolve,
      }),
    ).rejects.toThrow("not in the allowed domains");
  });

  it("rejects localhost", async () => {
    await expect(
      validateConsentUploadUrl("https://localhost:8080/internal", { resolveFn: publicResolve }),
    ).rejects.toThrow("not in the allowed domains");
  });

  it("rejects when DNS resolves to a private IPv4 (10.x)", async () => {
    await expect(
      validateConsentUploadUrl("https://malicious.sharepoint.com/exfil", {
        resolveFn: privateResolve("10.0.0.1"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when DNS resolves to loopback", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: privateResolve("127.0.0.1"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when DNS resolves to link-local (169.254.x.x)", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: privateResolve("169.254.169.254"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when DNS resolves to IPv6 loopback", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: privateResolve("::1"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when DNS resolves to IPv4-mapped IPv6 private address", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: privateResolve("::ffff:10.0.0.1"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when DNS resolves to IPv4-mapped IPv6 loopback", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: privateResolve("::ffff:127.0.0.1"),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("rejects when any DNS answer is private/reserved", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: multiResolve(["13.107.136.10", "10.0.0.1"]),
      }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("accepts when all DNS answers are public", async () => {
    await expect(
      validateConsentUploadUrl("https://evil.sharepoint.com/path", {
        resolveFn: multiResolve(["13.107.136.10", "52.96.0.1"]),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when DNS resolution fails", async () => {
    await expect(
      validateConsentUploadUrl("https://nonexistent.sharepoint.com/path", {
        resolveFn: failingResolve,
      }),
    ).rejects.toThrow("Failed to resolve");
  });

  it("accepts a custom allowlist", async () => {
    await expect(
      validateConsentUploadUrl("https://custom.example.org/file", {
        allowlist: ["example.org"],
        resolveFn: publicResolve,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects hosts that are suffix-tricked (e.g. notsharepoint.com)", async () => {
    await expect(
      validateConsentUploadUrl("https://notsharepoint.com/file", { resolveFn: publicResolve }),
    ).rejects.toThrow("not in the allowed domains");
  });

  it("rejects file:// protocol", async () => {
    await expect(
      validateConsentUploadUrl("file:///etc/passwd", { resolveFn: publicResolve }),
    ).rejects.toThrow("must use HTTPS");
  });
});

// ─── CONSENT_UPLOAD_HOST_ALLOWLIST ───────────────────────────────────────────

describe("CONSENT_UPLOAD_HOST_ALLOWLIST", () => {
  it("contains only Microsoft/SharePoint domains", () => {
    for (const domain of CONSENT_UPLOAD_HOST_ALLOWLIST) {
      expect(
        domain.includes("microsoft") ||
          domain.includes("sharepoint") ||
          domain.includes("onedrive") ||
          domain.includes("1drv") ||
          domain.includes("live.com"),
      ).toBe(true);
    }
  });

  it("does not contain overly broad domains", () => {
    const broad = [
      "microsoft.com",
      "azure.com",
      "blob.core.windows.net",
      "azureedge.net",
      "trafficmanager.net",
    ];
    for (const domain of broad) {
      expect(CONSENT_UPLOAD_HOST_ALLOWLIST).not.toContain(domain);
    }
  });
});

// ─── uploadToConsentUrl (integration with validation) ────────────────────────

describe("uploadToConsentUrl", () => {
  it("sends the OpenClaw User-Agent header with consent uploads", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await uploadToConsentUrl({
      url: "https://contoso.sharepoint.com/upload",
      buffer: Buffer.from("hello"),
      fetchFn,
      validationOpts: { resolveFn: publicResolve },
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, opts] = firstFetchCall(fetchFn);
    expect(url).toBe("https://contoso.sharepoint.com/upload");
    expect(opts?.method).toBe("PUT");
    expect(opts?.headers).toEqual({
      "Content-Range": "bytes 0-4/5",
      "Content-Type": "application/octet-stream",
      "User-Agent": buildUserAgent(),
    });
    expect(opts?.body).toEqual(new Uint8Array(Buffer.from("hello")));
  });

  it("blocks upload to a disallowed host", async () => {
    const mockFetch = vi.fn();
    await expect(
      uploadToConsentUrl({
        url: "https://evil.example.com/exfil",
        buffer: Buffer.from("secret data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: publicResolve },
      }),
    ).rejects.toThrow("not in the allowed domains");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks upload to a private IP", async () => {
    const mockFetch = vi.fn();
    await expect(
      uploadToConsentUrl({
        url: "https://compromised.sharepoint.com/upload",
        buffer: Buffer.from("data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: privateResolve("10.0.0.1") },
      }),
    ).rejects.toThrow("private/reserved IP");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows upload to a valid SharePoint URL and performs PUT", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const buffer = Buffer.from("file content");

    await uploadToConsentUrl({
      url: "https://contoso.sharepoint.com/sites/uploads/file.pdf",
      buffer,
      contentType: "application/pdf",
      fetchFn: mockFetch,
      validationOpts: { resolveFn: publicResolve },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = firstFetchCall(mockFetch);
    expect(url).toBe("https://contoso.sharepoint.com/sites/uploads/file.pdf");
    expect(opts?.method).toBe("PUT");
    expect(opts?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/pdf",
      }),
    );
  });

  it("throws on non-OK response after passing validation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await expect(
      uploadToConsentUrl({
        url: "https://contoso.sharepoint.com/sites/uploads/file.pdf",
        buffer: Buffer.from("data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: publicResolve },
      }),
    ).rejects.toThrow("File upload to consent URL failed: 403 Forbidden");
  });

  it("blocks HTTP (non-HTTPS) upload before fetch is called", async () => {
    const mockFetch = vi.fn();
    await expect(
      uploadToConsentUrl({
        url: "http://contoso.sharepoint.com/upload",
        buffer: Buffer.from("data"),
        fetchFn: mockFetch,
        validationOpts: { resolveFn: publicResolve },
      }),
    ).rejects.toThrow("must use HTTPS");

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
