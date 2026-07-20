import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchGuardedProviderDownloadResponse } from "./shared.js";

describe("fetchGuardedProviderDownloadResponse", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (!server) {
      return;
    }
    server.closeAllConnections?.();
    server.close();
    await once(server, "close").catch(() => undefined);
    server = undefined;
  });

  async function startLoopbackServer(body: string): Promise<{ port: number; hits: string[] }> {
    const hits: string[] = [];
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return { port: address.port, hits };
  }

  it("blocks a private-network result URL by default", async () => {
    const { port, hits } = await startLoopbackServer("LEAKED-INTERNAL-BYTES");

    await expect(
      fetchGuardedProviderDownloadResponse({
        url: `http://127.0.0.1:${port}/secret-metadata`,
        fetchFn: fetch,
        provider: "test",
        requestFailedMessage: "download failed",
      }),
    ).rejects.toThrow(/private\/internal\/special-use IP address|Blocked hostname/);

    expect(hits).toEqual([]);
  });

  it("downloads a private-network result URL when allowPrivateNetwork is set", async () => {
    const { port, hits } = await startLoopbackServer("LEAKED-INTERNAL-BYTES");

    const { response, release } = await fetchGuardedProviderDownloadResponse({
      url: `http://127.0.0.1:${port}/secret-metadata`,
      fetchFn: fetch,
      provider: "test",
      requestFailedMessage: "download failed",
      allowPrivateNetwork: true,
    });
    try {
      expect(await response.text()).toBe("LEAKED-INTERNAL-BYTES");
    } finally {
      await release();
    }

    expect(hits).toEqual(["/secret-metadata"]);
  });
});
