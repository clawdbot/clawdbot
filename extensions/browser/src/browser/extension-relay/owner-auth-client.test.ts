import { once } from "node:events";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import { randomRelayId } from "./auth-v2-crypto.js";
import {
  BrowserRelayAuthV2Authority,
  parseRelayAuthHello,
  parseStrictJsonObject,
} from "./auth-v2.js";
import { authenticateRelayOwner } from "./owner-auth-client.js";
import { relayOwnerResource } from "./owner-protocol.js";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

it.each(["port", "profile", "owner", "key"] as const)(
  "rejects a listener's mismatched %s proof without disclosing the persistent key or sending a client proof",
  async (mismatch) => {
    const token = relayTestKey(12);
    const authority = new BrowserRelayAuthV2Authority(
      mismatch === "key" ? relayTestKey(13) : token,
    );
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) {
      throw new Error("Expected loopback address");
    }
    const observed: string[] = [];
    server.on("connection", (ws, request) => {
      observed.push(JSON.stringify({ url: request.url, headers: request.headers }));
      authority.registerPendingConnection(ws, () => ws.terminate(), "127.0.0.1");
      ws.on("message", (raw) => {
        observed.push(rawDataToString(raw));
        const hello = parseRelayAuthHello(parseStrictJsonObject(rawDataToString(raw)));
        if (!hello) {
          throw new Error("Expected auth hello only");
        }
        const resource = relayOwnerResource(
          mismatch === "port" ? address.port + 1 : address.port,
          mismatch === "profile" ? "another-profile" : "chrome",
        );
        const challenge = authority.issueChallenge(
          ws,
          { ...hello, keyId: authority.keyId },
          {
            role: "cdp",
            transport: "websocket",
            method: "GET",
            flow: "owner",
            resource: `${resource}&owner=${mismatch === "owner" ? "invalid-owner" : randomRelayId()}`,
          },
        );
        ws.send(JSON.stringify(challenge));
      });
    });
    await expect(
      authenticateRelayOwner({
        port: address.port,
        profile: "chrome",
        token,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(observed.join("\n")).not.toContain(token);
    expect(observed.join("\n")).not.toContain("auth.response");
    authority.dispose();
  },
);
