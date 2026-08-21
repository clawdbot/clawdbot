import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { requestProviderUsage } from "./provider-usage-request.ts";

function clientWith(request: GatewayBrowserClient["request"]): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

describe("requestProviderUsage", () => {
  it("returns the summary for an answered request", async () => {
    const summary = { updatedAt: 1, providers: [] };
    const client = clientWith((async () => summary) as GatewayBrowserClient["request"]);
    await expect(requestProviderUsage(client)).resolves.toEqual({ ok: true, value: summary });
  });

  it("records a rejected request as failed", async () => {
    const client = clientWith((async () => {
      throw new Error("gateway unreachable");
    }) as GatewayBrowserClient["request"]);
    await expect(requestProviderUsage(client)).resolves.toEqual({
      ok: false,
      error: { kind: "request-failed" },
    });
  });

  it("does not record a cancelled request as failed", async () => {
    const controller = new AbortController();
    const client = clientWith((async () => {
      controller.abort();
      throw new Error("aborted");
    }) as GatewayBrowserClient["request"]);
    await expect(requestProviderUsage(client, { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });
});
