// Qqbot tests cover upload cache plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  debugLog: vi.fn(),
}));

vi.mock("./log.js", () => ({
  debugLog: (...args: unknown[]) => mocks.debugLog(...args),
}));

import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "./upload-cache.js";

describe("qqbot upload-cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mocks.debugLog.mockReset();
  });

  it("reuses cached file info before expiry", () => {
    const hash = computeFileHash("qqbot-cache-hit");

    setCachedFileInfo(hash, "group", "target-hit", 1, "file-info-hit", "uuid-hit", 3600);

    expect(getCachedFileInfo(hash, "group", "target-hit", 1)).toBe("file-info-hit");
  });

  it("drops cached file info when the current clock is invalid", () => {
    const hash = computeFileHash("qqbot-invalid-clock");
    setCachedFileInfo(hash, "group", "target-invalid-clock", 1, "file-info-invalid", "uuid", 3600);
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);

    expect(getCachedFileInfo(hash, "group", "target-invalid-clock", 1)).toBeNull();
  });

  it("does not cache file info when ttl expiry exceeds the Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const hash = computeFileHash("qqbot-overflow");

    setCachedFileInfo(hash, "group", "target-overflow", 1, "file-info-overflow", "uuid", 3600);

    expect(getCachedFileInfo(hash, "group", "target-overflow", 1)).toBeNull();
  });

  it("logs cache keys without splitting surrogate pairs", () => {
    const hash = computeFileHash("qqbot-surrogate-key");
    const keyPrefix = `${hash}:group:`;

    setCachedFileInfo(hash, "group", "😀target", 1, "file-info", "uuid-safe", 3600);
    expect(getCachedFileInfo(hash, "group", "😀target", 1)).toBe("file-info");

    expect(mocks.debugLog).toHaveBeenNthCalledWith(
      1,
      `[upload-cache] Cache SET: key=${keyPrefix}..., ttl=3540s, uuid=uuid-safe`,
    );
    expect(mocks.debugLog).toHaveBeenNthCalledWith(
      2,
      `[upload-cache] Cache HIT: key=${keyPrefix}..., fileUuid=uuid-safe`,
    );
  });
});
