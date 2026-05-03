import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "./transcript.js";

describe("appendAssistantMessageToSessionTranscript", () => {
  const fixture = useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "test-session";
  type ExactAssistantMessage = Parameters<
    typeof appendExactAssistantMessageToSessionTranscript
  >[0]["message"];

  function writeTranscriptStore() {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          chatType: "direct",
          channel: "discord",
        },
      }),
      "utf-8",
    );
  }

  function createExactAssistantMessage(params: {
    text?: string;
    content?: ExactAssistantMessage["content"];
    provider?: string;
    model?: string;
  }): ExactAssistantMessage {
    return {
      role: "assistant",
      content: params.content ?? [{ type: "text", text: params.text ?? "" }],
      api: "openai-responses",
      provider: params.provider ?? "codex",
      model: params.model ?? "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  it("creates transcript file and appends message for valid session", async () => {
    writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sessionFile)).toBe(true);
      const sessionFileMode = fs.statSync(result.sessionFile).mode & 0o777;
      if (process.platform !== "win32") {
        expect(sessionFileMode).toBe(0o600);
      }

      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const header = JSON.parse(lines[0]);
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.type).toBe("message");
      expect(messageLine.message.role).toBe("assistant");
      expect(messageLine.message.content[0].type).toBe("text");
      expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    const store = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile,
        sessionKey,
        messageId: expect.any(String),
        message: expect.objectContaining({
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "Hello from delivery mirror!" }],
        }),
      }),
    );
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const messageLine = JSON.parse(lines[1]);
    expect(messageLine.message.idempotencyKey).toBe("mirror:test-source-message");
    expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
  });

  it("does not append a duplicate delivery mirror when the latest assistant message already matches", async () => {
    writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Hello from Codex!" }),
    });

    expect(exactResult.ok).toBe(true);

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from Codex!",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (exactResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(exactResult.messageId);
      const lines = fs.readFileSync(mirrorResult.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.provider).toBe("codex");
      expect(messageLine.message.model).toBe("gpt-5.4");
      expect(messageLine.message.content[0].text).toBe("Hello from Codex!");
    }
  });

  it("does not reuse an older matching assistant message across turns", async () => {
    writeTranscriptStore();

    const olderResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Repeated answer" }),
    });

    const latestResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Different latest answer" }),
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated answer",
      storePath: fixture.storePath(),
    });

    expect(olderResult.ok).toBe(true);
    expect(latestResult.ok).toBe(true);
    expect(mirrorResult.ok).toBe(true);
    if (olderResult.ok && latestResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(olderResult.messageId);
      expect(mirrorResult.messageId).not.toBe(latestResult.messageId);

      const lines = fs.readFileSync(mirrorResult.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(4);

      const messageLine = JSON.parse(lines[3]);
      expect(messageLine.message.provider).toBe("openclaw");
      expect(messageLine.message.model).toBe("delivery-mirror");
      expect(messageLine.message.content[0].text).toBe("Repeated answer");
    }
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:bluebubbles:direct:+15551234567";
    const store = {
      [storeKey]: {
        sessionId: "test-session-normalized",
        chatType: "direct",
        channel: "bluebubbles",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:BlueBubbles:direct:+15551234567",
      text: "Hello normalized!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:slack:direct:u12345abc";
    const store = {
      [storeKey]: {
        sessionId: "test-slack-session",
        chatType: "direct",
        channel: "slack",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      text: "Hello Slack user!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("ignores malformed transcript lines when checking mirror idempotency", async () => {
    writeTranscriptStore();

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        "{not-json",
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            idempotencyKey: "mirror:test-source-message",
            content: [{ type: "text", text: "Hello from delivery mirror!" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  it("appends exact assistant transcript messages without rewriting phased content", async () => {
    writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        content: [
          {
            type: "text",
            text: "internal reasoning",
            textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          },
        ],
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.content).toEqual([
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ]);
    }
  });

  it("can emit file-only transcript refresh events for exact assistant appends", async () => {
    writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      updateMode: "file-only",
      message: createExactAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledWith({
        sessionFile: result.sessionFile,
        sessionKey,
      });
    }
    emitSpy.mockRestore();
  });

  it("serializes concurrent parent-linked transcript appends", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "concurrent-tree-session",
      fixture.sessionsDir(),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "concurrent-tree-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "root-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "root" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendSessionTranscriptMessage({
          transcriptPath: sessionFile,
          message: { role: "assistant", content: `reply ${index}` },
        }),
      ),
    );

    const records = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { content?: string };
          },
      )
      .filter((record) => record.type === "message");

    expect(records).toHaveLength(9);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]?.parentId).toBe(records[index - 1]?.id);
    }
  });

  it("migrates small linear transcripts before appending", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "small-linear-session",
      fixture.sessionsDir(),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "small-linear-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-first",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "legacy first" },
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-second",
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: "legacy second" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "new reply" },
    });

    const records = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { content?: string };
          },
      );
    const messages = records.filter((record) => record.type === "message");

    expect(messages.map((record) => record.message?.content)).toEqual([
      "legacy first",
      "legacy second",
      "new reply",
    ]);
    expect(messages[0]).toMatchObject({ id: "legacy-first", parentId: null });
    expect(messages[1]).toMatchObject({ id: "legacy-second", parentId: "legacy-first" });
    expect(messages[2]).toMatchObject({
      id: appended.messageId,
      parentId: "legacy-second",
    });
  });
});
