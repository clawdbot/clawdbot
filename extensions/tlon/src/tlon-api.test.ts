// Tlon tests cover tlon api plugin behavior.
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

const MEMEX_ENDPOINT = "https://memex.tlon.network/v1/zod/upload";
const MEMEX_UPLOAD_URL = "https://uploads.tlon.network/put";
const S3_UPLOAD_URL = "https://s3.example.com/uploads/file?sig=abc";
const AVATAR_UPLOAD = {
  blob: new Blob(["image-bytes"], { type: "image/png" }),
  fileName: "avatar.png",
  contentType: "image/png",
};

const MEMEX_STORAGE = {
  configuration: {
    currentBucket: "uploads",
    buckets: ["uploads"],
    publicUrlBase: "https://files.tlon.network/",
    presignedUrl: "https://files.tlon.network/presigned",
    region: "us-east-1",
    service: "presigned-url",
  },
  secret: "genuine-secret",
};

const CUSTOM_STORAGE = {
  configuration: {
    currentBucket: "uploads",
    buckets: ["uploads"],
    publicUrlBase: "https://files.example.com/",
    presignedUrl: "",
    region: "us-east-1",
    service: "custom",
  },
  credentials: {
    endpoint: "https://s3.example.com",
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "fake-secret",
  },
};

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

function createGuardedResult(
  response: Response,
  finalUrl: string,
  release: () => Promise<void> = mockRelease,
) {
  return {
    response,
    finalUrl,
    release,
  };
}

function responseWithCancelableBody(
  status: number,
  cancelBody: () => void | PromiseLike<void>,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel: cancelBody,
    }),
    { status },
  );
}

function guardedFetchCall(index: number): Parameters<typeof fetchWithSsrFGuard>[0] {
  const call = mockGuardedFetch.mock.calls[index]?.at(0);
  if (call === undefined) {
    throw new Error(`expected guarded fetch call ${index}`);
  }
  return call;
}

function configureTestClient(shipUrl: string, dangerouslyAllowPrivateNetwork?: boolean): void {
  configureClient({
    shipUrl,
    shipName: "~zod",
    verbose: false,
    getCode: async () => "123456",
    dangerouslyAllowPrivateNetwork,
  });
}

function mockStorageScry(params: {
  configuration: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  secret?: string;
}): void {
  mockScryUrbitPath.mockImplementation(async (_deps, { path }) => {
    if (path === "/storage/configuration.json") {
      return params.configuration;
    }
    if (path === "/storage/credentials.json") {
      return { "storage-update": params.credentials ? { credentials: params.credentials } : {} };
    }
    if (path === "/genuine/secret.json" && params.secret) {
      return { secret: params.secret };
    }
    throw new Error(`Unexpected scry path: ${path}`);
  });
}

function mockMemexLookup(uploadUrl = MEMEX_UPLOAD_URL, filePath?: string): void {
  mockGuardedFetch.mockResolvedValueOnce(
    createGuardedResult(createMemexResponse(uploadUrl, filePath), MEMEX_ENDPOINT),
  );
}

function mockGuardedResponse(
  finalUrl: string,
  response = new Response(null, { status: 200 }),
): void {
  mockGuardedFetch.mockResolvedValueOnce(createGuardedResult(response, finalUrl));
}

function uploadAvatar() {
  return uploadFile(AVATAR_UPLOAD);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadFile memex upload hardening", () => {
  beforeEach(() => {
    configureTestClient("https://groups.tlon.network");
    mockStorageScry(MEMEX_STORAGE);
  });

  it("routes the memex upload URL through the SSRF guard", async () => {
    const lookupResponse = createMemexResponse(MEMEX_UPLOAD_URL);
    const lookupCancel = vi.spyOn(lookupResponse.body!, "cancel");
    const uploadCancel = vi.fn();
    mockGuardedResponse(MEMEX_ENDPOINT, lookupResponse);
    mockGuardedResponse(MEMEX_UPLOAD_URL, responseWithCancelableBody(200, uploadCancel));

    const result = await uploadAvatar();

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
    expect(firstCall?.timeoutMs).toBe(30_000);
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
    expect(secondCall?.timeoutMs).toBe(300_000);
    expect(secondCall?.init?.body).toBeInstanceOf(Blob);
    expect(lookupCancel).not.toHaveBeenCalled();
    expect(uploadCancel).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("cancels failed Memex upload URL responses before releasing their guard", async () => {
    const events: string[] = [];
    const cancelBody = vi.fn(() => {
      events.push("cancel");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        responseWithCancelableBody(500, cancelBody),
        "https://memex.tlon.network/v1/zod/upload",
        release,
      ),
    );

    await expect(uploadAvatar()).rejects.toThrow("Memex upload request failed: 500");

    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["cancel", "release"]);
  });

  it("surfaces guarded upload failures for hosted Memex targets", async () => {
    mockMemexLookup();
    mockGuardedFetch.mockRejectedValueOnce(new Error("Blocked upload target"));

    await expect(uploadAvatar()).rejects.toThrow("Blocked upload target");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    const uploadCall = guardedFetchCall(1);
    expect(uploadCall?.url).toBe("https://uploads.tlon.network/put");
    expect(uploadCall?.auditContext).toBe("tlon-memex-upload");
    expect(uploadCall?.capture).toBe(false);
    expect(uploadCall?.maxRedirects).toBe(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("cancels failed Memex upload responses before releasing their guard", async () => {
    const cancelBody = vi.fn();
    mockMemexLookup();
    mockGuardedResponse(MEMEX_UPLOAD_URL, responseWithCancelableBody(500, cancelBody));

    await expect(uploadAvatar()).rejects.toThrow("Upload failed: 500");

    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("cancels hosted upload responses when their final URL is untrusted", async () => {
    const cancelBody = vi.fn();
    mockMemexLookup();
    mockGuardedResponse("https://evil.example/put", responseWithCancelableBody(200, cancelBody));

    await expect(uploadAvatar()).rejects.toThrow(
      "Memex final upload URL must target a trusted hosted Tlon domain",
    );

    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("rejects Memex upload targets outside the hosted Tlon domain allowlist", async () => {
    mockMemexLookup("https://eviltlon.network/upload");

    await expect(uploadAvatar()).rejects.toThrow(
      "Memex upload URL must target a trusted hosted Tlon domain",
    );

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects Memex hosted result URLs outside the hosted Tlon domain allowlist", async () => {
    mockMemexLookup(MEMEX_UPLOAD_URL, "https://evil.example/files/uploaded.png");
    mockGuardedResponse(MEMEX_UPLOAD_URL);

    await expect(uploadAvatar()).rejects.toThrow(
      "Memex hosted URL must target a trusted hosted Tlon domain",
    );

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("rejects Memex upload targets with a non-standard port", async () => {
    mockMemexLookup("https://uploads.tlon.network:8443/put");

    await expect(uploadAvatar()).rejects.toThrow(
      "Memex upload URL must not specify a non-standard port",
    );

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("disables redirects for Memex upload targets", async () => {
    mockMemexLookup();
    mockGuardedFetch.mockRejectedValueOnce(new Error("Too many redirects (limit: 0)"));

    await expect(uploadAvatar()).rejects.toThrow("Too many redirects (limit: 0)");

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    const uploadCall = guardedFetchCall(1);
    expect(uploadCall?.url).toBe("https://uploads.tlon.network/put");
    expect(uploadCall?.auditContext).toBe("tlon-memex-upload");
    expect(uploadCall?.capture).toBe(false);
    expect(uploadCall?.maxRedirects).toBe(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized Memex upload JSON response", async () => {
    const cancelBody = vi.fn();
    let bodyReads = 0;
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              bodyReads += 1;
              controller.enqueue(new Uint8Array(32 * 1024).fill(120));
            },
            cancel: cancelBody,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
        "https://memex.tlon.network/v1/zod/upload",
      ),
    );

    await expect(uploadAvatar()).rejects.toThrow("Memex upload: JSON response exceeds 65536 bytes");

    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(bodyReads).toBeLessThan(10);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("routes scheme-less hosted ship URLs through the Memex upload path", async () => {
    configureTestClient("foo.tlon.network");
    mockMemexLookup();
    mockGuardedResponse(MEMEX_UPLOAD_URL);

    const result = await uploadAvatar();

    expect(result).toEqual({ url: "https://memex.tlon.network/files/uploaded.png" });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("rejects truly unparseable ship URLs as not hosted", async () => {
    configureTestClient("   ");
    mockStorageScry({ configuration: MEMEX_STORAGE.configuration });

    await expect(uploadAvatar()).rejects.toThrow("No storage credentials configured");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(mockGuardedFetch).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("accepts hosted Memex upload URLs with an explicit :443 port", async () => {
    const uploadUrl = "https://uploads.tlon.network:443/put";
    mockMemexLookup(uploadUrl);
    mockGuardedResponse(uploadUrl);

    const result = await uploadAvatar();

    expect(result).toEqual({ url: "https://memex.tlon.network/files/uploaded.png" });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it("disables redirects for the Memex upload URL lookup", async () => {
    mockGuardedFetch.mockRejectedValueOnce(new Error("Too many redirects (limit: 0)"));

    await expect(uploadAvatar()).rejects.toThrow("Too many redirects (limit: 0)");

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
    configureTestClient("https://ship.example.com");
    mockStorageScry(CUSTOM_STORAGE);
  });

  it("routes the custom S3 signed URL through the SSRF guard", async () => {
    const cancelBody = vi.fn(async () => {
      throw new Error("stream cancellation failed");
    });
    mockGetSignedUrl.mockResolvedValueOnce(S3_UPLOAD_URL);
    mockGuardedResponse(S3_UPLOAD_URL, responseWithCancelableBody(200, cancelBody));

    const result = await uploadAvatar();

    expect(result.url.startsWith("https://files.example.com/")).toBe(true);
    const signedUrlCall = mockGetSignedUrl.mock.calls[0];
    if (!signedUrlCall) {
      throw new Error("expected S3 signed URL call");
    }
    expect((await signedUrlCall[0].config.endpoint()).protocol).toBe("https:");
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    const uploadCall = guardedFetchCall(0);
    expect(uploadCall?.url).toBe("https://s3.example.com/uploads/file?sig=abc");
    expect(uploadCall?.init?.method).toBe("PUT");
    expect(uploadCall?.init?.headers).toBeUndefined();
    expect(uploadCall?.auditContext).toBe("tlon-custom-s3-upload");
    expect(uploadCall?.capture).toBe(false);
    expect(uploadCall?.maxRedirects).toBe(0);
    expect(uploadCall?.timeoutMs).toBe(300_000);
    expect(uploadCall?.policy).toBeUndefined();
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("surfaces guarded upload failures for custom S3 targets without calling release", async () => {
    mockGetSignedUrl.mockResolvedValueOnce("https://169.254.169.254/uploads/file?sig=abc");
    mockGuardedFetch.mockRejectedValueOnce(new Error("Blocked private network target"));

    await expect(uploadAvatar()).rejects.toThrow("Blocked private network target");

    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("cancels failed custom S3 upload responses before releasing their guard", async () => {
    const cancelBody = vi.fn();
    mockGetSignedUrl.mockResolvedValueOnce(S3_UPLOAD_URL);
    mockGuardedResponse(S3_UPLOAD_URL, responseWithCancelableBody(500, cancelBody));

    await expect(uploadAvatar()).rejects.toThrow("Upload failed: 500");

    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("passes the private-network opt-in to guarded custom S3 uploads", async () => {
    configureTestClient("https://ship.example.com", true);
    mockGetSignedUrl.mockResolvedValueOnce("https://10.0.0.15/uploads/file?sig=abc");
    mockGuardedFetch.mockResolvedValueOnce(
      createGuardedResult(
        new Response(null, { status: 200 }),
        "https://10.0.0.15/uploads/file?sig=abc",
      ),
    );

    const result = await uploadAvatar();

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
    mockStorageScry({
      ...CUSTOM_STORAGE,
      configuration: {
        ...CUSTOM_STORAGE.configuration,
        publicUrlBase: "ftp://files.example.com/",
      },
    });
    mockGetSignedUrl.mockResolvedValueOnce(S3_UPLOAD_URL);
    mockGuardedResponse(S3_UPLOAD_URL);

    await expect(uploadAvatar()).rejects.toThrow("Upload result URL must use http or https");

    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
