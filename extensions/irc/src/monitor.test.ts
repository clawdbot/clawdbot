// Irc tests cover monitor plugin behavior.
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createIrcIngressMonitor } from "./irc-ingress.js";
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

type ReconnectingReplyIrcServer = {
  port: number;
  linesByConnection: string[][];
  connectionCount: number;
  disconnectFirst(): void;
  close(): Promise<void>;
};

type IrcIngressQueue = NonNullable<Parameters<typeof createIrcIngressMonitor>[0]["queue"]>;
type IrcIngressPayload = Parameters<IrcIngressQueue["enqueue"]>[1];

async function withIngressQueue<T>(fn: (queue: IrcIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-irc-monitor-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<IrcIngressPayload>({
    channelId: "irc",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

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

async function waitForIrcAsyncCondition(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
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

async function startInboundIrcServer(
  target?: string,
  welcomeNick = "bot",
  colonlessBody = false,
  senderNick = "alice",
): Promise<InboundIrcServer> {
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
          socket.write(`:server 001 ${welcomeNick} :welcome\r\n`);
          if (target) {
            setTimeout(() => {
              const bodySeparator = colonlessBody ? " " : " :";
              socket.write(
                `:${senderNick}!ident@example.org PRIVMSG ${target}${bodySeparator}hello\r\n`,
              );
            }, 20);
          }
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
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

async function startReconnectingReplyIrcServer(): Promise<ReconnectingReplyIrcServer> {
  const sockets: net.Socket[] = [];
  const linesByConnection: string[][] = [];
  const server = net.createServer((socket) => {
    const connectionIndex = sockets.length;
    sockets.push(socket);
    linesByConnection[connectionIndex] = [];
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        linesByConnection[connectionIndex]?.push(line);
        if (line.startsWith("USER ")) {
          const nick = connectionIndex === 0 ? "receipt-bot" : "reconnected-bot";
          socket.write(`:server 001 ${nick} :welcome\r\n`);
          if (connectionIndex === 0) {
            setTimeout(() => {
              socket.write(":alice!ident@example.org PRIVMSG receipt-bot :hello\r\n");
            }, 20);
          }
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback IRC server to bind a TCP port");
  }
  return {
    port: address.port,
    linesByConnection,
    get connectionCount() {
      return sockets.length;
    },
    disconnectFirst: () => sockets[0]?.destroy(),
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
  const activityRecord = vi.fn();
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
        record: activityRecord,
      },
    },
  } as never);
  return activityRecord;
}

function installPairingMonitorRuntime(
  upsertPairingRequest: () => Promise<{ code: string; created: boolean }>,
) {
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
      activity: { record: vi.fn() },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(upsertPairingRequest),
      },
      commands: { shouldHandleTextCommands: vi.fn(() => false) },
      text: { hasControlCommand: vi.fn(() => false) },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
    },
  } as never);
}

describe("irc monitor reconnect", () => {
  it("reconnects when an established IRC socket closes", async () => {
    await withIngressQueue(async (ingressQueue) => {
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
      let monitor: { stop: () => Promise<void> } | undefined;

      try {
        monitor = await monitorIrcProvider({ config, ingressQueue });
        await waitForIrcCondition(
          () =>
            server.connectionCount >= 2 &&
            server.lines.filter((line) => line === "USER bot 0 * :OpenClaw").length >= 2,
          "expected IRC monitor to reconnect after the first socket closed",
        );
        expect(server.connectionCount).toBeGreaterThanOrEqual(2);
      } finally {
        if (monitor) {
          await monitor.stop();
        }
        await server.close();
      }
    });
  });

  it("does not send a delayed private reply through the reconnected client", async () => {
    await withIngressQueue(async (ingressQueue) => {
      let resolvePairing = (_result: { code: string; created: boolean }) => {};
      let markPairingStarted = () => {};
      const pairingStarted = new Promise<void>((resolve) => {
        markPairingStarted = resolve;
      });
      const pairingResult = new Promise<{ code: string; created: boolean }>((resolve) => {
        resolvePairing = resolve;
      });
      installPairingMonitorRuntime(async () => {
        markPairingStarted();
        return await pairingResult;
      });
      const server = await startReconnectingReplyIrcServer();
      let monitor: { stop: () => Promise<void> } | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: {
            channels: {
              irc: {
                host: "127.0.0.1",
                port: server.port,
                tls: false,
                nick: "receipt-bot",
                username: "bot",
                realname: "OpenClaw",
                dmPolicy: "pairing",
              },
            },
          } as CoreConfig,
          ingressQueue,
        });
        await pairingStarted;
        server.disconnectFirst();
        await waitForIrcCondition(
          () =>
            server.connectionCount >= 2 &&
            server.linesByConnection[1]?.some((line) => line.startsWith("USER ")) === true,
          "expected IRC monitor to establish the replacement connection",
        );
        resolvePairing({ code: "CODE", created: true });
        await waitForIrcAsyncCondition(
          async () => (await ingressQueue.listPending({ limit: "all" })).length === 0,
          "expected the stale private reply to settle",
        );
        expect(
          server.linesByConnection[0]?.some((line) => line.startsWith("PRIVMSG alice :")),
        ).toBe(false);
        expect(
          server.linesByConnection[1]?.some((line) => line.startsWith("PRIVMSG alice :")),
        ).toBe(false);
      } finally {
        resolvePairing({ code: "CODE", created: true });
        if (monitor) {
          await monitor.stop();
        }
        await server.close();
      }
    });
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
    {
      label: "channel with a colonless body",
      serverTarget: "#openclaw",
      colonlessBody: true,
      expected: { isGroup: true, target: "#openclaw", rawTarget: "#openclaw" },
    },
  ])(
    "maps $label targets through the monitor boundary",
    async ({ serverTarget, colonlessBody, expected }) => {
      await withIngressQueue(async (ingressQueue) => {
        installMonitorRuntime();
        const server = await startInboundIrcServer(serverTarget, "bot", colonlessBody);
        const messages: IrcInboundMessage[] = [];
        let monitor: { stop: () => Promise<void> } | undefined;
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
            ingressQueue,
            onMessage: (message) => {
              messages.push(message);
            },
          });
          await waitForIrcCondition(
            () => messages.length === 1,
            "expected one inbound IRC message",
          );
          expect(messages[0]).toMatchObject({
            ...expected,
            senderNick: "alice",
            text: "hello",
          });
        } finally {
          if (monitor) {
            await monitor.stop();
          }
          await server.close();
        }
      });
    },
  );

  it("uses the receipt-time nickname when replaying a self echo", async () => {
    await withIngressQueue(async (ingressQueue) => {
      installMonitorRuntime();
      const eventId = "local:previous-connection:000000000001";
      const receivedAt = Date.now();
      await ingressQueue.enqueue(
        eventId,
        {
          version: 1,
          eventId,
          receivedAt,
          connectionEpoch: "previous-connection",
          connectedNick: "receipt-bot",
          rawLine: ":receipt-bot!ident@example.org PRIVMSG #openclaw :echo",
        },
        { receivedAt, laneKey: "channel:#openclaw" },
      );
      const server = await startInboundIrcServer(undefined, "reconnected-bot");
      const onMessage = vi.fn();
      let monitor: { stop: () => Promise<void> } | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: {
            channels: {
              irc: {
                host: "127.0.0.1",
                port: server.port,
                tls: false,
                nick: "reconnected-bot",
                username: "bot",
                realname: "OpenClaw",
              },
            },
          } as CoreConfig,
          ingressQueue,
          onMessage,
        });
        await waitForIrcAsyncCondition(
          async () => (await ingressQueue.listPending({ limit: "all" })).length === 0,
          "expected the replayed self echo to settle",
        );
        expect(onMessage).not.toHaveBeenCalled();
      } finally {
        if (monitor) {
          await monitor.stop();
        }
        await server.close();
      }
    });
  });

  it("does not replay a DM after the accepting connection changed", async () => {
    await withIngressQueue(async (ingressQueue) => {
      installMonitorRuntime();
      const eventId = "local:previous-connection:000000000002";
      const receivedAt = Date.now();
      await ingressQueue.enqueue(
        eventId,
        {
          version: 1,
          eventId,
          receivedAt,
          connectionEpoch: "previous-connection",
          connectedNick: "receipt-bot",
          rawLine: ":alice!ident@example.org PRIVMSG receipt-bot :private",
        },
        { receivedAt, laneKey: "direct:alice" },
      );
      const server = await startInboundIrcServer(undefined, "receipt-bot");
      const onMessage = vi.fn();
      let monitor: { stop: () => Promise<void> } | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: {
            channels: {
              irc: {
                host: "127.0.0.1",
                port: server.port,
                tls: false,
                nick: "receipt-bot",
                username: "bot",
                realname: "OpenClaw",
              },
            },
          } as CoreConfig,
          ingressQueue,
          onMessage,
        });
        await waitForIrcAsyncCondition(
          async () => (await ingressQueue.listPending({ limit: "all" })).length === 0,
          "expected the replayed DM to settle",
        );
        expect(onMessage).not.toHaveBeenCalled();
      } finally {
        if (monitor) {
          await monitor.stop();
        }
        await server.close();
      }
    });
  });

  it("does not record receipt-time self echoes as inbound activity", async () => {
    await withIngressQueue(async (ingressQueue) => {
      const activityRecord = installMonitorRuntime();
      const enqueueSpy = vi.spyOn(ingressQueue, "enqueue");
      const server = await startInboundIrcServer("#openclaw", "bot", false, "bot");
      const onMessage = vi.fn();
      let monitor: { stop: () => Promise<void> } | undefined;
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
          ingressQueue,
          onMessage,
        });
        await waitForIrcCondition(
          () => enqueueSpy.mock.calls.length === 1,
          "expected the receipt-time self echo to enter ingress",
        );
        await enqueueSpy.mock.results[0]?.value;
        await waitForIrcAsyncCondition(
          async () => (await ingressQueue.listPending({ limit: "all" })).length === 0,
          "expected the receipt-time self echo to settle",
        );
        expect(onMessage).not.toHaveBeenCalled();
        expect(activityRecord).not.toHaveBeenCalled();
      } finally {
        if (monitor) {
          await monitor.stop();
        }
        await server.close();
      }
    });
  });
});
