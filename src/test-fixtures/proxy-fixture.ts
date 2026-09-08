import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  PROXY_FIXTURE_CERTIFICATE as certificate,
  PROXY_FIXTURE_KEY as privateKey,
} from "../test-helpers/proxy-tls-fixture.js";

export const PROXY_FIXTURE_HOST = "files.proxy.test";
export const PROXY_FIXTURE_PAYLOAD = "proxy media bytes\n";
export async function withProxyFixture(
  run: (fixture: {
    httpProxy: string;
    httpOrigin: string;
    httpsOrigin: string;
    httpsProxy: string;
    otherHttpsProxy: string;
    socksProxy: string;
    tlsSocksProxy: string;
    connections: string[];
    originRoutes: Array<"proxy" | "direct">;
    certificate: string;
    waitForProxyProtocol: () => Promise<string>;
    waitForSocketsClosed: () => Promise<void>;
  }) => Promise<void>,
  socksCredentials?: { username: string; password: string },
): Promise<void> {
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  const connections: string[] = [];
  const originRoutes: Array<"proxy" | "direct"> = [];
  const proxiedPorts = new Set<number>();
  const events = new EventEmitter();
  const trackSocket = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      events.emit("socketClosed");
    });
  };
  const listen = async (server: net.Server) => {
    servers.push(server);
    server.on("connection", trackSocket);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    return address.port;
  };
  const tlsOptions = { key: privateKey, cert: certificate };
  const handleOrigin: http.RequestListener = (request, response) => {
    originRoutes.push(proxiedPorts.has(request.socket.remotePort ?? -1) ? "proxy" : "direct");
    const requestPath = request.url ?? "/";
    if (request.url?.endsWith("/getFile")) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { file_id: fileId } = JSON.parse(Buffer.concat(chunks).toString()) as {
          file_id: string;
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              file_id: fileId,
              file_unique_id: fileId,
              file_path: fileId,
            },
          }),
        );
      });
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://outside.proxy.test/media" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    if (requestPath.endsWith("/stall")) {
      response.flushHeaders();
      return;
    }
    response.end(
      requestPath.startsWith("/file/") ? requestPath.split("/").at(-1) : PROXY_FIXTURE_PAYLOAD,
    );
  };
  let originPort: number;
  let plainOriginPort: number;
  const tunnel = (
    client: net.Socket,
    hostname: string,
    port: number,
    ready: () => void,
    head: Buffer,
    deny: () => void,
  ) => {
    if (hostname !== PROXY_FIXTURE_HOST || (port !== 443 && port !== 80)) {
      deny();
      return;
    }
    const upstream = net.connect({
      host: "127.0.0.1",
      port: port === 443 ? originPort : plainOriginPort,
    });
    trackSocket(upstream);
    upstream.once("connect", () => {
      const localPort = upstream.localPort;
      if (localPort !== undefined) {
        proxiedPorts.add(localPort);
        upstream.once("close", () => proxiedPorts.delete(localPort));
      }
      ready();
      if (head.length) {
        upstream.write(head);
      }
      client.pipe(upstream).pipe(client);
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  };
  const connectProxy = (secure: boolean) => {
    const server = secure
      ? http2.createSecureServer({ ...tlsOptions, allowHTTP1: true })
      : http.createServer();
    if (secure) {
      server.on("sessionError", () => {});
      server.on("secureConnection", (socket: tls.TLSSocket) => {
        events.emit("proxyProtocol", socket.alpnProtocol);
      });
    }
    server.on("connect", (request, client, head) => {
      const target = new URL(`http://${request.url}`);
      connections.push(`${secure ? "https" : "http"}:${target.hostname}`);
      tunnel(
        client as net.Socket,
        target.hostname,
        Number(target.port || 80),
        () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        },
        head,
        () => client.destroy(),
      );
    });
    return server;
  };
  const acceptSocks = (client: net.Socket) => {
    let phase: "greeting" | "auth" | "connect" = "greeting";
    let buffer = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === "greeting") {
        if (buffer.readUInt8(0) !== 5) {
          connections.push(`unexpected-proxy-protocol:${buffer.readUInt8(0)}`);
          client.destroy();
          return;
        }
        if (buffer.length < 2 || buffer.length < 2 + buffer.readUInt8(1)) {
          return;
        }
        const method = socksCredentials ? 2 : 0;
        if (!buffer.subarray(2, 2 + buffer.readUInt8(1)).includes(method)) {
          client.end(Buffer.from([5, 255]));
          return;
        }
        buffer = buffer.subarray(2 + buffer.readUInt8(1));
        phase = socksCredentials ? "auth" : "connect";
        client.write(Buffer.from([5, method]));
      }
      if (phase === "auth") {
        if (buffer.length < 2) {
          return;
        }
        const usernameLength = buffer.readUInt8(1);
        if (buffer.length < 3 + usernameLength) {
          return;
        }
        const frameLength = 3 + usernameLength + buffer.readUInt8(2 + usernameLength);
        if (buffer.length < frameLength) {
          return;
        }
        if (
          buffer.readUInt8(0) !== 1 ||
          buffer.subarray(2, 2 + usernameLength).toString() !== socksCredentials?.username ||
          buffer.subarray(3 + usernameLength, frameLength).toString() !== socksCredentials?.password
        ) {
          client.end(Buffer.from([1, 1]));
          return;
        }
        buffer = buffer.subarray(frameLength);
        phase = "connect";
        client.write(Buffer.from([1, 0]));
      }
      if (buffer.length < 5) {
        return;
      }
      if (buffer.readUInt8(0) !== 5 || buffer.readUInt8(1) !== 1 || buffer.readUInt8(3) !== 3) {
        client.destroy();
        return;
      }
      const length = buffer.readUInt8(4);
      if (buffer.length < 7 + length) {
        return;
      }
      const hostname = buffer.subarray(5, 5 + length).toString();
      const port = buffer.readUInt16BE(5 + length);
      connections.push(`socks:${hostname}`);
      client.off("data", receive);
      tunnel(
        client,
        hostname,
        port,
        () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        },
        buffer.subarray(7 + length),
        // A protocol refusal settles the client immediately; closing alone leaves
        // Undici's SOCKS CONNECT waiter pending until its separate timeout.
        () => client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])),
      );
    };
    client.on("data", receive);
  };
  try {
    originPort = await listen(https.createServer(tlsOptions, handleOrigin));
    plainOriginPort = await listen(http.createServer(handleOrigin));
    const httpPort = await listen(connectProxy(false));
    const httpsPort = await listen(connectProxy(true));
    const otherHttpsPort = await listen(connectProxy(true));
    const socksPort = await listen(net.createServer(acceptSocks));
    const tlsSocksPort = await listen(tls.createServer(tlsOptions, acceptSocks));
    await run({
      httpProxy: `http://127.0.0.1:${httpPort}`,
      httpOrigin: `http://127.0.0.1:${plainOriginPort}`,
      httpsOrigin: `https://127.0.0.1:${originPort}`,
      httpsProxy: `https://127.0.0.1:${httpsPort}`,
      otherHttpsProxy: `https://127.0.0.1:${otherHttpsPort}`,
      socksProxy: `socks5://127.0.0.1:${socksPort}`,
      tlsSocksProxy: `socks5://127.0.0.1:${tlsSocksPort}`,
      connections,
      originRoutes,
      certificate,
      waitForProxyProtocol: () =>
        new Promise<string>((resolve) => {
          events.once("proxyProtocol", resolve);
        }),
      waitForSocketsClosed: async () => {
        while (sockets.size > 0) {
          await once(events, "socketClosed", { signal: AbortSignal.timeout(5_000) });
        }
      },
    });
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  }
}
