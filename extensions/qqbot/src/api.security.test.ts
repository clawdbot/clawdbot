import { beforeEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

vi.mock("./utils/debug-log.js", () => ({
  debugError: vi.fn(),
  debugLog: vi.fn(),
}));

import { MediaFileType, uploadC2CMedia, uploadGroupMedia } from "./api.js";
import { clearUploadCache, computeFileHash, setCachedFileInfo } from "./utils/upload-cache.js";

describe("qqbot direct upload SSRF guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUploadCache();
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "example.com",
      addresses: ["203.0.113.10"],
      lookup: vi.fn(),
    });
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(JSON.stringify({ file_uuid: "uuid", file_info: "info", ttl: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: async () => {},
    });
  });

  it("blocks direct-upload URLs that target private or internal hosts", async () => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      uploadC2CMedia(
        "access-token",
        "user-1",
        MediaFileType.IMAGE,
        "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
      ),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("blocks non-HTTPS direct-upload URLs before the QQ upload request", async () => {
    await expect(
      uploadGroupMedia(
        "access-token",
        "group-1",
        MediaFileType.FILE,
        "http://cdn.qpic.cn/payload.txt",
      ),
    ).rejects.toThrow("Direct-upload media URL must use HTTPS");

    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("allows public HTTPS direct-upload URLs", async () => {
    const result = await uploadC2CMedia(
      "access-token",
      "user-1",
      MediaFileType.IMAGE,
      "https://example.com/payload.png",
    );

    expect(result).toEqual({ file_uuid: "uuid", file_info: "info", ttl: 3600 });
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com");
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  it("allows public HTTPS direct-upload URLs for group uploads", async () => {
    const result = await uploadGroupMedia(
      "access-token",
      "group-1",
      MediaFileType.FILE,
      "https://example.com/payload.txt",
    );

    expect(result).toEqual({ file_uuid: "uuid", file_info: "info", ttl: 3600 });
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com");
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  it("skips URL validation on c2c cache hits when fileData is reused", async () => {
    const fileData = "cached-file-data";
    setCachedFileInfo(
      computeFileHash(fileData),
      "c2c",
      "user-1",
      MediaFileType.IMAGE,
      "cached-info",
      "cached-uuid",
      3600,
    );

    const result = await uploadC2CMedia(
      "access-token",
      "user-1",
      MediaFileType.IMAGE,
      "https://example.com/stale.png",
      fileData,
    );

    expect(result).toEqual({ file_uuid: "", file_info: "cached-info", ttl: 0 });
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("skips URL validation on group cache hits when fileData is reused", async () => {
    const fileData = "cached-group-file-data";
    setCachedFileInfo(
      computeFileHash(fileData),
      "group",
      "group-1",
      MediaFileType.FILE,
      "cached-group-info",
      "cached-group-uuid",
      3600,
    );

    const result = await uploadGroupMedia(
      "access-token",
      "group-1",
      MediaFileType.FILE,
      "https://example.com/stale.txt",
      fileData,
    );

    expect(result).toEqual({ file_uuid: "", file_info: "cached-group-info", ttl: 0 });
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
