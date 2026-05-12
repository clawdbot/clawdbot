import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateLineSignature } from "./signature.js";

function sign(body: string, secret: string): string {
  return crypto.createHmac("SHA256", secret).update(body).digest("base64");
}

describe("validateLineSignature", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid signature", () => {
    const body = JSON.stringify({ events: [{ type: "message" }] });
    const secret = "top-secret";

    expect(validateLineSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("still performs timing-safe comparison when signature length mismatches", () => {
    const body = JSON.stringify({ events: [{ type: "message" }] });
    const secret = "top-secret";
    const spy = vi.spyOn(crypto, "timingSafeEqual");

    expect(validateLineSignature(body, "short", secret)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    const [left, right] = spy.mock.calls.at(0) ?? [];
    expect(left).toBeInstanceOf(Buffer);
    expect(right).toBeInstanceOf(Buffer);
    expect(left?.byteLength).toBe(right?.byteLength);
  });
});
