// Gateway Client tests cover credential redaction in connect-failure logging.
import { execFileSync } from "node:child_process";
import http from "node:http";
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

const UPGRADE_BODY_CREDENTIAL = "AKIAUPGRADEBODYCREDENTIAL";
const UPGRADE_BODY_SIGNATURE = "UPGRADEBODYSIGNATUREVALUE";
// A signed-URL form body, the shape a cloud proxy reflects back when it refuses
// the upgrade. Its first pair carries no `?`/`&`, because the body is appended
// to the error text after `: ` rather than parsed out of a URL.
const UPGRADE_REJECTION_BODY =
  `X-Amz-Credential=${UPGRADE_BODY_CREDENTIAL}` +
  `&X-Amz-Signature=${UPGRADE_BODY_SIGNATURE}` +
  "&X-Amz-Date=20260813T000000Z";

describe("GatewayClient rejected-upgrade diagnostics", () => {
  const servers: http.Server[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    await Promise.all(
      servers.splice(0).map(
        async (server) =>
          await new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("redacts signed fields of a rejected upgrade body before hosts see the error", async () => {
    // Real loopback HTTP server: it answers the websocket upgrade with an HTTP
    // rejection instead of a 101, which is the path that appends the response
    // body to the client's error text. Nothing is stubbed, so this is the exact
    // string a host receives, and hosts log it verbatim -- `node-host/runner.ts`
    // writes `error.message` straight to stderr from `onConnectError`.
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/x-www-form-urlencoded" });
      res.end(UPGRADE_REJECTION_BODY);
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const loggedLines: string[] = [];
    const connectErrorMessage = await new Promise<string>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: (error) => resolve(error.message),
        hostDeps: {
          logDebug: (message) => loggedLines.push(message),
          logError: (message) => loggedLines.push(message),
        },
      });
      clients.push(client);
      client.start();
    });

    expect(connectErrorMessage).toContain("gateway rejected websocket upgrade (HTTP 403)");
    // The leading pair has no `?`/`&` in front of it, so query-shaped redaction
    // alone leaves it in the clear.
    expect(connectErrorMessage).toContain("X-Amz-Credential=***");
    expect(connectErrorMessage).toContain("X-Amz-Signature=***");
    // The non-credential field stays readable, so the rejection keeps the
    // diagnostic value that made it worth surfacing.
    expect(connectErrorMessage).toContain("X-Amz-Date=20260813T000000Z");

    const everythingSurfaced = [connectErrorMessage, ...loggedLines].join("\n");
    for (const secret of [UPGRADE_BODY_CREDENTIAL, UPGRADE_BODY_SIGNATURE]) {
      expect(everythingSurfaced).not.toContain(secret);
    }

    console.log(
      `[gateway-client upgrade-body redaction proof] head=${resolveHeadSha()} ` +
        "leading_field=redacted trailing_field=redacted non_credential_field=preserved " +
        `secret-output=${everythingSurfaced.includes(UPGRADE_BODY_CREDENTIAL)}\n` +
        `[gateway-client upgrade-body redaction proof] server_sent=${UPGRADE_REJECTION_BODY}\n` +
        `[gateway-client upgrade-body redaction proof] host_saw=${connectErrorMessage}\n` +
        "proof_marker_verified=true",
    );
  }, 30_000);
});

const UPGRADE_JSON_CREDENTIAL = "AKIAUPGRADEJSONCREDENTIAL";
const UPGRADE_JSON_SIGNATURE = "UPGRADEJSONSIGNATUREVALUE";
// The same rejection expressed as JSON. `readUpgradeErrorBody` accepts an
// arbitrary peer body, so a proxy is free to answer in this shape; the
// equals-only redactor left these values in the clear.
const UPGRADE_JSON_REJECTION_BODY = JSON.stringify({
  "X-Amz-Credential": UPGRADE_JSON_CREDENTIAL,
  "X-Amz-Signature": UPGRADE_JSON_SIGNATURE,
  "X-Amz-Date": "20260813T000000Z",
});

describe("GatewayClient structured rejected-upgrade diagnostics", () => {
  const servers: http.Server[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    await Promise.all(
      servers.splice(0).map(
        async (server) =>
          await new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("redacts signed fields of a JSON rejected-upgrade body before hosts see the error", async () => {
    // Real loopback server again, this time answering with a JSON body.
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(UPGRADE_JSON_REJECTION_BODY);
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const loggedLines: string[] = [];
    const connectErrorMessage = await new Promise<string>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: (error) => resolve(error.message),
        hostDeps: {
          logDebug: (message) => loggedLines.push(message),
          logError: (message) => loggedLines.push(message),
        },
      });
      clients.push(client);
      client.start();
    });

    expect(connectErrorMessage).toContain("gateway rejected websocket upgrade (HTTP 403)");
    // The non-credential field stays readable for diagnostics.
    expect(connectErrorMessage).toContain("20260813T000000Z");

    const everythingSurfaced = [connectErrorMessage, ...loggedLines].join("\n");
    for (const secret of [UPGRADE_JSON_CREDENTIAL, UPGRADE_JSON_SIGNATURE]) {
      expect(everythingSurfaced).not.toContain(secret);
    }

    console.log(
      `[gateway-client json-upgrade-body redaction proof] head=${resolveHeadSha()} ` +
        "json_credential=redacted json_signature=redacted non_credential_field=preserved " +
        `secret-output=${everythingSurfaced.includes(UPGRADE_JSON_CREDENTIAL)}\n` +
        `[gateway-client json-upgrade-body redaction proof] server_sent=${UPGRADE_JSON_REJECTION_BODY}\n` +
        `[gateway-client json-upgrade-body redaction proof] host_saw=${connectErrorMessage}\n` +
        "proof_marker_verified=true",
    );
  }, 30_000);
});

const UPGRADE_ESCAPED_SIGNATURE = "ESCAPEDUPGRADESIGNATUREVALUE";
// A valid JSON spelling of `X-Amz-Signature` that uses a unicode escape for the
// `S`. A peer can send this instead of the plain name, and matching only the raw
// key text let it walk past the classifier.
const UPGRADE_ESCAPED_REJECTION_BODY = `{"X-Amz-\\u0053ignature":"${UPGRADE_ESCAPED_SIGNATURE}","X-Amz-Date":"20260813T000000Z"}`;

describe("GatewayClient escaped-key rejected-upgrade diagnostics", () => {
  const servers: http.Server[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    await Promise.all(
      servers.splice(0).map(
        async (server) =>
          await new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("redacts an escaped JSON credential key before hosts see the error", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(UPGRADE_ESCAPED_REJECTION_BODY);
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const loggedLines: string[] = [];
    const connectErrorMessage = await new Promise<string>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: (error) => resolve(error.message),
        hostDeps: {
          logDebug: (message) => loggedLines.push(message),
          logError: (message) => loggedLines.push(message),
        },
      });
      clients.push(client);
      client.start();
    });

    expect(connectErrorMessage).toContain("gateway rejected websocket upgrade (HTTP 403)");
    expect(connectErrorMessage).toContain("20260813T000000Z");

    const everythingSurfaced = [connectErrorMessage, ...loggedLines].join("\n");
    expect(everythingSurfaced).not.toContain(UPGRADE_ESCAPED_SIGNATURE);

    console.log(
      `[gateway-client escaped-key redaction proof] head=${resolveHeadSha()} ` +
        "escaped_signature=redacted non_credential_field=preserved " +
        `secret-output=${everythingSurfaced.includes(UPGRADE_ESCAPED_SIGNATURE)}\n` +
        `[gateway-client escaped-key redaction proof] server_sent=${UPGRADE_ESCAPED_REJECTION_BODY}\n` +
        `[gateway-client escaped-key redaction proof] host_saw=${connectErrorMessage}\n` +
        "proof_marker_verified=true",
    );
  }, 30_000);
});

const UPGRADE_QUOTED_SECRET = "QUOTEDUPGRADESESSIONSECRET";
// A quote-wrapped form value. A peer is free to quote the value, and an
// unquoted-only value class stops at the opening quote, so the credential
// survived into the host-visible error text.
const UPGRADE_QUOTED_REJECTION_BODY = `sessionSecret="${UPGRADE_QUOTED_SECRET}"&safe=value`;

describe("GatewayClient quoted-value rejected-upgrade diagnostics", () => {
  const servers: http.Server[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    await Promise.all(
      servers.splice(0).map(
        async (server) =>
          await new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("redacts a quote-wrapped credential value before hosts see the error", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/x-www-form-urlencoded" });
      res.end(UPGRADE_QUOTED_REJECTION_BODY);
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const loggedLines: string[] = [];
    const connectErrorMessage = await new Promise<string>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: (error) => resolve(error.message),
        hostDeps: {
          logDebug: (message) => loggedLines.push(message),
          logError: (message) => loggedLines.push(message),
        },
      });
      clients.push(client);
      client.start();
    });

    expect(connectErrorMessage).toContain("gateway rejected websocket upgrade (HTTP 403)");
    expect(connectErrorMessage).toContain("safe=value");

    const everythingSurfaced = [connectErrorMessage, ...loggedLines].join("\n");
    expect(everythingSurfaced).not.toContain(UPGRADE_QUOTED_SECRET);

    console.log(
      `[gateway-client quoted-value redaction proof] head=${resolveHeadSha()} ` +
        "quoted_credential=redacted non_credential_field=preserved " +
        `secret-output=${everythingSurfaced.includes(UPGRADE_QUOTED_SECRET)}\n` +
        `[gateway-client quoted-value redaction proof] server_sent=${UPGRADE_QUOTED_REJECTION_BODY}\n` +
        `[gateway-client quoted-value redaction proof] host_saw=${connectErrorMessage}\n` +
        "proof_marker_verified=true",
    );
  }, 30_000);
});

const UPGRADE_NESTED_SECRET = "NESTEDUPGRADESESSIONSECRET";
// A safe outer field whose string value is itself a serialized JSON document.
// The escaped inner text matches neither pair pattern, so the credential rode
// through untouched until the nested pass was added.
const UPGRADE_NESTED_REJECTION_BODY = JSON.stringify({
  detail: JSON.stringify({ sessionSecret: UPGRADE_NESTED_SECRET, safe: "keep" }),
});

describe("GatewayClient nested-json rejected-upgrade diagnostics", () => {
  const servers: http.Server[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    await Promise.all(
      servers.splice(0).map(
        async (server) =>
          await new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("redacts a credential nested in serialized JSON before hosts see the error", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(UPGRADE_NESTED_REJECTION_BODY);
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const loggedLines: string[] = [];
    const connectErrorMessage = await new Promise<string>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: (error) => resolve(error.message),
        hostDeps: {
          logDebug: (message) => loggedLines.push(message),
          logError: (message) => loggedLines.push(message),
        },
      });
      clients.push(client);
      client.start();
    });

    expect(connectErrorMessage).toContain("gateway rejected websocket upgrade (HTTP 403)");
    // The non-credential sibling stays readable.
    expect(connectErrorMessage).toContain("keep");

    const everythingSurfaced = [connectErrorMessage, ...loggedLines].join("\n");
    expect(everythingSurfaced).not.toContain(UPGRADE_NESTED_SECRET);

    console.log(
      `[gateway-client nested-json redaction proof] head=${resolveHeadSha()} ` +
        "nested_credential=redacted non_credential_field=preserved " +
        `secret-output=${everythingSurfaced.includes(UPGRADE_NESTED_SECRET)}\n` +
        `[gateway-client nested-json redaction proof] server_sent=${UPGRADE_NESTED_REJECTION_BODY}\n` +
        `[gateway-client nested-json redaction proof] host_saw=${connectErrorMessage}\n` +
        "proof_marker_verified=true",
    );
  }, 30_000);
});
