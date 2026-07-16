import { describe, expect, it } from "vitest";
import { parseApplicationIdFromToken } from "./probe.js";

describe("parseApplicationIdFromToken", () => {
  it("extracts application ID from a valid token", () => {
    // "1234567890" base64-encoded is "MTIzNDU2Nzg5MA=="
    const token = `${Buffer.from("1234567890").toString("base64")}.timestamp.hmac`;
    expect(parseApplicationIdFromToken(token)).toBe("1234567890");
  });

  it("extracts large snowflake IDs without precision loss", () => {
    // ID that exceeds Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991)
    const largeId = "1477179610322964541";
    const token = `${Buffer.from(largeId).toString("base64")}.GhIiP9.vU1xEpJ6NjFm`;
    expect(parseApplicationIdFromToken(token)).toBe(largeId);
  });

  it("handles tokens with Bot prefix", () => {
    const token = `Bot ${Buffer.from("9876543210").toString("base64")}.ts.hmac`;
    expect(parseApplicationIdFromToken(token)).toBe("9876543210");
  });

  it("returns undefined for empty string", () => {
    expect(parseApplicationIdFromToken("")).toBeUndefined();
  });

  it("returns undefined for token without dots", () => {
    expect(parseApplicationIdFromToken("nodots")).toBeUndefined();
  });

  it("returns undefined when decoded segment is not numeric", () => {
    const token = `${Buffer.from("not-a-number").toString("base64")}.ts.hmac`;
    expect(parseApplicationIdFromToken(token)).toBeUndefined();
  });

  it("returns undefined for whitespace-only input", () => {
    expect(parseApplicationIdFromToken("   ")).toBeUndefined();
  });

  it("returns undefined when first segment is empty (starts with dot)", () => {
    expect(parseApplicationIdFromToken(".ts.hmac")).toBeUndefined();
  });
});
