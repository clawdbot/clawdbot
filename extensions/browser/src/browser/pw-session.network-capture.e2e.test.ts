import { Buffer } from "node:buffer";
import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { boundNetworkRequestsPayload, MAX_NETWORK_CAPTURE_BYTES } from "./pw-network-capture.js";
import { ensurePageState } from "./pw-session.js";

const runE2E = process.env.OPENCLAW_BROWSER_NETWORK_CAPTURE_E2E === "1";
let browser: Browser | undefined;
let server: Server | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

async function listen(serverToListen: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    serverToListen.once("error", reject);
    serverToListen.listen(0, "127.0.0.1", resolve);
  });
  const address = serverToListen.address();
  if (!address || typeof address === "string") {
    throw new Error("network capture test server did not bind a TCP port");
  }
  return address.port;
}

describe.runIf(runE2E)("browser network capture with real Playwright events", () => {
  it("captures redacted, aggregate-bounded request details", async () => {
    server = createServer((req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "text/html");
        res.end("<!doctype html><title>network capture</title>");
        return;
      }
      req.resume();
      res.setHeader("content-type", "application/json");
      res.setHeader("x-auth-token", "test-secret-credential-value");
      res.setHeader("x-response-detail", "visible");
      res.end('{"ok":true}');
    });
    const port = await listen(server);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const state = ensurePageState(page);
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.evaluate(async () => {
      await fetch("/submit", {
        method: "POST",
        headers: {
          authorization: "Bearer test-secret-credential-value",
          "content-type": "application/json",
          "x-api-key": "test-secret-credential-value",
          "x-request-detail": "visible",
        },
        body: JSON.stringify({ name: "item", password: "test-secret-credential-value" }),
      });
    });

    const detailPayload = boundNetworkRequestsPayload({
      ok: true as const,
      targetId: "real-playwright-page",
      url: page.url(),
      requests: state.requests,
    });
    const captured = detailPayload.requests.find((request) => request.url.endsWith("/submit"));
    expect(captured).toBeDefined();
    expect(captured?.method).toBe("POST");
    expect([undefined, "[REDACTED]"]).toContain(captured?.requestHeaders?.authorization);
    expect(captured?.requestHeaders?.["x-api-key"]).toBe("[REDACTED]");
    expect(captured?.requestHeaders?.["x-request-detail"]).toBe("visible");
    expect(captured?.requestBody).toContain('"name":"item"');
    expect(captured?.requestBody).not.toContain("test-secret-credential-value");
    expect(captured?.status).toBe(200);
    expect(captured?.responseHeaders?.["x-auth-token"]).toBe("[REDACTED]");
    expect(captured?.responseHeaders?.["x-response-detail"]).toBe("visible");

    for (let index = 0; index < 20; index += 1) {
      await page.evaluate(async (requestIndex) => {
        await fetch(`/bulk/${requestIndex}`, { method: "POST", body: "x".repeat(64_000) });
      }, index);
    }

    const outputPayload = boundNetworkRequestsPayload({
      ok: true as const,
      targetId: "real-playwright-page",
      url: page.url(),
      requests: state.requests,
    });
    const retainedBytes = Buffer.byteLength(JSON.stringify(outputPayload), "utf8");
    expect(retainedBytes).toBeLessThanOrEqual(MAX_NETWORK_CAPTURE_BYTES);
    expect(outputPayload.requests.some((request) => request.url.endsWith("/bulk/19"))).toBe(true);
    console.info(
      JSON.stringify({
        capturedRequestBody: Boolean(captured?.requestBody),
        redactedRequestApiKey: captured?.requestHeaders?.["x-api-key"] === "[REDACTED]",
        redactedResponseToken: captured?.responseHeaders?.["x-auth-token"] === "[REDACTED]",
        retainedBytes,
        retainedRequests: outputPayload.requests.length,
      }),
    );
  });
});
