import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import * as providerAuthRuntime from "./provider-auth-runtime.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("plugin-sdk provider-auth-runtime", () => {
  it("exports the runtime-ready auth helper", () => {
    expect(providerAuthRuntime.getRuntimeAuthForModel).toBeTypeOf("function");
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
});
