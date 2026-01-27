import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateLineSignature } from "./signature.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

describe("validateLineSignature", () => {
  it("accepts valid signatures", () => {
    const secret = "secret";
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });

    expect(validateLineSignature(rawBody, sign(rawBody, secret), secret)).toBe(true);
  });

  it("rejects signatures computed with the wrong secret", () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });

    expect(validateLineSignature(rawBody, sign(rawBody, "wrong-secret"), "secret")).toBe(false);
  });

  it("rejects signatures with a different length", () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });

    expect(validateLineSignature(rawBody, "short", "secret")).toBe(false);
  });
});
