import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./urbit/auth.js";
import { scryUrbitPath } from "./urbit/channel-ops.js";

const { mockFetchGuard, mockRelease, mockGetSignedUrl } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(),
  mockRelease: vi.fn(async () => {}),
  mockGetSignedUrl: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/ssrf-runtime")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    fetchWithSsrFGuard: mockFetchGuard,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("./urbit/auth.js", () => ({
  authenticate: vi.fn(),
}));

vi.mock("./urbit/channel-ops.js", () => ({
  scryUrbitPath: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { configureClient, uploadFile } from "./tlon-api.js";

const mockAuthenticate = vi.mocked(authenticate);
const mockScryUrbitPath = vi.mocked(scryUrbitPath);
const mockGuardedFetch = vi.mocked(fetchWithSsrFGuard);

function createMemexResponse(
  uploadUrl: string,
  filePath = "https://memex.tlon.network/files/uploaded.png",
): Response {
  return new Response(
    JSON.stringify({
      url: uploadUrl,
      filePath,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function createGuardedResult(response: Response, finalUrl: string) {
  return {
    response,
    finalUrl,
    release: mockRelease,
  };
}

function guardedFetchCall(index: number): Parameters<typeof fetchWithSsrFGuard>[0] {
  const call = mockGuardedFetch.mock.calls.at(index)?.at(0);
  if (call === undefined) {
    throw new Error(`expected guarded fetch call ${index}`);
  }
  return call;
}

describe("uploadFile memex upload hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
    configureClient({
      shipUrl: "https://groups.tlon.network",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
    });
    mockScryUrbitPath.mockImplementation(async (_deps, params) => {
      if (params.path === "/storage/configuration.json") {
        return {
          currentBucket: "uploads",
          buckets: ["uploads"],
          publicUrlBase: "https://files.tlon.network/",
          presignedUrl: "https://files.tlon.network/presigned",
          region: "us-east-1",
          service: "presigned-url",
        };
      }
      if (params.path === "/storage/credentials.json") {
        return { "storage-update": {} };
      }
      if (params.path === "/genuine/secret.json") {
        return { secret: "genuine-secret" };
      }
      throw new Error(`Unexpected scry path: ${params.path}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes the memex upload URL through the SSRF guard", async () => {
    mockGuardedFetch
      .mockResolvedValueOnce(
        createGuardedResult(
          createMemexResponse("https://uploads.tlon.network/put"),
          "https://memex.tlon.network/v1/zod/upload",
        ),
      )
      .mockResolvedValueOnce(
        createGuardedResult(
          new Response(null, { status: 200 }),
          "https://uploads.tlon.network/put",
        ),
      );

    const result = await uploadFile({
      blob: new Blob(["image-bytes"], { type: "image/png" }),
      fileName: "avatar.png",
      contentType: "image/png",
    });

    expect(result).toEqual({ url: "https://memex.tlon.network/files/uploaded.png" });
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    const firstCall = guardedFetchCall(0);
    expect(firstCall?.url).toBe("https://memex.tlon.network/v1/zod/upload");
    expect(firstCall?.init?.method).toBe("PUT");
    expect(firstCall?.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(firstCall?.auditContext).toBe("tlon-memex-upload-url");
    expect(firstCall?.capture).toBe(false);
    expect(firstCall?.maxRedirects).toBe(0);
    const firstBodyRaw = firstCall?.init?.body;
    expect(typeof firstBodyRaw).toBe("string");
    const firstBody = JSON.parse(firstBodyRaw as string) as Record<string, unknown>;
    expect(firstBody.token).toBe("genuine-secret");
    expect(firstBody.contentLength).toBe(11);
    expect(firstBody.contentType).toBe("image/png");
    expect(typeof firstBody.fileName).toBe("string");
    const secondCall = guardedFetchCall(1);
    expect(secondCall?.url).toBe("https://uploads.tlon.network/put");
    expect(secondCall?.init?.method).toBe("PUT");
    expect(secondCall?.init?.headers).toEqual({
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "image/png",
    });
    expect(secondCall?.auditContext).toBe("tlon-memex-upload");
    expect(secondCall?.capture).toBe(false);
    expect(secondCall?.maxRedirects).toBe(0);
    expect(secondCall?.init?.body).toBeInstanceOf(Blob);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("surfaces guarded upload failures for hosted Memex targets", async () => {
    mockGuardedFetch
      .mockResolvedValueOnce(
        createGuardedResult(
          createMemexResponse("https://uploads.tlon.network/put"),
          "https://memex.tlon.network/v1/zod/upload",
        ),
      )
      .mockRejectedValueOnce(new Error("Blocked upload target"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Blocked upload target");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    const uploadCall = guardedFetchCall(1);
    expect(uploadCall?.url).toBe("https://uploads.tlon.network/put");
    expect(uploadCall?.auditContext).toBe("tlon-memex-upload");
    expect(uploadCall?.capture).toBe(false);
    expect(uploadCall?.maxRedirects).toBe(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects Memex upload targets outside the hosted Tlon domain allowlist", async () => {
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        createMemexResponse("https://eviltlon.network/upload"),
        "https://memex.tlon.network/v1/zod/upload",
      ),
    );

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Memex upload URL must target a trusted hosted Tlon domain");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects Memex hosted result URLs outside the hosted Tlon domain allowlist", async () => {
    mockGuardedFetch
      .mockResolvedValueOnce(
        createGuardedResult(
          createMemexResponse(
            "https://uploads.tlon.network/put",
            "https://evil.example/files/uploaded.png",
          ),
          "https://memex.tlon.network/v1/zod/upload",
        ),
      )
      .mockResolvedValueOnce(
        createGuardedResult(
          new Response(null, { status: 200 }),
          "https://uploads.tlon.network/put",
        ),
      );

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Memex hosted URL must target a trusted hosted Tlon domain");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("rejects Memex upload targets with a non-standard port", async () => {
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        createMemexResponse("https://uploads.tlon.network:8443/put"),
        "https://memex.tlon.network/v1/zod/upload",
      ),
    );

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Memex upload URL must not specify a non-standard port");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("disables redirects for Memex upload targets", async () => {
    mockGuardedFetch
      .mockResolvedValueOnce(
        createGuardedResult(
          createMemexResponse("https://uploads.tlon.network/put"),
          "https://memex.tlon.network/v1/zod/upload",
        ),
      )
      .mockRejectedValueOnce(new Error("Too many redirects (limit: 0)"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Too many redirects (limit: 0)");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    const uploadCall = guardedFetchCall(1);
    expect(uploadCall?.url).toBe("https://uploads.tlon.network/put");
    expect(uploadCall?.auditContext).toBe("tlon-memex-upload");
    expect(uploadCall?.capture).toBe(false);
    expect(uploadCall?.maxRedirects).toBe(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("routes scheme-less hosted ship URLs through the Memex upload path", async () => {
    configureClient({
      shipUrl: "foo.tlon.network",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
    });
    mockGuardedFetch
      .mockResolvedValueOnce(
        createGuardedResult(
          createMemexResponse("https://uploads.tlon.network/put"),
          "https://memex.tlon.network/v1/zod/upload",
        ),
      )
      .mockResolvedValueOnce(
        createGuardedResult(
          new Response(null, { status: 200 }),
          "https://uploads.tlon.network/put",
        ),
      );

    const result = await uploadFile({
      blob: new Blob(["image-bytes"], { type: "image/png" }),
      fileName: "avatar.png",
      contentType: "image/png",
    });

    expect(result).toEqual({ url: "https://memex.tlon.network/files/uploaded.png" });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("rejects truly unparseable ship URLs as not hosted", async () => {
    configureClient({
      shipUrl: "   ",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
    });
    mockScryUrbitPath.mockImplementation(async (_deps, params) => {
      if (params.path === "/storage/configuration.json") {
        return {
          currentBucket: "uploads",
          buckets: ["uploads"],
          publicUrlBase: "https://files.tlon.network/",
          presignedUrl: "https://files.tlon.network/presigned",
          region: "us-east-1",
          service: "presigned-url",
        };
      }
      if (params.path === "/storage/credentials.json") {
        return { "storage-update": {} };
      }
      throw new Error(`Unexpected scry path: ${params.path}`);
    });

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("No storage credentials configured");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("accepts hosted Memex upload URLs with an explicit :443 port", async () => {
    mockGuardedFetch
      .mockResolvedValueOnce(
        createGuardedResult(
          createMemexResponse("https://uploads.tlon.network:443/put"),
          "https://memex.tlon.network/v1/zod/upload",
        ),
      )
      .mockResolvedValueOnce(
        createGuardedResult(
          new Response(null, { status: 200 }),
          "https://uploads.tlon.network:443/put",
        ),
      );

    const result = await uploadFile({
      blob: new Blob(["image-bytes"], { type: "image/png" }),
      fileName: "avatar.png",
      contentType: "image/png",
    });

    expect(result).toEqual({ url: "https://memex.tlon.network/files/uploaded.png" });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("disables redirects for the Memex upload URL lookup", async () => {
    mockGuardedFetch.mockRejectedValueOnce(new Error("Too many redirects (limit: 0)"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Too many redirects (limit: 0)");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    const lookupCall = guardedFetchCall(0);
    expect(lookupCall?.url).toBe("https://memex.tlon.network/v1/zod/upload");
    expect(lookupCall?.auditContext).toBe("tlon-memex-upload-url");
    expect(lookupCall?.capture).toBe(false);
    expect(lookupCall?.maxRedirects).toBe(0);
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe("uploadFile custom S3 upload hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
    configureClient({
      shipUrl: "https://ship.example.com",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
    });
    mockScryUrbitPath.mockImplementation(async (_deps, params) => {
      if (params.path === "/storage/configuration.json") {
        return {
          currentBucket: "uploads",
          buckets: ["uploads"],
          publicUrlBase: "https://files.example.com/",
          presignedUrl: "",
          region: "us-east-1",
          service: "custom",
        };
      }
      if (params.path === "/storage/credentials.json") {
        return {
          "storage-update": {
            credentials: {
              endpoint: "https://s3.example.com",
              accessKeyId: "AKIAFAKE",
              secretAccessKey: "fake-secret",
            },
          },
        };
      }
      throw new Error(`Unexpected scry path: ${params.path}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes the custom S3 signed URL through the SSRF guard", async () => {
    mockGetSignedUrl.mockResolvedValueOnce("https://s3.example.com/uploads/file?sig=abc");
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        new Response(null, { status: 200 }),
        "https://s3.example.com/uploads/file?sig=abc",
      ),
    );

    const result = await uploadFile({
      blob: new Blob(["image-bytes"], { type: "image/png" }),
      fileName: "avatar.png",
      contentType: "image/png",
    });

    expect(result.url.startsWith("https://files.example.com/")).toBe(true);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    const uploadCall = guardedFetchCall(0);
    expect(uploadCall?.url).toBe("https://s3.example.com/uploads/file?sig=abc");
    expect(uploadCall?.init?.method).toBe("PUT");
    expect(uploadCall?.init?.headers).toBeUndefined();
    expect(uploadCall?.auditContext).toBe("tlon-custom-s3-upload");
    expect(uploadCall?.capture).toBe(false);
    expect(uploadCall?.maxRedirects).toBe(0);
    expect(uploadCall?.policy).toBeUndefined();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("surfaces guarded upload failures for custom S3 targets without calling release", async () => {
    mockGetSignedUrl.mockResolvedValueOnce("https://169.254.169.254/uploads/file?sig=abc");
    mockGuardedFetch.mockRejectedValueOnce(new Error("Blocked private network target"));

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Blocked private network target");

    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("passes the private-network opt-in to guarded custom S3 uploads", async () => {
    configureClient({
      shipUrl: "https://ship.example.com",
      shipName: "~zod",
      verbose: false,
      getCode: async () => "123456",
      dangerouslyAllowPrivateNetwork: true,
    });
    mockGetSignedUrl.mockResolvedValueOnce("https://10.0.0.15/uploads/file?sig=abc");
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        new Response(null, { status: 200 }),
        "https://10.0.0.15/uploads/file?sig=abc",
      ),
    );

    const result = await uploadFile({
      blob: new Blob(["image-bytes"], { type: "image/png" }),
      fileName: "avatar.png",
      contentType: "image/png",
    });

    expect(result.url.startsWith("https://files.example.com/")).toBe(true);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    const uploadCall = guardedFetchCall(0);
    expect(uploadCall?.url).toBe("https://10.0.0.15/uploads/file?sig=abc");
    expect(uploadCall?.auditContext).toBe("tlon-custom-s3-upload");
    expect(uploadCall?.capture).toBe(false);
    expect(uploadCall?.maxRedirects).toBe(0);
    expect(uploadCall?.policy).toEqual({ allowPrivateNetwork: true });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects custom S3 result URLs that are not http(s)", async () => {
    mockScryUrbitPath.mockImplementation(async (_deps, params) => {
      if (params.path === "/storage/configuration.json") {
        return {
          currentBucket: "uploads",
          buckets: ["uploads"],
          publicUrlBase: "ftp://files.example.com/",
          presignedUrl: "",
          region: "us-east-1",
          service: "custom",
        };
      }
      if (params.path === "/storage/credentials.json") {
        return {
          "storage-update": {
            credentials: {
              endpoint: "https://s3.example.com",
              accessKeyId: "AKIAFAKE",
              secretAccessKey: "fake-secret",
            },
          },
        };
      }
      throw new Error(`Unexpected scry path: ${params.path}`);
    });
    mockGetSignedUrl.mockResolvedValueOnce("https://s3.example.com/uploads/file?sig=abc");
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        new Response(null, { status: 200 }),
        "https://s3.example.com/uploads/file?sig=abc",
      ),
    );

    await expect(
      uploadFile({
        blob: new Blob(["image-bytes"], { type: "image/png" }),
        fileName: "avatar.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow("Upload result URL must use http or https");

    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
