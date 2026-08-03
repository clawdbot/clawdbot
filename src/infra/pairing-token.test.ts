// Covers pairing token generation and verification.
import { Buffer } from "node:buffer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const randomBytesMock = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomBytes: (...args: unknown[]) => randomBytesMock(...args),
  };
});

type PairingTokenModule = typeof import("./pairing-token.js");

let generatePairingToken: PairingTokenModule["generatePairingToken"];
let verifyPairingToken: PairingTokenModule["verifyPairingToken"];

beforeAll(async () => {
  ({ generatePairingToken, verifyPairingToken } = await import("./pairing-token.js"));
});

beforeEach(() => {
  randomBytesMock.mockReset();
});

describe("generatePairingToken", () => {
  it("uses 32 random bytes and returns a base64url token", () => {
    randomBytesMock.mockReturnValueOnce(Buffer.from([0xfb, 0xff, 0x00]));

    expect(generatePairingToken()).toBe("-_8A");
    expect(randomBytesMock).toHaveBeenCalledWith(32);
  });
});

describe("verifyPairingToken", () => {
  it("uses constant-time comparison semantics", () => {
    expect(verifyPairingToken("secret-token", "secret-token")).toBe(true);
    expect(verifyPairingToken("secret-token", "secret-tokEn")).toBe(false);
  });

  it("rejects blank tokens even when both sides match", () => {
    expect(verifyPairingToken("", "")).toBe(false);
    expect(verifyPairingToken("   ", "   ")).toBe(false);
  });
});
