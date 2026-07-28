// Whatsapp tests cover WA Web socket version resolution.
import { describe, expect, it, vi } from "vitest";
import { resolveWaSocketVersion } from "./session-version.js";
import { fetchLatestBaileysVersion, fetchLatestWaWebVersion } from "./session.runtime.js";

vi.mock("./session.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./session.runtime.js")>("./session.runtime.js");
  return {
    ...actual,
    fetchLatestBaileysVersion: vi.fn(),
    fetchLatestWaWebVersion: vi.fn(),
  };
});

const fetchLiveMock = vi.mocked(fetchLatestWaWebVersion);
const fetchPinnedMock = vi.mocked(fetchLatestBaileysVersion);

function stubLogger() {
  return { warn: vi.fn() };
}

describe("resolveWaSocketVersion", () => {
  it("prefers the live web.whatsapp.com version", async () => {
    fetchLiveMock.mockResolvedValueOnce({ version: [2, 3000, 999], isLatest: true });
    await expect(resolveWaSocketVersion(stubLogger())).resolves.toEqual([2, 3000, 999]);
    expect(fetchPinnedMock).not.toHaveBeenCalled();
  });

  it("falls back to the pinned Baileys version when the live lookup is not latest", async () => {
    fetchLiveMock.mockResolvedValueOnce({
      version: [2, 3000, 1],
      isLatest: false,
      error: { message: "Could not find client revision" },
    } as never);
    fetchPinnedMock.mockResolvedValueOnce({ version: [2, 3000, 2], isLatest: true });
    const logger = stubLogger();
    await expect(resolveWaSocketVersion(logger)).resolves.toEqual([2, 3000, 2]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("falls back to the pinned Baileys version when the live lookup throws", async () => {
    fetchLiveMock.mockRejectedValueOnce(new Error("network down"));
    fetchPinnedMock.mockResolvedValueOnce({ version: [2, 3000, 3], isLatest: true });
    await expect(resolveWaSocketVersion(stubLogger())).resolves.toEqual([2, 3000, 3]);
  });
});
