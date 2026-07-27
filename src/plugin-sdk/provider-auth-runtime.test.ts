// Provider auth runtime tests cover OAuth callback handling and provider auth flow helpers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { getFreePort } from "../test-utils/ports.js";
import * as providerAuthRuntime from "./provider-auth-runtime.js";

describe("plugin-sdk provider-auth-runtime", () => {
  it("exports the runtime-ready auth helper", () => {
    expect(providerAuthRuntime.getRuntimeAuthForModel).toBeTypeOf("function");
  });

  it("resolves non-secret provider auth profile metadata", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "provider-auth-runtime-"));
    const agentDir = path.join(tempRoot, "agent");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:chatgpt": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            accountId: "acct-openai-workspace",
          },
        },
      },
      agentDir,
    );

    expect(
      providerAuthRuntime.resolveProviderAuthProfileMetadata({
        provider: "openai",
        profileId: "openai:chatgpt",
        agentDir,
      }),
    ).toEqual({
      profileId: "openai:chatgpt",
      accountId: "acct-openai-workspace",
    });
  });

  it("generates random OAuth state tokens", () => {
    const first = providerAuthRuntime.generateOAuthState();
    const second = providerAuthRuntime.generateOAuthState();

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("parses OAuth callback URLs and rejects bare codes", () => {
    expect(
      providerAuthRuntime.parseOAuthCallbackInput(
        "http://127.0.0.1:3000/callback?code=abc&state=state-1",
      ),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(providerAuthRuntime.parseOAuthCallbackInput("abc")).toEqual({
      error: "Paste the full redirect URL, not just the code.",
    });
  });

  it("allows browser IdP pages to probe the localhost callback with CORS", async () => {
    const port = await getFreePort();
    const callback = providerAuthRuntime.waitForLocalOAuthCallback({
      expectedState: "state-1",
      timeoutMs: 5_000,
      port,
      callbackPath: "/callback",
      redirectUri: `http://127.0.0.1:${port}/callback`,
      hostname: "127.0.0.1",
      successTitle: "OAuth complete",
      corsOriginAllowlist: ["auth.x.ai", "accounts.x.ai"],
    });

    const preflight = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://auth.x.ai",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://auth.x.ai");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=state-1`, {
      headers: {
        Origin: "https://auth.x.ai",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://auth.x.ai");
    await expect(callback).resolves.toEqual({ code: "code-1", state: "state-1" });
  });

  it("closes a pending localhost callback when its owner cancels", async () => {
    const controller = new AbortController();
    const port = await getFreePort();
    const callback = providerAuthRuntime.waitForLocalOAuthCallback({
      expectedState: "state-1",
      timeoutMs: 5_000,
      port,
      callbackPath: "/callback",
      redirectUri: `http://127.0.0.1:${port}/callback`,
      hostname: "127.0.0.1",
      successTitle: "OAuth complete",
      signal: controller.signal,
    });

    controller.abort();

    await expect(callback).rejects.toThrow("OAuth callback cancelled");
  });

  it("does not echo CORS for unallowlisted callback origins but keeps waiting", async () => {
    const port = await getFreePort();
    const callback = providerAuthRuntime.waitForLocalOAuthCallback({
      expectedState: "state-1",
      timeoutMs: 5_000,
      port,
      callbackPath: "/callback",
      redirectUri: `http://127.0.0.1:${port}/callback`,
      hostname: "127.0.0.1",
      successTitle: "OAuth complete",
      corsOriginAllowlist: ["auth.x.ai"],
    });

    const preflight = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-methods")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
    expect(preflight.headers.get("access-control-allow-private-network")).toBeNull();

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=state-1`, {
      headers: {
        Origin: "https://auth.x.ai",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://auth.x.ai");
    await expect(callback).resolves.toEqual({ code: "code-1", state: "state-1" });
  });

  it("preserves legacy permissive CORS behavior when no allowlist is passed", async () => {
    const port = await getFreePort();
    const callback = providerAuthRuntime.waitForLocalOAuthCallback({
      expectedState: "state-1",
      timeoutMs: 5_000,
      port,
      callbackPath: "/callback",
      redirectUri: `http://127.0.0.1:${port}/callback`,
      hostname: "127.0.0.1",
      successTitle: "OAuth complete",
    });

    const preflight = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://legacy.example",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://legacy.example");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=state-1`);
    expect(response.status).toBe(200);
    await expect(callback).resolves.toEqual({ code: "code-1", state: "state-1" });
  });

  it("clamps oversized OAuth callback timeouts before scheduling", async () => {
    const port = await getFreePort();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      let callback!: Promise<providerAuthRuntime.OAuthCallbackResult>;
      const listening = new Promise<void>((resolve) => {
        callback = providerAuthRuntime.waitForLocalOAuthCallback({
          expectedState: "state-1",
          timeoutMs: Number.MAX_SAFE_INTEGER,
          port,
          callbackPath: "/callback",
          redirectUri: `http://127.0.0.1:${port}/callback`,
          hostname: "127.0.0.1",
          successTitle: "OAuth complete",
          onProgress: () => resolve(),
        });
      });
      await listening;

      const response = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=state-1`);

      expect(response.status).toBe(200);
      await expect(callback).resolves.toEqual({ code: "code-1", state: "state-1" });
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("buildOAuthCallbackOriginResolver", () => {
  it("returns a no-op resolver when no allowlist is provided", () => {
    const noOp = providerAuthRuntime.buildOAuthCallbackOriginResolver(undefined);
    expect(noOp("https://auth.example.com")).toBeUndefined();

    const empty = providerAuthRuntime.buildOAuthCallbackOriginResolver([]);
    expect(empty("https://auth.example.com")).toBeUndefined();

    const blank = providerAuthRuntime.buildOAuthCallbackOriginResolver(["", "  "]);
    expect(blank("https://auth.example.com")).toBeUndefined();
  });

  it("echoes only allowlisted hosts and only over https", () => {
    const resolver = providerAuthRuntime.buildOAuthCallbackOriginResolver([
      "auth.example.com",
      "ACCOUNTS.example.com",
    ]);

    expect(resolver("https://auth.example.com")).toBe("https://auth.example.com");
    expect(resolver("https://accounts.example.com")).toBe("https://accounts.example.com");
    expect(resolver("https://AUTH.EXAMPLE.COM")).toBe("https://auth.example.com");
    expect(resolver("https://attacker.example.com")).toBeUndefined();
    expect(resolver("http://auth.example.com")).toBeUndefined();
    expect(resolver("not a url")).toBeUndefined();
    expect(resolver(undefined)).toBeUndefined();
    expect(resolver([])).toBeUndefined();
  });

  it("uses the first value when multiple Origin headers arrive", () => {
    const resolver = providerAuthRuntime.buildOAuthCallbackOriginResolver(["auth.example.com"]);
    expect(resolver(["https://auth.example.com", "https://attacker.example.com"])).toBe(
      "https://auth.example.com",
    );
    expect(resolver(["https://attacker.example.com", "https://auth.example.com"])).toBeUndefined();
  });
});
