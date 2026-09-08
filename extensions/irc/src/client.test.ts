// Irc tests cover client plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it } from "vitest";
import { connectIrcClient } from "./client.js";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";

type LoopbackIrcServer = {
  port: number;
  lines: string[];
  quitReceived: Promise<void>;
  close(): Promise<void>;
};

type HangingIrcServer = {
  port: number;
  acceptedCount: number;
  closedCount: number;
  socketClosed: Promise<void>;
  openSocketCount(): number;
  close(): Promise<void>;
};

async function startLoopbackIrcServer(options?: {
  rejectInitialNick?: boolean;
}): Promise<LoopbackIrcServer> {
  const lines: string[] = [];
  const quitReceived = createDeferred<void>();
  const server = await startIrcTestServer((socket) => {
    let awaitingFallbackNick = false;
    onIrcTestLine(socket, (line) => {
      lines.push(line);
      if (line.startsWith("QUIT :")) {
        quitReceived.resolve();
      }
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
    });
  });
  return { ...server, lines, quitReceived: quitReceived.promise };
}

async function connectAndCollectRegistration(params: {
  nickserv: NonNullable<Parameters<typeof connectIrcClient>[0]["nickserv"]>;
}): Promise<{ lines: string[]; errors: Error[] }> {
  const server = await startLoopbackIrcServer();
  const errors: Error[] = [];
  let client: Awaited<ReturnType<typeof connectIrcClient>> | undefined;
  try {
    client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick: "bot",
      username: "bot",
      realname: "OpenClaw Bot",
      nickserv: params.nickserv,
      onError: (error) => errors.push(error),
    });
    // QUIT follows all registration writes on the same stream; wait for peer receipt.
    client.quit("test complete");
    await withTimeout(server.quitReceived, 1000, "IRC registration output");
    return { lines: [...server.lines], errors };
  } finally {
    client?.close();
    await server.close();
  }
}

async function connectAfterNickCollision(nick: string): Promise<string> {
  const server = await startLoopbackIrcServer({ rejectInitialNick: true });
  let client: Awaited<ReturnType<typeof connectIrcClient>> | undefined;
  try {
    client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick,
      username: "bot",
      realname: "OpenClaw Bot",
    });
    const nickLines = server.lines.filter((line) => line.startsWith("NICK "));
    expect(nickLines).toHaveLength(2);
    return nickLines[1]!.slice("NICK ".length);
  } finally {
    client?.close();
    await server.close();
  }
}

async function startHangingIrcServer(): Promise<HangingIrcServer> {
  let acceptedCount = 0;
  let closedCount = 0;
  const socketClosed = createDeferred<void>();
  const server = await startIrcTestServer((socket) => {
    acceptedCount += 1;
    socket.on("data", () => {});
    socket.on("close", () => {
      closedCount += 1;
      socketClosed.resolve();
    });
  });
  return {
    ...server,
    socketClosed: socketClosed.promise,
    get acceptedCount() {
      return acceptedCount;
    },
    get closedCount() {
      return closedCount;
    },
  };
}

describe("irc client nickserv", () => {
  it("sends IDENTIFY when a password is configured", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: { password: "secret" },
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
    });

    expect(result.errors[0]?.message).toMatch(/registerEmail/);
  });

  it("sanitizes outbound NickServ payloads", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        service: "NickServ\n",
        password: "secret\r\nJOIN #bad",
      },
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

      await withTimeout(server.socketClosed, 1000, "timed-out IRC socket close");
      expect(server.acceptedCount).toBeGreaterThanOrEqual(1);
      expect(server.closedCount).toBeGreaterThanOrEqual(1);
      expect(server.openSocketCount()).toBe(0);
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
  try {
    client.sendPrivmsg("#general", text);
    client.quit("test complete");
    await withTimeout(server.quitReceived, 5000, "IRC PRIVMSG output");
    return server.lines
      .filter((line) => line.startsWith("PRIVMSG #general :"))
      .map((line) => line.slice("PRIVMSG #general :".length));
  } finally {
    client.close();
  }
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
