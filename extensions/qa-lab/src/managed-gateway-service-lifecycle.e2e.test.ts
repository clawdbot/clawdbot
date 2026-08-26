// QA Lab owns the real child/provider fixture used by the managed service proof.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaProviderServer } from "./providers/server-runtime.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function fetchJson(url: string, label: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return body as Record<string, unknown>;
}

describe("managed gateway service lifecycle product proof", () => {
  it(
    "runs a foreground gateway with live, ready, and RPC health",
    { timeout: 180_000 },
    async () => {
      const provider = await startQaProviderServer("mock-openai");
      if (!provider) {
        throw new Error("mock OpenAI provider did not start");
      }
      let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
      let proofFailure: Error | undefined;
      try {
        gateway = await startQaGatewayChild({
          repoRoot,
          useRepoCli: true,
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
        });
        expect(gateway.pid).toBeGreaterThan(0);
        await expect(
          fetchJson(`${gateway.baseUrl}/healthz`, "gateway /healthz"),
        ).resolves.toMatchObject({ status: "live" });
        await expect(
          fetchJson(`${gateway.baseUrl}/readyz`, "gateway /readyz"),
        ).resolves.toMatchObject({ ready: true });
        const rpcHealth = await gateway.call("health", {});
        expect(rpcHealth).not.toBeNull();
        expect(Array.isArray(rpcHealth)).toBe(false);
        expect(typeof rpcHealth).toBe("object");
      } catch (error) {
        proofFailure = error instanceof Error ? error : new Error(String(error));
      }
      const cleanup = await Promise.allSettled([gateway?.stop(), provider.stop()]);
      const cleanupFailures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (proofFailure && cleanupFailures.length > 0) {
        throw new AggregateError(
          [proofFailure, ...cleanupFailures],
          "foreground gateway proof and cleanup failed",
        );
      }
      if (proofFailure) {
        throw proofFailure;
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, "foreground gateway cleanup failed");
      }
    },
  );
});
