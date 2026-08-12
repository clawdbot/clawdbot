import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectRfbAttachment } from "./attachment.js";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("RFB attachments", () => {
  it("connects a loopback TCP attachment", async () => {
    const accepted = new Promise<void>((resolve) => {
      const server = net.createServer((socket) => {
        sockets.push(socket);
        resolve();
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
    });
    const server = servers[0];
    if (!server) {
      throw new Error("expected TCP test server");
    }
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP test server address");
    }

    sockets.push(connectRfbAttachment({ kind: "tcp", host: "127.0.0.1", port: address.port }));

    await expect(accepted).resolves.toBeUndefined();
  });
});
