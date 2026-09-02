import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

it.each([
  "/v1/responses",
  "/v1/messages",
  "/v1/images/generations",
  "/v1/audio/transcriptions",
  "/v1/embeddings",
])("rejects an oversized %s upload without taking down the provider", async (pathname) => {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  try {
    const result = await postRawWebhook({
      url: `${server.baseUrl}${pathname}`,
      body: "{}",
      contentLength: 16 * 1024 * 1024 + 1,
      headers: { "content-type": "application/json" },
    });

    expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
    expect(JSON.parse(result.body)).toEqual({ error: "Payload too large" });
    expect(result.closedByServer).toBe(true);

    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true, status: "live" });
  } finally {
    await server.stop();
  }
});
