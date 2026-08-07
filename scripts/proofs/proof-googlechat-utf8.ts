import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readProviderJsonResponse } from "../../src/plugin-sdk/provider-http.js";
import { fetchWithSsrFGuard } from "../../src/plugin-sdk/ssrf-runtime.js";

const GOOGLECHAT_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS = 30_000;
const GOOGLECHAT_JSON_LABEL = "Google Chat API request failed";

async function readJsonOverHttp(bytes: Uint8Array): Promise<unknown> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    // Real guarded HTTP transport boundary (the same client Google Chat uses);
    // the external Google endpoint is the only substituted dependency, via
    // loopback with the private-network policy the plugin applies to it.
    const { response, release } = await fetchWithSsrFGuard({
      url: `http://127.0.0.1:${address.port}/v1/spaces/AAA/messages`,
      init: { method: "POST" },
      policy: { allowPrivateNetwork: true },
      auditContext: "googlechat.proof.utf8",
      timeoutMs: 30_000,
    });
    try {
      // Exact production options api.ts passes to the shared SDK reader.
      return await readProviderJsonResponse<unknown>(response, GOOGLECHAT_JSON_LABEL, {
        maxBytes: GOOGLECHAT_JSON_RESPONSE_MAX_BYTES,
        chunkTimeoutMs: GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS,
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(`${GOOGLECHAT_JSON_LABEL}: response body stalled after ${chunkTimeoutMs}ms`),
      });
    } finally {
      await release();
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function main(): Promise<void> {
  const valid = new TextEncoder().encode('{"name":"spaces/AAA"}');
  const corrupted = new Uint8Array(valid);
  corrupted[valid.indexOf(0x41) + 1] = 0xff;

  try {
    const parsed = await readJsonOverHttp(corrupted);
    console.log(`corrupted JSON: accepted, parsed=${JSON.stringify(parsed)}`);
  } catch (error) {
    console.log(`corrupted JSON: rejected (${(error as Error).message})`);
  }

  console.log(`valid JSON: ${JSON.stringify(await readJsonOverHttp(valid))}`);
}

void main();
