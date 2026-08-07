// Loopback callback server tests for `openclaw mcp login`.
import { afterEach, describe, expect, it } from "vitest";
import {
  isMcpLoginLoopbackRedirectUrl,
  startMcpLoginCallbackServer,
  type McpLoginCallbackServer,
} from "./mcp-login-callback.js";

const activeServers: McpLoginCallbackServer[] = [];

afterEach(async () => {
  for (const entry of activeServers.splice(0)) {
    entry.cancelWait();
    await new Promise<void>((resolve) => {
      entry.server.closeAllConnections?.();
      entry.server.close(() => resolve());
    });
  }
});

describe("isMcpLoginLoopbackRedirectUrl", () => {
  it("accepts loopback redirect URIs", () => {
    expect(isMcpLoginLoopbackRedirectUrl("http://127.0.0.1:8989/oauth/callback")).toBe(true);
    expect(isMcpLoginLoopbackRedirectUrl("http://localhost:8989/oauth/callback")).toBe(true);
    expect(isMcpLoginLoopbackRedirectUrl("http://[::1]:8989/oauth/callback")).toBe(true);
  });

  it("rejects remote, non-HTTP, and malformed redirect URIs", () => {
    expect(isMcpLoginLoopbackRedirectUrl("https://auth.example.com/callback")).toBe(false);
    expect(isMcpLoginLoopbackRedirectUrl("http://auth.example.com/callback")).toBe(false);
    expect(isMcpLoginLoopbackRedirectUrl("https://127.0.0.1:8989/oauth/callback")).toBe(false);
    expect(isMcpLoginLoopbackRedirectUrl("not a url")).toBe(false);
  });
});

describe("startMcpLoginCallbackServer", () => {
  it("captures the code and state from the browser redirect", async () => {
    const server = await startMcpLoginCallbackServer("http://127.0.0.1:0/oauth/callback", {
      serverName: "docs",
      waitMs: 10_000,
    });
    activeServers.push(server);
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=code-123&state=state-456`,
    );
    expect(response.ok).toBe(true);
    expect(await response.text()).toContain("OpenClaw MCP login complete");

    await expect(server.waitForCallback()).resolves.toEqual({
      code: "code-123",
      state: "state-456",
    });
  });

  it("answers 404 on unknown paths without settling the wait", async () => {
    const server = await startMcpLoginCallbackServer("http://127.0.0.1:0/oauth/callback", {
      serverName: "docs",
      waitMs: 10_000,
    });
    activeServers.push(server);
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/other`);
    expect(response.status).toBe(404);

    let settled = false;
    void server.waitForCallback().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
  });

  it("rejects missing code or state parameters", async () => {
    const server = await startMcpLoginCallbackServer("http://127.0.0.1:0/oauth/callback", {
      serverName: "docs",
      waitMs: 10_000,
    });
    activeServers.push(server);
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=only-code`);
    expect(response.status).toBe(400);
  });

  it("settles the wait with null on timeout", async () => {
    const server = await startMcpLoginCallbackServer("http://127.0.0.1:0/oauth/callback", {
      serverName: "docs",
      waitMs: 30,
    });
    activeServers.push(server);

    await expect(server.waitForCallback()).resolves.toBeNull();
  });
});
