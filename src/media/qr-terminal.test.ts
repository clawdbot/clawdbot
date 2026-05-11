import { beforeEach, describe, expect, it, vi } from "vitest";

const { toString } = vi.hoisted(() => ({
  toString: vi.fn(async () => "ASCII-QR"),
}));

vi.mock("qrcode", () => ({
  default: {
    toString,
  },
}));

import { renderQrTerminal } from "./qr-terminal.ts";

describe("renderQrTerminal", () => {
  beforeEach(() => {
    toString.mockClear();
  });

  it("delegates terminal rendering to qrcode", async () => {
    await expect(renderQrTerminal("openclaw")).resolves.toBe("ASCII-QR");
    expect(toString).toHaveBeenCalledWith("openclaw", {
      small: true,
      type: "terminal",
    });
  });

  it("rejects empty QR text", async () => {
    await expect(renderQrTerminal("")).rejects.toThrow("QR text must not be empty.");
    expect(toString).not.toHaveBeenCalled();
  });
});
