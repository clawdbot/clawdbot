import { expect, it } from "vitest";
import { startQaProviderServer } from "./server-runtime.js";

it("returns a reachable IPv6 URL for the mock provider", async () => {
  const server = await startQaProviderServer("mock-openai", { host: "::1", port: 0 });
  if (!server) {
    throw new Error("mock provider did not start");
  }
  try {
    const response = await fetch(`${server.baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, status: "live" });
  } finally {
    await server.stop();
  }
});
