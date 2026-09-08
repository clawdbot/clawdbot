import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";
import { sendFormattedIrcText } from "./message-adapter.js";
import type { CoreConfig } from "./types.js";

describe("IRC formatted text on the wire", () => {
  let server: Awaited<ReturnType<typeof startIrcTestServer>>;
  let cfg: CoreConfig;
  let lines: string[];
  let disconnected: Promise<void>;

  beforeEach(async () => {
    lines = [];
    disconnected = Promise.resolve();
    server = await startIrcTestServer((socket) => {
      disconnected = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      onIrcTestLine(socket, (line) => {
        lines.push(line);
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
        }
        if (line.startsWith("QUIT")) {
          socket.end();
        }
      });
    });
    cfg = {
      channels: { irc: { host: "127.0.0.1", port: server.port, tls: false, nick: "bot" } },
    };
  });

  afterEach(async () => {
    await server.close();
  });

  it.each([
    {
      name: "fenced literals across the chunk boundary",
      text: `\`\`\`text\n${"x".repeat(340)}\n**KEEP_LITERAL**\n\`\`\``,
      expected: `${"x".repeat(340)} **KEEP_LITERAL**`,
    },
    {
      name: "a closing fence beyond the chunk boundary",
      text: `\`\`\`text\n${"x".repeat(345)}\n\`\`\``,
      expected: "x".repeat(345),
    },
    {
      name: "inline literals across the chunk boundary",
      text: `\`${"x".repeat(340)} **KEEP_LITERAL**\``,
      expected: `${"x".repeat(340)} **KEEP_LITERAL**`,
    },
    {
      name: "a long link label and its destination",
      text: `[${"word ".repeat(80).trim()}](https://example.com/docs)`,
      expected: `${"word ".repeat(80).trim()} (https://example.com/docs)`,
    },
  ])("preserves $name", async ({ text, expected }) => {
    const results = await sendFormattedIrcText({ cfg, to: "#room", text });
    await disconnected;

    const bodies = lines
      .filter((line) => line.startsWith("PRIVMSG #room :"))
      .map((line) => line.slice("PRIVMSG #room :".length));
    expect(bodies.join(" ")).toBe(expected);
    expect(results).toHaveLength(bodies.length);
    expect(lines.filter((line) => line.startsWith("USER "))).toHaveLength(1);
    expect(server.openSocketCount()).toBe(0);
  });

  it.each([
    { source: "implicit", mode: "first", textLimit: undefined, replies: "first" },
    { source: "implicit", mode: "all", textLimit: undefined, replies: "all" },
    { source: "explicit", mode: "first", textLimit: 16, replies: "all" },
  ] as const)("keeps $source/$mode replies with limit $textLimit", async (testCase) => {
    cfg.channels!.irc!.textChunkLimit = 40;
    cfg.channels!.irc!.accounts = { work: { textChunkLimit: 10 } };
    const results = await sendFormattedIrcText({
      cfg,
      accountId: "work",
      to: "#room",
      text: "**alpha beta gamma delta**",
      formatting: testCase.textLimit ? { textLimit: testCase.textLimit } : undefined,
      replyToId: "parent-1",
      replyToIdSource: testCase.source,
      replyToMode: testCase.mode,
    });
    await disconnected;

    const messages = lines.filter((line) => line.startsWith("PRIVMSG #room :"));
    const replyCount = testCase.replies === "first" ? 1 : messages.length;
    expect(results).toHaveLength(messages.length);
    expect(results.filter((result) => result.receipt?.replyToId === "parent-1")).toHaveLength(
      replyCount,
    );
    expect(messages.filter((line) => line.endsWith("[reply:parent-1]"))).toHaveLength(replyCount);
    const bodies = messages.map((line) =>
      line.slice("PRIVMSG #room :".length).replace(/ {2}\[reply:parent-1\]$/, ""),
    );
    expect(bodies.join(" ")).toBe("alpha beta gamma delta");
    expect(bodies.every((body) => body.length <= (testCase.textLimit ?? 10))).toBe(true);
    if (testCase.textLimit) {
      expect(bodies.some((body) => body.length > 10)).toBe(true);
    }
  });
});
