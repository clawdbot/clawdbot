// Covers secure random helper outputs.
import { Buffer } from "node:buffer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  randomBytes: vi.fn((bytes: number) => Buffer.alloc(bytes, 0xab)),
  randomInt: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: cryptoMocks.randomBytes,
  randomInt: cryptoMocks.randomInt,
  randomUUID: cryptoMocks.randomUUID,
}));

let generateSecureFraction: typeof import("./secure-random.js").generateSecureFraction;
let generateSecureHex: typeof import("./secure-random.js").generateSecureHex;
let generateSecureInt: typeof import("./secure-random.js").generateSecureInt;
let generateSecureToken: typeof import("./secure-random.js").generateSecureToken;
let generateSecureUuid: typeof import("./secure-random.js").generateSecureUuid;

beforeAll(async () => {
  ({
    generateSecureFraction,
    generateSecureHex,
    generateSecureInt,
    generateSecureToken,
    generateSecureUuid,
  } = await import("./secure-random.js"));
});

beforeEach(() => {
  cryptoMocks.randomBytes.mockClear();
  cryptoMocks.randomUUID.mockReset();
});

describe("secure-random", () => {
  it("delegates UUID generation to crypto.randomUUID", () => {
    cryptoMocks.randomUUID.mockReturnValueOnce("uuid-1").mockReturnValueOnce("uuid-2");

    expect(generateSecureUuid()).toBe("uuid-1");
    expect(generateSecureUuid()).toBe("uuid-2");
    expect(cryptoMocks.randomUUID).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "uses the default byte count",
      byteCount: undefined,
      expectedBytes: 16,
      expectedToken: Buffer.alloc(16, 0xab).toString("base64url"),
    },
    {
      name: "passes custom byte counts through",
      byteCount: 18,
      expectedBytes: 18,
      expectedToken: Buffer.alloc(18, 0xab).toString("base64url"),
    },
    {
      name: "supports zero-byte tokens",
      byteCount: 0,
      expectedBytes: 0,
      expectedToken: "",
    },
  ])("generates url-safe tokens when $name", ({ byteCount, expectedBytes, expectedToken }) => {
    cryptoMocks.randomBytes.mockClear();

    const token = byteCount === undefined ? generateSecureToken() : generateSecureToken(byteCount);

    expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(expectedBytes);
    expect(token).toBe(expectedToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it("generates secure hex strings", () => {
    cryptoMocks.randomBytes.mockClear();

    expect(generateSecureHex(4)).toBe(Buffer.alloc(4, 0xab).toString("hex"));
    expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(4);
  });

  it("maps random bytes into a unit interval fraction", () => {
    cryptoMocks.randomBytes.mockReturnValueOnce(Buffer.from([0x80, 0x00, 0x00, 0x00]));

    expect(generateSecureFraction()).toBe(0.5);
    expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(4);
  });

  it("delegates bounded integer generation to crypto.randomInt", () => {
    cryptoMocks.randomInt.mockReturnValueOnce(2).mockReturnValueOnce(7);

    expect(generateSecureInt(5)).toBe(2);
    expect(generateSecureInt(3, 9)).toBe(7);
    expect(cryptoMocks.randomInt).toHaveBeenNthCalledWith(1, 5);
    expect(cryptoMocks.randomInt).toHaveBeenNthCalledWith(2, 3, 9);
  });
});
