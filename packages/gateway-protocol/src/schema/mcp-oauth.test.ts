import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  McpOAuthControlStatusSchema,
  McpOAuthStartResultSchema,
  McpOAuthStatusParamsSchema,
} from "./mcp-oauth.js";

describe("MCP OAuth protocol schemas", () => {
  it.each([
    { state: "authorization-required", credentialPresent: false },
    {
      state: "authorizing",
      credentialPresent: true,
      authorizationId: "attempt-1",
      startedAt: 1,
    },
    { state: "ready", credentialPresent: true },
    {
      state: "error",
      credentialPresent: false,
      category: "exchange-failed",
    },
  ])("accepts the closed safe lifecycle projection", (status) => {
    expect(Value.Check(McpOAuthControlStatusSchema, status)).toBe(true);
  });

  it("rejects secret-bearing or identity-selecting additions", () => {
    expect(
      Value.Check(McpOAuthControlStatusSchema, {
        state: "ready",
        credentialPresent: true,
        accessToken: "not-allowed",
      }),
    ).toBe(false);
    expect(
      Value.Check(McpOAuthStatusParamsSchema, {
        serverName: "docs",
        storeKey: "another-principal",
      }),
    ).toBe(false);
    expect(
      Value.Check(McpOAuthStartResultSchema, {
        status: { state: "authorization-required", credentialPresent: false },
        authorizationUrl: "https://accounts.example.com/authorize?state=not-allowed",
      }),
    ).toBe(false);
    expect(
      Value.Check(McpOAuthStartResultSchema, {
        status: { state: "authorization-required", credentialPresent: false },
        authorizationCode: "not-allowed",
      }),
    ).toBe(false);
  });

  it("accepts only an opaque Gateway launch path for browser navigation", () => {
    expect(
      Value.Check(McpOAuthStartResultSchema, {
        status: {
          state: "authorizing",
          credentialPresent: false,
          authorizationId: "attempt-1",
          startedAt: 1,
        },
        authorizationPath: "/oauth/mcp/authorize/attempt-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(McpOAuthStartResultSchema, {
        status: { state: "authorization-required", credentialPresent: false },
        authorizationPath: "https://accounts.example.com/authorize",
      }),
    ).toBe(false);
  });
});
