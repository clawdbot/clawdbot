import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  MediaFileType,
  type UploadMediaResponse,
  type UploadPrepareResponse,
} from "../types.js";
import type { ApiClient } from "./api-client.js";
import {
  ChunkedMediaApi,
  UploadDailyLimitExceededError,
  isChunkedUploadImplemented,
} from "./media-chunked.js";
import type { UploadCacheAdapter } from "./media.js";
import { UPLOAD_PREPARE_FALLBACK_CODE } from "./retry.js";
import type { TokenManager } from "./token.js";

// ============ Test doubles ============

/** Build a minimal ApiClient stub whose `request` is fully mockable. */
function mockApiClient(): ApiClient & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(),
  } as unknown as ApiClient & { request: ReturnType<typeof vi.fn> };
}

/** Minimal TokenManager stub returning a static token. */
function mockTokenManager(token = "test-token"): TokenManager {
  return {
    getAccessToken: vi.fn().mockResolvedValue(token),
  } as unknown as TokenManager;
}

/** In-memory upload-cache adapter. */
function inMemoryCache(): UploadCacheAdapter & {
  getSpy: ReturnType<typeof vi.fn>;
  setSpy: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>();
  const getSpy = vi.fn(
    (hash: string, scope: string, targetId: string, fileType: number) =>
      store.get(`${hash}:${scope}:${targetId}:${fileType}`) ?? null,
  );
  const setSpy = vi.fn(
    (hash: string, scope: string, targetId: string, fileType: number, fileInfo: string) => {
      store.set(`${hash}:${scope}:${targetId}:${fileType}`, fileInfo);
    },
  );
  return {
    computeHash: (data: string | Uint8Array) => crypto.createHash("md5").update(data).digest("hex"),
    get: getSpy,
    set: setSpy,
    getSpy,
    setSpy,
  };
}

/** Build a canned upload_prepare response with `parts` presigned URLs. */
function makePrepareResponse(uploadId: string, parts: number): UploadPrepareResponse {
  return {
    upload_id: uploadId,
    block_size: 8,
    parts: Array.from({ length: parts }, (_, i) => ({
      index: i + 1,
      presigned_url: `https://cos.example.com/part-${i + 1}`,
    })),
    concurrency: 2,
    retry_timeout: 60,
  };
}

/** Fixture: a 20-byte buffer that spans 3 parts at block_size=8. */
const FIXTURE_BUFFER = Buffer.from("0123456789abcdefghij"); // 20 bytes

// ============ fetch stub for COS PUT ============

let originalFetch: typeof globalThis.fetch;

function stubFetchOk(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(
    async () =>
      new Response("", {
        status: 200,
        headers: {
          ETag: '"etag-value"',
          "x-cos-request-id": "req-id",
        },
      }),
  );
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

// ============ Tests ============

describe("media-chunked: UploadDailyLimitExceededError", () => {
  it("captures filePath / fileSize / message", () => {
    const err = new UploadDailyLimitExceededError("/tmp/x.mp4", 123, "quota exceeded");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UploadDailyLimitExceededError");
    expect(err.filePath).toBe("/tmp/x.mp4");
    expect(err.fileSize).toBe(123);
    expect(err.message).toBe("quota exceeded");
  });
});

describe("media-chunked: isChunkedUploadImplemented", () => {
  it("returns true for the filled-in module", () => {
    expect(isChunkedUploadImplemented()).toBe(true);
  });
});

describe("media-chunked: ChunkedMediaApi.uploadChunked", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects url / base64 sources up-front", async () => {
    const client = mockApiClient();
    const tm = mockTokenManager();
    const api = new ChunkedMediaApi(client, tm);

    await expect(
      api.uploadChunked({
        scope: "c2c",
        targetId: "u1",
        fileType: MediaFileType.IMAGE,
        source: { kind: "url", url: "https://x" },
        creds: { appId: "a", clientSecret: "s" },
      }),
    ).rejects.toThrow(/unsupported source kind 'url'/);

    await expect(
      api.uploadChunked({
        scope: "c2c",
        targetId: "u1",
        fileType: MediaFileType.IMAGE,
        source: { kind: "base64", data: "AA==" },
        creds: { appId: "a", clientSecret: "s" },
      }),
    ).rejects.toThrow(/unsupported source kind 'base64'/);

    expect(client.request).not.toHaveBeenCalled();
  });

  it("takes the cache fast path and skips upload_prepare on hit", async () => {
    const client = mockApiClient();
    const tm = mockTokenManager();
    const cache = inMemoryCache();

    // Seed cache with the md5 that uploadChunked will compute.
    const md5 = crypto.createHash("md5").update(FIXTURE_BUFFER).digest("hex");
    cache.set(md5, "c2c", "u1", MediaFileType.IMAGE, "cached-file-info", "uuid", 999);

    const api = new ChunkedMediaApi(client, tm, { uploadCache: cache });

    const result = await api.uploadChunked({
      scope: "c2c",
      targetId: "u1",
      fileType: MediaFileType.IMAGE,
      source: { kind: "buffer", buffer: FIXTURE_BUFFER },
      creds: { appId: "a", clientSecret: "s" },
    });

    expect(result.file_info).toBe("cached-file-info");
    expect(client.request).not.toHaveBeenCalled();
    expect(cache.getSpy).toHaveBeenCalledWith(md5, "c2c", "u1", MediaFileType.IMAGE);
  });

  it("runs prepare → COS PUT → part_finish → complete for a buffer source", async () => {
    const client = mockApiClient();
    const tm = mockTokenManager();
    const cache = inMemoryCache();
    const fetchSpy = stubFetchOk();

    const prepareResp = makePrepareResponse("uid-1", 3);
    const completeResp: UploadMediaResponse = {
      file_uuid: "uuid-final",
      file_info: "final-file-info",
      ttl: 3600,
    };

    // First request: upload_prepare; three follow-ups: upload_part_finish ×3
    // plus one complete. Because concurrency=2 the order of part_finish is
    // not strictly deterministic, so match on path + payload key.
    client.request.mockImplementation(
      async (_token: string, _method: string, path: string, body: Record<string, unknown>) => {
        if (path.endsWith("/upload_prepare")) {
          expect(body.file_type).toBe(MediaFileType.FILE);
          expect(typeof body.md5).toBe("string");
          expect(typeof body.sha1).toBe("string");
          expect(typeof body.md5_10m).toBe("string");
          expect(body.file_size).toBe(FIXTURE_BUFFER.length);
          return prepareResp;
        }
        if (path.endsWith("/upload_part_finish")) {
          expect(body.upload_id).toBe("uid-1");
          expect(typeof body.part_index).toBe("number");
          return {};
        }
        if (path.endsWith("/files")) {
          expect(body.upload_id).toBe("uid-1");
          return completeResp;
        }
        throw new Error(`unexpected path ${path}`);
      },
    );

    const api = new ChunkedMediaApi(client, tm, { uploadCache: cache });
    const onProgress = vi.fn();

    const result = await api.uploadChunked({
      scope: "group",
      targetId: "g1",
      fileType: MediaFileType.FILE,
      source: { kind: "buffer", buffer: FIXTURE_BUFFER, fileName: "blob.bin" },
      creds: { appId: "a", clientSecret: "s" },
      onProgress,
    });

    expect(result).toEqual(completeResp);

    // One prepare + 3 part_finish + 1 complete = 5 client requests.
    expect(client.request).toHaveBeenCalledTimes(5);

    // 3 COS PUTs, one per part, each to the presigned URL.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const putUrls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(putUrls).toEqual(
      expect.arrayContaining([
        "https://cos.example.com/part-1",
        "https://cos.example.com/part-2",
        "https://cos.example.com/part-3",
      ]),
    );

    // Cache populated with the complete result.
    const expectedMd5 = crypto.createHash("md5").update(FIXTURE_BUFFER).digest("hex");
    expect(cache.setSpy).toHaveBeenCalledWith(
      expectedMd5,
      "group",
      "g1",
      MediaFileType.FILE,
      "final-file-info",
      "uuid-final",
      3600,
    );

    // Progress callback hit 3 times with monotonically-increasing counts.
    expect(onProgress).toHaveBeenCalledTimes(3);
    const last = onProgress.mock.calls[2][0];
    expect(last.completedParts).toBe(3);
    expect(last.totalParts).toBe(3);
    expect(last.uploadedBytes).toBe(FIXTURE_BUFFER.length);
    expect(last.totalBytes).toBe(FIXTURE_BUFFER.length);
  });

  it("maps UPLOAD_PREPARE_FALLBACK_CODE to UploadDailyLimitExceededError", async () => {
    const client = mockApiClient();
    const tm = mockTokenManager();
    client.request.mockRejectedValueOnce(
      new ApiError(
        "daily limit exceeded",
        200,
        "/v2/users/u1/upload_prepare",
        UPLOAD_PREPARE_FALLBACK_CODE,
        "quota",
      ),
    );

    const api = new ChunkedMediaApi(client, tm);
    await expect(
      api.uploadChunked({
        scope: "c2c",
        targetId: "u1",
        fileType: MediaFileType.FILE,
        source: { kind: "buffer", buffer: FIXTURE_BUFFER, fileName: "big.bin" },
        creds: { appId: "a", clientSecret: "s" },
      }),
    ).rejects.toBeInstanceOf(UploadDailyLimitExceededError);
  });

  it("streams hashes from a localPath source", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chunked-"));
    const filePath = path.join(tmp, "fixture.bin");
    await fs.promises.writeFile(filePath, FIXTURE_BUFFER);
    try {
      const client = mockApiClient();
      const tm = mockTokenManager();
      stubFetchOk();

      client.request.mockImplementation(async (_t, _m, p) => {
        if (p.endsWith("/upload_prepare")) {
          return makePrepareResponse("uid-2", 3);
        }
        if (p.endsWith("/upload_part_finish")) {
          return {};
        }
        if (p.endsWith("/files")) {
          return { file_uuid: "u", file_info: "fi", ttl: 10 } satisfies UploadMediaResponse;
        }
        throw new Error(`unexpected ${p}`);
      });

      const api = new ChunkedMediaApi(client, tm);
      const result = await api.uploadChunked({
        scope: "c2c",
        targetId: "u1",
        fileType: MediaFileType.VIDEO,
        source: { kind: "localPath", path: filePath, size: FIXTURE_BUFFER.length },
        creds: { appId: "a", clientSecret: "s" },
      });

      expect(result.file_info).toBe("fi");

      // Verify prepare received the md5 of the on-disk bytes.
      const prepareCall = client.request.mock.calls.find((c) =>
        String(c[2]).endsWith("/upload_prepare"),
      )!;
      const prepareBody = prepareCall[3] as { md5: string; file_name: string };
      expect(prepareBody.md5).toBe(crypto.createHash("md5").update(FIXTURE_BUFFER).digest("hex"));
      expect(prepareBody.file_name).toBe("fixture.bin");
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});
