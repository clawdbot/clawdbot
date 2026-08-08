import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { getFreePort, isPortFree } from "../test-utils/ports.js";
import { waitForMcpOAuthAuthorizationCode } from "./mcp-oauth-loopback.js";

function authorizationUrl(params: { port: number; state?: string; redirectHost?: string }): URL {
  const url = new URL("https://auth.example.com/authorize");
  url.searchParams.set("state", params.state ?? "state-1");
  url.searchParams.set(
    "redirect_uri",
    `http://${params.redirectHost ?? "127.0.0.1"}:${params.port}/oauth/callback`,
  );
  return url;
}

async function getFreeIpv6Port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

describe("MCP OAuth loopback callback", () => {
  it("listens before announcing the URL and captures a real callback", async () => {
    const port = await getFreePort();
    let announceReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      announceReady = resolve;
    });
    const onReady = vi.fn(() => announceReady?.());
    const callback = waitForMcpOAuthAuthorizationCode({
      authorizationUrl: authorizationUrl({ port }),
      manualFallbackCommand: "openclaw mcp login docs --code <code>",
      onReady,
      timeoutMs: 5_000,
    });
    await ready;
    expect(onReady).toHaveBeenCalledOnce();

    const deniedPreflight = await fetch(`http://127.0.0.1:${port}/oauth/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(deniedPreflight.status).toBe(204);
    expect(deniedPreflight.headers.get("access-control-allow-origin")).toBeNull();

    const allowedPreflight = await fetch(`http://127.0.0.1:${port}/oauth/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://auth.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(allowedPreflight.headers.get("access-control-allow-origin")).toBe(
      "https://auth.example.com",
    );

    const response = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=captured-code&state=state-1`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBe("close");
    await expect(response.text()).resolves.toContain("MCP OAuth complete");
    await expect(callback).resolves.toBe("captured-code");
    await vi.waitFor(async () => expect(await isPortFree(port)).toBe(true));
  });

  it("rejects a state mismatch before accepting an OAuth error", async () => {
    const port = await getFreePort();
    let announceReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      announceReady = resolve;
    });
    const callback = waitForMcpOAuthAuthorizationCode({
      authorizationUrl: authorizationUrl({ port }),
      manualFallbackCommand: "openclaw mcp login docs --code <code>",
      onReady: () => announceReady?.(),
      timeoutMs: 5_000,
    });
    const callbackRejection = expect(callback).rejects.toThrow("state did not match");

    await ready;
    const response = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?error=access_denied&state=wrong-state`,
    );
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid state");
    await callbackRejection;
    await vi.waitFor(async () => expect(await isPortFree(port)).toBe(true));
  });

  it("captures callbacks on a bracketed IPv6 loopback redirect", async () => {
    const port = await getFreeIpv6Port();
    let announceReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      announceReady = resolve;
    });
    const callback = waitForMcpOAuthAuthorizationCode({
      authorizationUrl: authorizationUrl({ port, redirectHost: "[::1]" }),
      manualFallbackCommand: "openclaw mcp login docs --code <code>",
      onReady: () => announceReady?.(),
      timeoutMs: 5_000,
    });

    await ready;
    const response = await fetch(
      `http://[::1]:${port}/oauth/callback?code=ipv6-code&state=state-1`,
    );
    expect(response.status).toBe(200);
    await expect(callback).resolves.toBe("ipv6-code");
  });

  it("names a busy callback port and preserves the manual fallback", async () => {
    const blocker = createServer((_request, response) => response.end("busy"));
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const port = (blocker.address() as AddressInfo).port;
    const onReady = vi.fn();
    try {
      await expect(
        waitForMcpOAuthAuthorizationCode({
          authorizationUrl: authorizationUrl({ port }),
          manualFallbackCommand: "openclaw mcp login docs --code <code>",
          onReady,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        `MCP OAuth callback port ${port} is already in use. Complete approval in the browser, then run openclaw mcp login docs --code <code>.`,
      );
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });

  it("times out and releases the callback port", async () => {
    const port = await getFreePort();
    const onReady = vi.fn();
    await expect(
      waitForMcpOAuthAuthorizationCode({
        authorizationUrl: authorizationUrl({ port }),
        manualFallbackCommand: "openclaw mcp login docs --code <code>",
        onReady,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(
      `Timed out waiting for the MCP OAuth redirect on port ${port}. Complete approval in the browser, then run openclaw mcp login docs --code <code>.`,
    );
    expect(onReady).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(await isPortFree(port)).toBe(true));
  });

  it("leaves non-loopback redirects on the manual code path", async () => {
    const url = new URL("https://auth.example.com/authorize");
    url.searchParams.set("state", "state-1");
    url.searchParams.set("redirect_uri", "https://app.example.com/oauth/callback");
    const onReady = vi.fn();

    await expect(
      waitForMcpOAuthAuthorizationCode({
        authorizationUrl: url,
        manualFallbackCommand: "openclaw mcp login docs --code <code>",
        onReady,
      }),
    ).resolves.toBeUndefined();
    expect(onReady).toHaveBeenCalledOnce();
  });
});
