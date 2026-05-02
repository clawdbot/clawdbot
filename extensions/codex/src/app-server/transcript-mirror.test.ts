import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetGlobalHookRunner();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-transcript-"));
  tempDirs.push(dir);
  return path.join(dir, "session.jsonl");
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

describe("mirrorCodexAppServerTranscript", () => {
  it("mirrors user and assistant messages into the Pi transcript", async () => {
    const sessionFile = await createTempSessionFile();

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentUserMessage({
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
        }),
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "hi there" }],
          timestamp: Date.now() + 1,
        }),
      ],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"user"');
    expect(raw).toContain('"content":[{"type":"text","text":"hello"}]');
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"hi there"}]');
    expect(raw).toContain('"idempotencyKey":"scope-1:user:0"');
    expect(raw).toContain('"idempotencyKey":"scope-1:assistant:1"');
  });

  it("creates the transcript directory on first mirror", async () => {
    const root = await makeRoot("openclaw-codex-transcript-missing-dir-");
    const sessionFile = path.join(root, "nested", "sessions", "session.jsonl");

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "first mirror" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"first mirror"}]');
  });

  it("deduplicates app-server turn mirrors by idempotency scope", async () => {
    const sessionFile = await createTempSessionFile();
    const messages = [
      makeAgentUserMessage({
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      }),
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now() + 1,
      }),
    ] as const;

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [...messages],
      idempotencyScope: "scope-1",
    });
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [...messages],
      idempotencyScope: "scope-1",
    });

    const records = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } });
    expect(records.slice(1)).toHaveLength(2);
  });

  it("runs before_message_write before appending mirrored transcript messages", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              content: [{ type: "text", text: "hello [hooked]" }],
            }),
          }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"content":[{"type":"text","text":"hello [hooked]"}]');
    expect(raw).toContain('"idempotencyKey":"scope-1:assistant:0"');
  });

  it("preserves the computed idempotency key when hooks rewrite message keys", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              idempotencyKey: "hook-rewritten-key",
            }),
          }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"idempotencyKey":"scope-1:assistant:0"');
    expect(raw).not.toContain("hook-rewritten-key");
  });

  it("respects before_message_write blocking decisions", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({ block: true }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "should not persist" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "scope-1",
    });

    await expect(fs.readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates small linear transcripts before mirroring", async () => {
    const sessionFile = await createTempSessionFile();
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "linear-codex-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-user",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "legacy user" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "mirrored assistant" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "scope-1",
    });

    const records = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { role?: string };
          },
      )
      .filter((record) => record.type === "message");

    expect(records[0]).toMatchObject({ id: "legacy-user", parentId: null });
    expect(records[1]).toMatchObject({ parentId: "legacy-user" });
  });
});
