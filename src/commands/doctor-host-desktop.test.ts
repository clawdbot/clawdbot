import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { noteHostDesktopHealth } from "./doctor-host-desktop.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.mocked(note).mockReset();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("host desktop doctor section", () => {
  it("reports the disabled Labs toggle", async () => {
    await noteHostDesktopHealth({});
    expect(note).toHaveBeenCalledWith(
      "disabled; enable the Desktop lab with desktop.host.enabled=true, then restart the gateway",
      "Host desktop",
    );
  });

  it("reports an attached VncAuth loopback server without password material", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => socket.write(Buffer.from([1, 2])));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected RFB address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => resolve());
        }),
    );

    await noteHostDesktopHealth({ desktop: { host: { enabled: true, port: address.port } } });
    expect(note).toHaveBeenCalledWith(
      `attached (127.0.0.1:${address.port}, security: VncAuth)`,
      "Host desktop",
    );
  });
});
