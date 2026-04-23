import { beforeEach, describe, expect, it, vi } from "vitest";

const renderPngBase64 = vi.hoisted(() => vi.fn(async () => "mocked-base64"));

vi.mock("@vincentkoc/qrcode-tui", () => ({
  renderPngBase64,
}));

import { renderQrPngBase64 } from "./qr-image.ts";

describe("renderQrPngBase64", () => {
  beforeEach(() => {
    renderPngBase64.mockClear();
  });

  it("delegates PNG rendering to qrcode-tui", async () => {
    await expect(renderQrPngBase64("openclaw", { scale: 8, marginModules: 2 })).resolves.toBe(
      "mocked-base64",
    );
    expect(renderPngBase64).toHaveBeenCalledWith("openclaw", {
      margin: 2,
      scale: 8,
    });
  });

  it("uses the default PNG rendering options", async () => {
    await renderQrPngBase64("openclaw");
    expect(renderPngBase64).toHaveBeenCalledWith("openclaw", {
      margin: 4,
      scale: 6,
    });
  });

  it("floors finite PNG rendering options before delegating", async () => {
    await renderQrPngBase64("openclaw", { scale: 8.9, marginModules: 2.9 });
    expect(renderPngBase64).toHaveBeenCalledWith("openclaw", {
      margin: 2,
      scale: 8,
    });
  });

  it.each([
    ["scale", 0, 4, "scale must be between 1 and 12."],
    ["scale", 13, 4, "scale must be between 1 and 12."],
    ["scale", Number.NaN, 4, "scale must be a finite number."],
    ["marginModules", 6, -1, "marginModules must be between 0 and 16."],
    ["marginModules", 6, 17, "marginModules must be between 0 and 16."],
    ["marginModules", 6, Number.POSITIVE_INFINITY, "marginModules must be a finite number."],
  ])("rejects invalid %s values", async (_name, scale, marginModules, message) => {
    await expect(renderQrPngBase64("openclaw", { scale, marginModules })).rejects.toThrow(message);
    expect(renderPngBase64).not.toHaveBeenCalled();
  });
});
