import { describe, expect, it } from "vitest";
import { resolveAllowFromAccountId, safeAccountKey, safeChannelKey } from "./pairing-store-keys.js";
import type { PairingChannel } from "./pairing-store.types.js";

function expectInvalidPairingKey(params: {
  run: () => unknown;
  message: string;
  leaked?: string;
}): void {
  try {
    params.run();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toBe(params.message);
    if (params.leaked) {
      expect(message).not.toContain(params.leaked);
    }
    return;
  }
  throw new Error("expected invalid pairing key error");
}

describe("pairing store keys", () => {
  it("formats invalid key diagnostics without stringifying unsafe values", () => {
    const circular: Record<string, unknown> = { label: "private-channel-value" };
    circular.self = circular;
    expectInvalidPairingKey({
      run: () => safeChannelKey(circular as unknown as PairingChannel),
      message: "invalid pairing channel: expected non-empty string; got object",
      leaked: "private-channel-value",
    });
    expectInvalidPairingKey({
      run: () => resolveAllowFromAccountId(10n as unknown as string),
      message: "invalid pairing account id: expected non-empty string; got bigint",
      leaked: "10",
    });
  });

  it("rejects sanitized-empty keys without exposing raw input", () => {
    expectInvalidPairingKey({
      run: () => safeChannelKey(".." as PairingChannel),
      message: "invalid pairing channel: sanitized key is empty; got string length 2",
      leaked: "..",
    });
    expectInvalidPairingKey({
      run: () => safeAccountKey("/"),
      message: "invalid pairing account id: sanitized key is empty; got string length 1",
      leaked: "/",
    });
  });
});
