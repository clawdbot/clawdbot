import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { create, toString } = vi.hoisted(() => ({
  create: vi.fn(() => ({
    modules: {
      data: [1, 0, 0, 1],
      size: 2,
    },
  })),
  toString: vi.fn(async () => "ASCII-QR"),
}));

vi.mock("./qr-runtime.ts", () => ({
  loadQrCodeRuntime: async () => ({ create, toString }),
}));

let renderQrTerminal: typeof import("./qr-terminal.ts").renderQrTerminal;

beforeAll(async () => {
  vi.resetModules();
  ({ renderQrTerminal } = await import("./qr-terminal.ts"));
});

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
});

afterAll(() => {
  vi.doUnmock("./qr-runtime.ts");
  vi.resetModules();
});
