// Status-all gateway tests cover log-tail summaries for auth and runtime diagnostic lines.
import { describe, expect, it } from "vitest";
import { summarizeLogTail } from "./gateway.js";

describe("summarizeLogTail", () => {
  it("marks permanent OAuth refresh failures as reauth-required", () => {
    const lines = summarizeLogTail([
      "[openai] Token refresh failed: 401 {",
      '"error":{"code":"invalid_grant","message":"Session invalidated due to signing in again"}',
      "}",
    ]);

    expect(lines).toEqual(["[openai] token refresh 401 invalid_grant · re-auth required"]);
  });
});
