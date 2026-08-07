// Gateway Client tests cover credential redaction in connect-failure logging.
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "./client.js";
import { rawDataToString } from "./websocket-data.js";

const SESSION_SECRET = "SUPERSECRETVALUE";
const PRIVATE_KEY_PEM = "PEMSECRETVALUE";
const AUTH_METHOD = "AUTHSECRETVALUE";
const QUERY =
  `?sessionSecret=${SESSION_SECRET}` +
  `&privateKeyPem=${PRIVATE_KEY_PEM}` +
  `&authMethod=${AUTH_METHOD}` +
  "&X-Amz-Signature=deadbeef" +
  "&safe=value";

function resolveHeadSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

describe("GatewayClient connect-failure logging", () => {
  const servers: WebSocketServer[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    await Promise.all(
      servers.splice(0).map(async (server) => {
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
    );
  });

  it("does not log gateway URL credentials when a real loopback gateway rejects the connect", async () => {
    // Real loopback gateway. It speaks the connect handshake and then rejects
    // the client, reflecting the request target back in the error message the
    // way a proxy or upstream commonly does. Nothing here is stubbed: a real
    // `ws` server, a real socket, and the real GatewayClient connect path
    // produce the string that reaches the client's error logger.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
    const { address, port } = server.address() as AddressInfo;

    const requestTargetsSeenByServer: string[] = [];
    server.on("connection", (socket, req) => {
      const requestTarget = req.url ?? "";
      requestTargetsSeenByServer.push(requestTarget);
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          seq: 1,
          payload: { nonce: "redaction-proof-nonce", ts: 1_777_777_777_000 },
        }),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
        if (frame.method !== "connect") {
          return;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "unauthorized", message: `connect rejected for ${requestTarget}` },
          }),
        );
      });
    });

    const loggedLines: string[] = [];
    const firstErrorLine = new Promise<string>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}/${QUERY}`,
        preauthHandshakeTimeoutMs: 2_000,
        connectChallengeTimeoutMs: 2_000,
        hostDeps: {
          logDebug: (message) => {
            loggedLines.push(message);
          },
          logError: (message) => {
            loggedLines.push(message);
            resolve(message);
          },
        },
      });
      clients.push(client);
      client.start();
    });

    const logLine = await firstErrorLine;

    // The server really received the credentials, so redaction is the only
    // reason they could be absent from the log line.
    expect(requestTargetsSeenByServer[0]).toContain(`sessionSecret=${SESSION_SECRET}`);
    expect(requestTargetsSeenByServer[0]).toContain(`privateKeyPem=${PRIVATE_KEY_PEM}`);

    expect(logLine).toContain("gateway connect failed");
    expect(logLine).toContain("sessionSecret=***");
    expect(logLine).toContain("privateKeyPem=***");
    expect(logLine).toContain("authMethod=***");
    expect(logLine).toContain("X-Amz-Signature=***");
    // Non-credential params stay readable so the log keeps its diagnostic value.
    expect(logLine).toContain("safe=value");

    const everythingLogged = loggedLines.join("\n");
    for (const secret of [SESSION_SECRET, PRIVATE_KEY_PEM, AUTH_METHOD]) {
      expect(logLine).not.toContain(secret);
      expect(everythingLogged).not.toContain(secret);
    }

    console.log(
      `[gateway-client redaction proof] head=${resolveHeadSha()} loopback=${address === "127.0.0.1"} ` +
        "sessionSecret=redacted privateKeyPem=redacted authMethod=redacted " +
        `safe-param=preserved secret-output=${everythingLogged.includes(SESSION_SECRET)}\n` +
        `[gateway-client redaction proof] server_saw=${requestTargetsSeenByServer[0]}\n` +
        `[gateway-client redaction proof] logged=${logLine}\n` +
        "proof_marker_verified=true",
    );
  }, 30_000);
});
