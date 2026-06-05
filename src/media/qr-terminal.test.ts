// QR terminal tests cover text normalization and terminal render calls.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, toString } = vi.hoisted(() => ({
  create: vi.fn(() => ({
    modules: {
      data: [1, 0, 0, 1],
      size: 2,
    },
  })),
  toString: vi.fn(async () => "ASCII-QR"),
}));

vi.mock("qrcode", () => ({
  default: {
    create,
    toString,
  },
}));

import { renderQrTerminal } from "./qr-terminal.ts";

describe("renderQrTerminal", () => {
  beforeEach(() => {
    create.mockClear();
    toString.mockClear();
  });

  it("delegates terminal rendering to qrcode", async () => {
    await expect(renderQrTerminal("openclaw")).resolves.toBe("ASCII-QR");
    expect(toString).toHaveBeenCalledWith("openclaw", {
      small: false,
      type: "terminal",
    });
  });

  it("renders compact QR output without qrcode terminal small mode", async () => {
    const rendered = await renderQrTerminal("openclaw", { small: true });
    expect(rendered).toContain("▄");
    expect(create).toHaveBeenCalledWith("openclaw");
    expect(toString).not.toHaveBeenCalled();
  });

  it("rejects empty QR text", async () => {
    await expect(renderQrTerminal("")).rejects.toThrow("QR text must not be empty.");
    expect(toString).not.toHaveBeenCalled();
  });
});
