// Irc tests cover client plugin behavior.
import net from "node:net";
import { describe, expect, it } from "vitest";
import { connectIrcClient } from "./client.js";

type LoopbackIrcServer = {
  port: number;
  lines: string[];
  close(): Promise<void>;
};

type HangingIrcServer = {
  port: number;
  acceptedCount: number;
  closedCount: number;
  openSocketCount(): number;
  close(): Promise<void>;
};

async function startLoopbackIrcServer(options?: {
  rejectInitialNick?: boolean;
}): Promise<LoopbackIrcServer> {
  const lines: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let awaitingFallbackNick = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        lines.push(line);
        if (line.startsWith("USER ")) {
          if (options?.rejectInitialNick) {
            awaitingFallbackNick = true;
            socket.write(":server 433 * bot :Nickname in use\r\n");
          } else {
            socket.write(":server 001 bot :welcome\r\n");
          }
        } else if (awaitingFallbackNick && line.startsWith("NICK ")) {
          awaitingFallbackNick = false;
          socket.write(`:server 001 ${line.slice("NICK ".length)} :welcome\r\n`);
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

async function connectAndCollectRegistration(params: {
  nickserv: NonNullable<Parameters<typeof connectIrcClient>[0]["nickserv"]>;
  done: (lines: string[], errors: Error[]) => boolean;
}): Promise<{ lines: string[]; errors: Error[] }> {
  const server = await startLoopbackIrcServer();
  const errors: Error[] = [];
  const client = await connectIrcClient({
    host: "127.0.0.1",
    port: server.port,
    tls: false,
    nick: "bot",
    username: "bot",
    realname: "OpenClaw Bot",
    nickserv: params.nickserv,
    onError: (error) => errors.push(error),
  });
  try {
    await waitForIrcCondition(
      () => params.done(server.lines, errors),
      "expected IRC registration outcome",
    );
    return { lines: [...server.lines], errors };
  } finally {
    client.close();
    await server.close();
  }
}

async function connectAfterNickCollision(nick: string): Promise<string> {
  const server = await startLoopbackIrcServer({ rejectInitialNick: true });
  const client = await connectIrcClient({
    host: "127.0.0.1",
    port: server.port,
    tls: false,
    nick,
    username: "bot",
    realname: "OpenClaw Bot",
  });
  try {
    const nickLines = server.lines.filter((line) => line.startsWith("NICK "));
    expect(nickLines).toHaveLength(2);
    return nickLines[1]!.slice("NICK ".length);
  } finally {
    client.close();
    await server.close();
  }
}

async function waitForIrcCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
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

async function startHangingIrcServer(): Promise<HangingIrcServer> {
  const sockets = new Set<net.Socket>();
  let acceptedCount = 0;
  let closedCount = 0;
  const server = net.createServer((socket) => {
    acceptedCount += 1;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("data", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      closedCount += 1;
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
    get acceptedCount() {
      return acceptedCount;
    },
    get closedCount() {
      return closedCount;
    },
    openSocketCount: () => sockets.size,
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

describe("irc client nickserv", () => {
  it("sends IDENTIFY when a password is configured", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: { password: "secret" },
      done: (lines) => lines.includes("PRIVMSG NickServ :IDENTIFY secret"),
    });

    expect(result.lines).toContain("PRIVMSG NickServ :IDENTIFY secret");
  });

  it("sends REGISTER after IDENTIFY when enabled with email", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        password: "secret",
        register: true,
        registerEmail: "bot@example.com",
      },
      done: (lines) => lines.some((line) => line.startsWith("PRIVMSG NickServ :REGISTER ")),
    });

    expect(result.lines.filter((line) => line.startsWith("PRIVMSG NickServ :"))).toEqual([
      "PRIVMSG NickServ :IDENTIFY secret",
      "PRIVMSG NickServ :REGISTER secret bot@example.com",
    ]);
  });

  it("reports register without registerEmail", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        password: "secret",
        register: true,
      },
      done: (_lines, errors) => errors.length > 0,
    });

    expect(result.errors[0]?.message).toMatch(/registerEmail/);
  });

  it("sanitizes outbound NickServ payloads", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        service: "NickServ\n",
        password: "secret\r\nJOIN #bad",
      },
      done: (lines) => lines.some((line) => line.startsWith("PRIVMSG NickServ :IDENTIFY")),
    });

    expect(result.lines).toContain("PRIVMSG NickServ :IDENTIFY secret JOIN #bad");
  });
});

describe("irc client readiness timeout", () => {
  it("closes the socket when registration never becomes ready", async () => {
    const server = await startHangingIrcServer();
    try {
      await expect(
        connectIrcClient({
          host: "127.0.0.1",
          port: server.port,
          tls: false,
          nick: "bot",
          username: "bot",
          realname: "OpenClaw Bot",
          connectTimeoutMs: 50,
        }),
      ).rejects.toThrow(/IRC connect/);

      expect(server.acceptedCount).toBeGreaterThanOrEqual(1);
      await waitForIrcCondition(
        () => server.closedCount >= 1 && server.openSocketCount() === 0,
        `expected timed-out IRC connect socket to close; accepted=${server.acceptedCount} closed=${server.closedCount} open=${server.openSocketCount()}`,
      );
    } finally {
      await server.close();
    }
  });
});

describe("irc client fallback nick", () => {
  it("produces unique fallback nicks across sequential collisions", async () => {
    const first = await connectAfterNickCollision("bot");
    const second = await connectAfterNickCollision("bot");
    const third = await connectAfterNickCollision("bot");
    expect(first).toMatch(/^bot_\d*$/);
    expect(second).toMatch(/^bot_\d+$/);
    expect(third).toMatch(/^bot_\d+$/);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("sanitizes whitespace and special characters after a collision", async () => {
    const nick = await connectAfterNickCollision("my bot!");
    expect(nick).toMatch(/^mybot_\d*$/);
  });

  it("falls back to openclaw when a colliding nick is entirely special characters", async () => {
    const nick = await connectAfterNickCollision("!!!");
    expect(nick).toMatch(/^openclaw_\d*$/);
  });

  it("truncates a long fallback nick to 30 characters", async () => {
    const longNick = "a".repeat(50);
    const nick = await connectAfterNickCollision(longNick);
    expect(nick.length).toBeLessThanOrEqual(30);
    expect(nick).toMatch(/^a+_\d*$/);
  });
});

async function collectPrivmsgBodies(
  server: LoopbackIrcServer,
  text: string,
  messageChunkMaxChars?: number,
): Promise<string[]> {
  const client = await connectIrcClient({
    host: "127.0.0.1",
    port: server.port,
    tls: false,
    nick: "bot",
    username: "bot",
    realname: "OpenClaw Bot",
    connectTimeoutMs: 5000,
    messageChunkMaxChars,
  });
  const receivedBodies = () =>
    server.lines
      .filter((line) => line.startsWith("PRIVMSG #general :"))
      .map((line) => line.slice("PRIVMSG #general :".length));
  try {
    client.sendPrivmsg("#general", text);
    const deadline = Date.now() + 5000;
    while (receivedBodies().join("").length < text.length && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  } finally {
    client.close();
  }
  return receivedBodies();
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function maxLineBytes(bodies: string[]): number {
  return Math.max(
    ...bodies.map((body) => Buffer.byteLength(`PRIVMSG #general :${body}\r\n`, "utf8")),
  );
}

describe("irc client privmsg byte-limit chunking", () => {
  it("splits multi-byte text so every line fits the 512-byte IRC limit", async () => {
    const server = await startLoopbackIrcServer();
    try {
      const text = "漢".repeat(900);
      const bodies = await collectPrivmsgBodies(server, text);
      expect(bodies.length).toBeGreaterThan(1);
      expect(maxLineBytes(bodies)).toBeLessThanOrEqual(512);
      expect(bodies.join("")).toBe(text);
    } finally {
      await server.close();
    }
  });

  it("keeps emoji code points intact while honoring the byte limit", async () => {
    const server = await startLoopbackIrcServer();
    try {
      const text = "\u{1F600}".repeat(300);
      const bodies = await collectPrivmsgBodies(server, text);
      expect(maxLineBytes(bodies)).toBeLessThanOrEqual(512);
      for (const body of bodies) {
        expect(LONE_SURROGATE.test(body)).toBe(false);
      }
      expect(bodies.join("")).toBe(text);
    } finally {
      await server.close();
    }
  });

  it("preserves the existing 350-char chunking for ASCII text", async () => {
    const server = await startLoopbackIrcServer();
    try {
      const text = "a".repeat(900);
      const bodies = await collectPrivmsgBodies(server, text);
      expect(bodies.map((body) => body.length)).toEqual([350, 350, 200]);
      expect(bodies.join("")).toBe(text);
    } finally {
      await server.close();
    }
  });

  it("honors a low character cap for multibyte text without shrinking chunks to the byte budget", async () => {
    const server = await startLoopbackIrcServer();
    try {
      const text = "漢".repeat(250);
      const bodies = await collectPrivmsgBodies(server, text, 100);
      expect(bodies.map((body) => body.length)).toEqual([100, 100, 50]);
      expect(bodies.join("")).toBe(text);
    } finally {
      await server.close();
    }
  });

  it("still advances when the character cap is smaller than one multibyte code point's bytes", async () => {
    const server = await startLoopbackIrcServer();
    try {
      const text = "漢".repeat(10);
      const bodies = await collectPrivmsgBodies(server, text, 2);
      expect(bodies.map((body) => body.length)).toEqual([2, 2, 2, 2, 2]);
      expect(bodies.join("")).toBe(text);
    } finally {
      await server.close();
    }
  });

  it("keeps one astral code point whole when the legacy character cap is one UTF-16 unit", async () => {
    const server = await startLoopbackIrcServer();
    try {
      const text = "\u{1F600}".repeat(10);
      const bodies = await collectPrivmsgBodies(server, text, 1);
      expect(bodies.map((body) => body.length)).toEqual(Array(10).fill(2));
      expect(bodies.join("")).toBe(text);
    } finally {
      await server.close();
    }
  });
});
