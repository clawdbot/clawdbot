import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import "../test-support/browser-security.mock.js";
import { closeTrackedCdpTarget, resolveCdpTabOwnership } from "./cdp.helpers.js";

const servers: Array<{ close: (callback: () => void) => void }> = [];

async function listen(server: {
  once: (event: string, callback: () => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
}

function replyToCloseMessages(socket: WebSocket): void {
  socket.on("message", (data) => {
    const message = JSON.parse(rawDataToString(data)) as { id?: number; method?: string };
    if (message.method === "Target.getTargets") {
      socket.send(
        JSON.stringify({
          id: message.id,
          result: { targetInfos: [{ targetId: "OWNED", type: "page" }] },
        }),
      );
    } else if (message.method === "Target.closeTarget") {
      socket.send(JSON.stringify({ id: message.id, result: { success: false } }));
    }
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

describe("closeTrackedCdpTarget", () => {
  it("keeps ownership retryable when CDP declines the close", async () => {
    const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(wsServer);
    await listen(wsServer);
    wsServer.on("connection", replyToCloseMessages);

    const browserWebSocketUrl = `ws://127.0.0.1:${(wsServer.address() as AddressInfo).port}/devtools/browser/TEST`;
    const httpServer = createServer((_, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ webSocketDebuggerUrl: browserWebSocketUrl }));
    });
    servers.push(httpServer);
    httpServer.listen(0, "127.0.0.1");
    await listen(httpServer);
    const cdpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const ownership = await resolveCdpTabOwnership({
      profileName: "remote",
      cdpUrl,
      nativeTargetId: "OWNED",
    });
    if (ownership.status !== "durable") {
      throw new Error("expected durable ownership");
    }

    await expect(
      closeTrackedCdpTarget({
        profileName: "remote",
        cdpUrl,
        nativeTargetId: "OWNED",
        expectedProfileFingerprint: ownership.profileFingerprint,
        expectedBrowserInstanceFingerprint: ownership.browserInstanceFingerprint,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "target-close-failed" });
  });
});
