import { describe, expect, it } from "vitest";
import { getHeader } from "./http-headers.js";

describe("getHeader", () => {
  it("returns first value when header is an array", () => {
    expect(getHeader({ "x-test": ["first", "second"] }, "x-test")).toBe("first");
  });

  it("matches headers case-insensitively", () => {
    expect(getHeader({ "X-Twilio-Signature": "sig-1" }, "x-twilio-signature")).toBe("sig-1");
  });

  it("returns undefined for missing header", () => {
    expect(getHeader({ host: "example.com" }, "x-missing")).toBeUndefined();
  });
});
