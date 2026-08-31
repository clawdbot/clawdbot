// Irc tests cover client PRIVMSG surrogate-safe chunking.
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeSocket = {
  writes: string[];
  emit(eventName: string, ...args: unknown[]): boolean;
  setEncoding(encoding: BufferEncoding): FakeSocket;
  write(data: string | Uint8Array): boolean;
  end(): FakeSocket;
  destroy(): FakeSocket;
};

const socketMocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  class FakeSocketImpl extends EventEmitter implements FakeSocket {
    readonly writes: string[] = [];

    setEncoding(_encoding: BufferEncoding): this {
      return this;
    }

    write(data: string | Uint8Array): boolean {
      this.writes.push(String(data));
      return true;
    }

    end(): this {
      this.emit("close");
      return this;
    }

    destroy(): this {
      this.emit("close");
      return this;
    }
  }

  const sockets: FakeSocket[] = [];
  const connect = vi.fn(() => {
    const socket = new FakeSocketImpl();
    sockets.push(socket);
    setImmediate(() => socket.emit("connect"));
    return socket;
  });

  return {
    connect,
    sockets,
  };
});

vi.mock("node:net", () => ({
  connect: socketMocks.connect,
  default: {
    connect: socketMocks.connect,
  },
}));

vi.mock("node:tls", () => ({
  connect: socketMocks.connect,
  default: {
    connect: socketMocks.connect,
  },
}));

import { connectIrcClient } from "./client.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function containsLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

function requireLastSocket(): FakeSocket {
  const socket = socketMocks.sockets.at(-1);
  if (!socket) {
    throw new Error("expected fake IRC socket");
  }
  return socket;
}

function privmsgBodies(socket: FakeSocket): string[] {
  return socket.writes
    .filter((line) => line.startsWith("PRIVMSG "))
    .map((line) => line.replace(/^PRIVMSG \S+ :/, "").replace(/\r\n$/, ""));
}

async function connectReadyClient(messageChunkMaxChars: number) {
  const clientPromise = connectIrcClient({
    host: "irc.example.com",
    port: 6667,
    tls: false,
    nick: "bot",
    username: "bot",
    realname: "OpenClaw Bot",
    connectTimeoutMs: 1000,
    messageChunkMaxChars,
  });

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const socket = requireLastSocket();
  socket.emit("data", ":server 001 bot :welcome\r\n");
  const client = await clientPromise;
  socket.writes.length = 0;
  return { client, socket };
}

afterEach(() => {
  socketMocks.connect.mockClear();
  socketMocks.sockets.length = 0;
});

describe("irc client PRIVMSG chunking", () => {
  it("does not split an emoji surrogate pair across PRIVMSG chunks", async () => {
    const { client, socket } = await connectReadyClient(10);
    const text = `${"x".repeat(9)}\u{1F642}rest`;

    client.sendPrivmsg("#room", text);

    const bodies = privmsgBodies(socket);
    expect(bodies).toEqual(["xxxxxxxxx", "\u{1F642}rest"]);
    expect(bodies.join("")).toBe(text);
    expect(bodies.some(containsLoneSurrogate)).toBe(false);

    client.close();
  });

  it("keeps a leading emoji whole when the UTF-16 budget is one code unit", async () => {
    const { client, socket } = await connectReadyClient(1);
    const text = "\u{1F642}A";

    client.sendPrivmsg("#room", text);

    const bodies = privmsgBodies(socket);
    expect(bodies).toEqual(["\u{1F642}", "A"]);
    expect(bodies.join("")).toBe(text);
    expect(bodies.some(containsLoneSurrogate)).toBe(false);

    client.close();
  });

  it("preserves one-unit chunks for BMP text", async () => {
    const { client, socket } = await connectReadyClient(1);

    client.sendPrivmsg("#room", "ABC");

    expect(privmsgBodies(socket)).toEqual(["A", "B", "C"]);

    client.close();
  });

  it("splits an all-emoji message into whole emoji when the budget is one code unit", async () => {
    const { client, socket } = await connectReadyClient(1);
    const text = "\u{1F642}\u{1F642}\u{1F642}";

    client.sendPrivmsg("#room", text);

    const bodies = privmsgBodies(socket);
    expect(bodies).toEqual(["\u{1F642}", "\u{1F642}", "\u{1F642}"]);
    expect(bodies.join("")).toBe(text);
    expect(bodies.some(containsLoneSurrogate)).toBe(false);

    client.close();
  });

  it("still prefers a nearby space when splitting long PRIVMSG text", async () => {
    const { client, socket } = await connectReadyClient(10);

    client.sendPrivmsg("#room", "alpha beta gamma");

    expect(privmsgBodies(socket)).toEqual(["alpha beta", "gamma"]);

    client.close();
  });
});
