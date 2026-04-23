import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../../../src/agents/test-helpers/agent-message-fixtures.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../../src/plugins/hooks.test-helpers.js";
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
});
