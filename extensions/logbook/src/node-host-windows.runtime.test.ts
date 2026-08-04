import { beforeEach, describe, expect, it, vi } from "vitest";

const { createRastermillMock, encodeMock, monitorAllMock } = vi.hoisted(() => ({
  createRastermillMock: vi.fn(),
  encodeMock: vi.fn(),
  monitorAllMock: vi.fn(),
}));

vi.mock("node-screenshots", () => ({ Monitor: { all: monitorAllMock } }));
vi.mock("rastermill", () => ({
  createRastermill: createRastermillMock.mockReturnValue({ encode: encodeMock }),
}));

import { captureWindowsLogbookSnapshot } from "./node-host-windows.runtime.js";

function monitor(
  png = Buffer.from("png"),
  metadata: { id?: number; isPrimary?: boolean; x?: number; y?: number } = {},
) {
  const toPng = vi.fn(async () => png);
  return {
    id: vi.fn(() => metadata.id ?? 1),
    isPrimary: vi.fn(() => metadata.isPrimary ?? true),
    x: vi.fn(() => metadata.x ?? 0),
    y: vi.fn(() => metadata.y ?? 0),
    toPng,
    captureImage: vi.fn(async () => ({ toPng })),
  };
}

describe("captureWindowsLogbookSnapshot", () => {
  beforeEach(() => {
    monitorAllMock.mockReset();
    encodeMock.mockReset();
  });

  it("captures the selected display and returns a normalized JPEG", async () => {
    const primary = monitor(Buffer.from("primary"), { id: 2, isPrimary: true, x: 0 });
    const secondPng = Buffer.from("second");
    const left = monitor(secondPng, { id: 1, isPrimary: false, x: -1920 });
    monitorAllMock.mockReturnValue([left, primary]);
    encodeMock.mockResolvedValue({
      data: Buffer.from("jpeg"),
      width: 1440,
      height: 900,
    });

    await expect(captureWindowsLogbookSnapshot({ screenIndex: 1 })).resolves.toEqual({
      format: "jpeg",
      base64: Buffer.from("jpeg").toString("base64"),
      width: 1440,
      height: 900,
    });
    expect(primary.captureImage).not.toHaveBeenCalled();
    expect(left.captureImage).toHaveBeenCalledOnce();
    expect(createRastermillMock).toHaveBeenCalledWith({
      execution: "internal",
      limits: { inputPixels: 100_000_000, outputPixels: 25_000_000 },
    });
    expect(encodeMock).toHaveBeenCalledWith(secondPng, {
      format: "jpeg",
      quality: 60,
      resize: { maxSide: 1440 },
    });
  });

  it("reports display enumeration failures", async () => {
    monitorAllMock.mockImplementation(() => {
      throw new Error("EnumDisplayMonitors failed");
    });

    await expect(captureWindowsLogbookSnapshot({})).resolves.toEqual({
      error: expect.stringMatching(
        /display enumeration failed: EnumDisplayMonitors failed.*interactive signed-in desktop session/,
      ),
    });
    expect(encodeMock).not.toHaveBeenCalled();
  });

  it("reports when the interactive desktop has no displays", async () => {
    monitorAllMock.mockReturnValue([]);

    await expect(captureWindowsLogbookSnapshot({})).resolves.toEqual({
      error: expect.stringMatching(/found no displays.*interactive signed-in desktop session/),
    });
    expect(encodeMock).not.toHaveBeenCalled();
  });

  it("reports an out-of-range display index with the valid config range", async () => {
    monitorAllMock.mockReturnValue([monitor(), monitor()]);

    await expect(captureWindowsLogbookSnapshot({ screenIndex: 4 })).resolves.toEqual({
      error: expect.stringMatching(
        /screenIndex 4 is unavailable.*2 display\(s\).*screenIndex to 0-1/,
      ),
    });
    expect(encodeMock).not.toHaveBeenCalled();
  });

  it("reports native capture failures separately from encoding failures", async () => {
    const display = monitor();
    display.captureImage.mockRejectedValue(new Error("Access is denied"));
    monitorAllMock.mockReturnValue([display]);

    await expect(captureWindowsLogbookSnapshot({})).resolves.toEqual({
      error: expect.stringMatching(
        /display 0 capture failed: Access is denied.*interactive signed-in desktop session/,
      ),
    });
    expect(encodeMock).not.toHaveBeenCalled();
  });

  it("reports PNG conversion failures as capture-stage failures", async () => {
    const display = monitor();
    display.toPng.mockRejectedValue(new Error("PNG encoder failed"));
    monitorAllMock.mockReturnValue([display]);

    await expect(captureWindowsLogbookSnapshot({})).resolves.toEqual({
      error: expect.stringMatching(/display 0 capture failed: PNG encoder failed/),
    });
    expect(encodeMock).not.toHaveBeenCalled();
  });

  it("applies the requested max side and clamps fractional JPEG quality", async () => {
    monitorAllMock.mockReturnValue([monitor()]);
    encodeMock.mockResolvedValue({ data: Buffer.from("jpeg"), width: 1600, height: 900 });

    await captureWindowsLogbookSnapshot({ maxWidth: 2000, quality: 0.01 });

    expect(encodeMock).toHaveBeenCalledWith(expect.any(Buffer), {
      format: "jpeg",
      quality: 10,
      resize: { maxSide: 2000 },
    });
  });

  it("reports Rastermill JPEG failures after capture", async () => {
    monitorAllMock.mockReturnValue([monitor()]);
    encodeMock.mockRejectedValue(new Error("Photon unavailable"));

    await expect(captureWindowsLogbookSnapshot({})).resolves.toEqual({
      error: expect.stringMatching(
        /was captured, but JPEG normalization failed: Photon unavailable.*restore Rastermill/,
      ),
    });
  });
});
