import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleMemoryEnterpriseOidcCallbackHttpRequest } from "./memory-enterprise-oidc-callback-http.js";
import { createResponse } from "./server-http.test-harness.js";

const state = "s".repeat(43);

function request(url: string, method = "GET"): IncomingMessage {
  return { url, method } as IncomingMessage;
}

describe("memory enterprise OIDC callback HTTP handler", () => {
  it("accepts a one-use receipt without browser authentication and redacts the completion result", async () => {
    const complete = vi.fn(async () => ({
      kind: "linked" as const,
      providerId: "entra",
      expiresAt: "2026-08-14T00:00:00.000Z",
    }));
    const response = createResponse();

    await expect(
      handleMemoryEnterpriseOidcCallbackHttpRequest(
        request(`/memory/oidc/callback?state=${state}&code=provider-code`),
        response.res,
        { complete },
      ),
    ).resolves.toBe(true);

    expect(complete).toHaveBeenCalledExactlyOnceWith({
      state,
      code: "provider-code",
    });
    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Sign-in completed");
    expect(response.getBody()).not.toContain("entra");
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, max-age=0");
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("rejects duplicate or oversized redirect parameters without exchanging a code", async () => {
    const complete = vi.fn();
    for (const url of [
      `/memory/oidc/callback?state=${state}&state=${state}&code=provider-code`,
      "/memory/oidc/callback?state=not-a-random-receipt&code=provider-code",
      `/memory/oidc/callback?state=${state}&code=${"a".repeat(8_193)}`,
    ]) {
      const response = createResponse();
      await expect(
        handleMemoryEnterpriseOidcCallbackHttpRequest(request(url), response.res, { complete }),
      ).resolves.toBe(true);
      expect(response.res.statusCode, url).toBe(400);
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("consumes a valid state when the provider returns no code and keeps denial details private", async () => {
    const complete = vi.fn(async () => ({
      kind: "denied" as const,
      reason: "identity-verification-failed" as const,
    }));
    const response = createResponse();

    await handleMemoryEnterpriseOidcCallbackHttpRequest(
      request(`/memory/oidc/callback?state=${state}&error=access_denied`),
      response.res,
      { complete },
    );

    expect(complete).toHaveBeenCalledExactlyOnceWith({ state, code: "" });
    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain("Sign-in could not be completed");
    expect(response.getBody()).not.toContain("identity-verification-failed");
  });

  it("returns a cache-busting method error for non-GET callbacks", async () => {
    const response = createResponse();

    await expect(
      handleMemoryEnterpriseOidcCallbackHttpRequest(
        request(`/memory/oidc/callback?state=${state}&code=provider-code`, "POST"),
        response.res,
      ),
    ).resolves.toBe(true);

    expect(response.res.statusCode).toBe(405);
    expect(response.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, max-age=0");
  });

  it("does not claim unrelated paths", async () => {
    const response = createResponse();
    await expect(
      handleMemoryEnterpriseOidcCallbackHttpRequest(
        request(`/memory/oidc/not-callback?state=${state}&code=provider-code`),
        response.res as ServerResponse,
      ),
    ).resolves.toBe(false);
    expect(response.end).not.toHaveBeenCalled();
  });
});
