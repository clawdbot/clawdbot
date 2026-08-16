import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRfbSecurity, probeRfbServer } from "./rfb-probe.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Serves one scripted RFB handshake so probes exercise the real socket reader. */
async function listenScriptedRfb(script: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    script(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const address = server.address();
  if (typeof address === "string" || !address) {
    throw new Error("scripted RFB server did not bind a port");
  }
  return address.port;
}

function probe(port: number) {
  return probeRfbServer({ host: "127.0.0.1", port, timeoutMs: 2_000 });
}

describe("RFB server probe", () => {
  it.each([
    ["macOS Screen Sharing", "RFB 003.889\n", [30], [30]],
    ["TigerVNC", "RFB 003.008\n", [2], [2]],
    ["wayvnc", "RFB 003.008\n", [1], [1]],
    ["gnome-remote-desktop", "RFB 003.008\n", [19], [19]],
  ])("reads the %s security offer", async (_name, banner, offered, expected) => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from(banner, "ascii"));
      socket.once("data", (reply) => {
        expect(reply.toString("ascii")).toBe("RFB 003.008\n");
        socket.write(Buffer.from([offered.length, ...offered]));
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: expected });
  });

  it("reassembles a handshake split across packets", async () => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from("RFB 003", "ascii"));
      setTimeout(() => socket.write(Buffer.from(".008\n", "ascii")), 5);
      socket.once("data", () => {
        socket.write(Buffer.from([2]));
        setTimeout(() => socket.write(Buffer.from([2, 30])), 5);
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [2, 30] });
  });

  it("negotiates the legacy RFB 3.3 single security word", async () => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from("RFB 003.003\n", "ascii"));
      socket.once("data", (reply) => {
        expect(reply.toString("ascii")).toBe("RFB 003.003\n");
        socket.write(Buffer.from([0, 0, 0, 2]));
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [2] });
  });

  it("does not negotiate above an RFB 3.7 server", async () => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from("RFB 003.007\n", "ascii"));
      socket.once("data", (reply) => {
        expect(reply.toString("ascii")).toBe("RFB 003.007\n");
        socket.write(Buffer.from([1, 2]));
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [2] });
  });

  it("surfaces a rejected handshake as an empty security offer", async () => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => {
        const reason = Buffer.from("too many auth failures", "ascii");
        const header = Buffer.alloc(5);
        header.writeUInt8(0, 0);
        header.writeUInt32BE(reason.length, 1);
        socket.write(Buffer.concat([header, reason]));
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [] });
  });

  it.each([
    ["RFB 3.3", "RFB 003.003\n", Buffer.alloc(4)],
    ["RFB 3.8", "RFB 003.008\n", Buffer.from([0])],
  ])("does not buffer the %s failure reason", async (_name, banner, rejection) => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from(banner, "ascii"));
      socket.once("data", () => {
        const reasonLength = Buffer.alloc(4);
        reasonLength.writeUInt32BE(0xffff_ffff);
        socket.write(Buffer.concat([rejection, reasonLength]));
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [] });
  });

  it("reports a non-RFB occupant without reading past its banner", async () => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "ascii"));
    });
    await expect(probe(port)).resolves.toEqual({ kind: "not-rfb", banner: "HTTP/1.1 200" });
  });

  it("reports a truncated banner when the server hangs up early", async () => {
    const port = await listenScriptedRfb((socket) => {
      socket.end(Buffer.from("RFB 003", "ascii"));
    });
    await expect(probe(port)).resolves.toEqual({ kind: "not-rfb", banner: "RFB 003" });
  });

  it("reports an unreachable port", async () => {
    const port = await listenScriptedRfb(() => undefined);
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await expect(probe(port)).resolves.toEqual({ kind: "unreachable" });
  });

  it("times out a server that never speaks", async () => {
    const port = await listenScriptedRfb(() => undefined);
    await expect(probeRfbServer({ host: "127.0.0.1", port, timeoutMs: 50 })).resolves.toEqual({
      kind: "timeout",
    });
  });
});

describe("RFB security classification", () => {
  it("classifies supported security with password auth preferred over ARD", () => {
    expect(classifyRfbSecurity([1])).toBe("none");
    expect(classifyRfbSecurity([30])).toBe("ard-account");
    expect(classifyRfbSecurity([19])).toBe("unsupported");
    expect(classifyRfbSecurity([30, 2])).toBe("vnc-password");
    expect(classifyRfbSecurity([30, 33, 36, 35])).toBe("ard-account");
  });
});
