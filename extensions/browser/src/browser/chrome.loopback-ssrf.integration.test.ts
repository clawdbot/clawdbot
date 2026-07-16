import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getChromeWebSocketUrl, isChromeReachable } from "./chrome.js";

type RunningServer = {
  server: Server;
  baseUrl: string;
};

const runningServers: Server[] = [];

async function startLoopbackCdpServer(): Promise<RunningServer> {
  const server = createServer((req, res) => {
    if (req.url !== "/json/version") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const address = server.address() as AddressInfo;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        Browser: "Chrome/999.0.0.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/TEST`,
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  runningServers.push(server);
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  await Promise.all(
    runningServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
          ),
      ),
  );
});

describe("chrome loopback SSRF integration", () => {
  it("keeps loopback CDP HTTP reachability working under strict default SSRF policy", async () => {
    const { baseUrl } = await startLoopbackCdpServer();

    await expect(isChromeReachable(baseUrl, 500, {})).resolves.toBe(true);
  });

  it("returns the loopback websocket URL under strict default SSRF policy", async () => {
    const { baseUrl } = await startLoopbackCdpServer();

    await expect(getChromeWebSocketUrl(baseUrl, 500, {})).resolves.toMatch(
      /\/devtools\/browser\/TEST$/,
    );
  });
});
