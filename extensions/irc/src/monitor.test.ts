// Irc tests cover monitor plugin behavior.
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { monitorIrcProvider } from "./monitor.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

type DisconnectingIrcServer = {
  port: number;
  lines: string[];
  connectionCount: number;
  close(): Promise<void>;
};

type InboundIrcServer = {
  port: number;
  close(): Promise<void>;
};

async function waitForIrcCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function startDisconnectingIrcServer(): Promise<DisconnectingIrcServer> {
  const lines: string[] = [];
  const sockets = new Set<net.Socket>();
  let connectionCount = 0;

  const server = net.createServer((socket) => {
    const connectionNumber = ++connectionCount;
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        lines.push(line);
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
          if (connectionNumber === 1) {
            setTimeout(() => socket.destroy(), 10);
          }
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback IRC server to bind a TCP port");
  }

  return {
    port: address.port,
    lines,
    get connectionCount() {
      return connectionCount;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function startInboundIrcServer(target: string): Promise<InboundIrcServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
          setTimeout(() => {
            socket.write(`:alice!ident@example.org PRIVMSG ${target} :hello\r\n`);
          }, 20);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback IRC server to bind a TCP port");
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function installMonitorRuntime() {
  setIrcRuntime({
    logging: {
      shouldLogVerbose: vi.fn(() => false),
      getChildLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
    channel: {
      activity: {
        record: vi.fn(),
      },
    },
  } as never);
}

describe("irc monitor reconnect", () => {
  it("reconnects when an established IRC socket closes", async () => {
    installMonitorRuntime();
    const server = await startDisconnectingIrcServer();
    const config = {
      channels: {
        irc: {
          host: "127.0.0.1",
          port: server.port,
          tls: false,
          nick: "bot",
          username: "bot",
          realname: "OpenClaw",
          channels: ["#openclaw"],
        },
      },
    } as CoreConfig;
    let monitor: { stop: () => void } | undefined;

    try {
      monitor = await monitorIrcProvider({ config });
      await waitForIrcCondition(
        () =>
          server.connectionCount >= 2 &&
          server.lines.filter((line) => line === "USER bot 0 * :OpenClaw").length >= 2,
        "expected IRC monitor to reconnect after the first socket closed",
      );

      expect(server.connectionCount).toBeGreaterThanOrEqual(2);
    } finally {
      monitor?.stop();
      await server.close();
    }
  });
});

describe("irc monitor inbound target", () => {
  it.each([
    {
      label: "channel",
      serverTarget: "#openclaw",
      expected: { isGroup: true, target: "#openclaw", rawTarget: "#openclaw" },
    },
    {
      label: "DM",
      serverTarget: "openclaw-bot",
      expected: { isGroup: false, target: "alice", rawTarget: "openclaw-bot" },
    },
  ])("maps $label targets through the monitor boundary", async ({ serverTarget, expected }) => {
    installMonitorRuntime();
    const server = await startInboundIrcServer(serverTarget);
    const messages: IrcInboundMessage[] = [];
    let monitor: { stop: () => void } | undefined;
    try {
      monitor = await monitorIrcProvider({
        config: {
          channels: {
            irc: {
              host: "127.0.0.1",
              port: server.port,
              tls: false,
              nick: "bot",
              username: "bot",
              realname: "OpenClaw",
            },
          },
        } as CoreConfig,
        onMessage: (message) => {
          messages.push(message);
        },
      });
      await waitForIrcCondition(() => messages.length === 1, "expected one inbound IRC message");
      expect(messages[0]).toMatchObject({
        ...expected,
        senderNick: "alice",
        text: "hello",
      });
    } finally {
      monitor?.stop();
      await server.close();
    }
  });
});
