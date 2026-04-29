import { describe, expect, it } from "vitest";
import {
  resolveAllowFromAccountId,
  resolveAllowFromFilePath,
  safeChannelKey,
} from "./allow-from-store-file.js";
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

describe("allow-from store file keys", () => {
  it("formats invalid channel diagnostics without stringifying unsafe values", () => {
    const circular: Record<string, unknown> = { label: "private-channel-value" };
    circular.self = circular;

    expectInvalidPairingKey({
      run: () => safeChannelKey(circular as unknown as PairingChannel),
      message: "invalid pairing channel: expected non-empty string; got object",
      leaked: "private-channel-value",
    });
  });

  it("formats invalid account diagnostics without stringifying unsafe values", () => {
    expectInvalidPairingKey({
      run: () => resolveAllowFromFilePath("telegram", process.env, 10n as unknown as string),
      message: "invalid pairing account id: expected non-empty string; got bigint",
      leaked: "10",
    });

    expectInvalidPairingKey({
      run: () => resolveAllowFromAccountId(10n as unknown as string),
      message: "invalid pairing account id: expected non-empty string; got bigint",
      leaked: "10",
    });
  });

  it("reports sanitized-empty filename keys without exposing the raw key", () => {
    expectInvalidPairingKey({
      run: () => safeChannelKey(".." as PairingChannel),
      message: "invalid pairing channel: sanitized filename key is empty; got string length 2",
      leaked: "..",
    });

    expectInvalidPairingKey({
      run: () => resolveAllowFromFilePath("telegram", process.env, "/" as string),
      message: "invalid pairing account id: sanitized filename key is empty; got string length 1",
      leaked: "/",
    });
  });
});
