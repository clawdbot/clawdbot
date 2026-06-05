// Copilot tests cover dual write transcripts plugin behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
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
import {
  attachCopilotMirrorIdentity,
  dualWriteCopilotTranscriptBestEffort,
  mirrorCopilotTranscript,
} from "./dual-write-transcripts.js";

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

function expectedFingerprint(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

const tempDirs: string[] = [];

afterEach(async () => {
  resetGlobalHookRunner();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-mirror-"));
  tempDirs.push(dir);
  return path.join(dir, "session.jsonl");
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function parseJsonLines<T>(raw: string): T[] {
  const records: T[] = [];
  for (const line of raw.trim().split("\n")) {
    if (line.length > 0) {
      records.push(JSON.parse(line) as T);
    }
  }
  return records;
}

describe("mirrorCopilotTranscript", () => {
  it("mirrors user, assistant, and tool result messages into the OpenClaw transcript", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });
    const toolResultMessage = castAgentMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [
        {
          type: "toolResult",
          toolCallId: "call-1",
          content: "read output",
        },
      ],
      timestamp: Date.now() + 2,
    }) as MirroredAgentMessage;

    await mirrorCopilotTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userMessage, assistantMessage, toolResultMessage],
      idempotencyScope: "copilot:session-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"user"');
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"role":"toolResult"');
    expect(raw).toContain('"toolCallId":"call-1"');
    expect(raw).toContain(
      `"idempotencyKey":"copilot:session-1:user:${expectedFingerprint(userMessage)}"`,
    );
    expect(raw).toContain(
      `"idempotencyKey":"copilot:session-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
    expect(raw).toContain(
      `"idempotencyKey":"copilot:session-1:toolResult:${expectedFingerprint(toolResultMessage)}"`,
    );
  });

  it("creates the transcript directory on first mirror", async () => {
    const root = await makeRoot("openclaw-copilot-mirror-missing-dir-");
    const sessionFile = path.join(root, "nested", "sessions", "session.jsonl");

    await mirrorCopilotTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "first mirror" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "copilot:session-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"first mirror"}]');
  });

  it("deduplicates re-emits by idempotency scope", async () => {
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

    await mirrorCopilotTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [...messages],
      idempotencyScope: "copilot:session-1",
    });
    await mirrorCopilotTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [...messages],
      idempotencyScope: "copilot:session-1",
    });

    const records = parseJsonLines<{ type?: string; message?: { role?: string } }>(
      await fs.readFile(sessionFile, "utf8"),
    );
    // First "header" record may or may not appear depending on migration.
    // What matters is that the second mirror call adds zero new messages.
    const messageRecords = records.filter((r) => r.message?.role !== undefined);
    expect(messageRecords).toHaveLength(2);
  });

  it("runs before_message_write before appending mirrored messages", async () => {
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
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCopilotTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [sourceMessage],
      idempotencyScope: "copilot:session-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"content":[{"type":"text","text":"hello [hooked]"}]');
    expect(raw).toContain(
      `"idempotencyKey":"copilot:session-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
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

    await mirrorCopilotTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "should not persist" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "copilot:session-1",
    });

    await expect(fs.readFile(sessionFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("is a no-op when no mirrorable messages are present", async () => {
    const sessionFile = await createTempSessionFile();

    await mirrorCopilotTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [],
      idempotencyScope: "copilot:session-1",
    });

    await expect(fs.readFile(sessionFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("uses content fingerprint when no explicit mirror identity is attached", async () => {
    const sessionFile = await createTempSessionFile();
    const message = makeAgentAssistantMessage({
      content: [{ type: "text", text: "fp" }],
      timestamp: Date.now(),
    });

    await mirrorCopilotTranscript({
      sessionFile,
      messages: [message],
      idempotencyScope: "scope-fp",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain(`"idempotencyKey":"scope-fp:assistant:${expectedFingerprint(message)}"`);
  });

  it("uses attached identity instead of content fingerprint when provided", async () => {
    const sessionFile = await createTempSessionFile();
    const baseMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "explicit" }],
      timestamp: Date.now(),
    });
    const tagged = attachCopilotMirrorIdentity(baseMessage, "sdk-session-1:assistant:0");

    await mirrorCopilotTranscript({
      sessionFile,
      messages: [tagged],
      idempotencyScope: "copilot:openclaw-session-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain(
      '"idempotencyKey":"copilot:openclaw-session-1:sdk-session-1:assistant:0"',
    );
    expect(raw).not.toContain(expectedFingerprint(baseMessage));
  });

  it("omits idempotencyKey when no idempotencyScope is provided", async () => {
    const sessionFile = await createTempSessionFile();

    await mirrorCopilotTranscript({
      sessionFile,
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "no scope" }],
          timestamp: Date.now(),
        }),
      ],
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"content":[{"type":"text","text":"no scope"}]');
    expect(raw).not.toContain("idempotencyKey");
  });

  it("filters out non-mirrorable roles", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "u" }],
      timestamp: Date.now(),
    });
    const systemLike = castAgentMessage({
      role: "system" as never,
      content: [{ type: "text", text: "system note" }],
      timestamp: Date.now() + 1,
    });

    await mirrorCopilotTranscript({
      sessionFile,
      messages: [userMessage, systemLike],
      idempotencyScope: "scope",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"user"');
    expect(raw).not.toContain("system note");
  });

  it("preserves explicit identity across attachCopilotMirrorIdentity overrides", async () => {
    const sessionFile = await createTempSessionFile();
    const base = makeAgentAssistantMessage({
      content: [{ type: "text", text: "x" }],
      timestamp: Date.now(),
    });
    const first = attachCopilotMirrorIdentity(base, "id-1");
    const second = attachCopilotMirrorIdentity(first, "id-2");

    await mirrorCopilotTranscript({
      sessionFile,
      messages: [second],
      idempotencyScope: "scope",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"idempotencyKey":"scope:id-2"');
    expect(raw).not.toContain('"idempotencyKey":"scope:id-1"');
  });
});

describe("dualWriteCopilotTranscriptBestEffort", () => {
  it("returns normally when mirror succeeds", async () => {
    const sessionFile = await createTempSessionFile();
    await expect(
      dualWriteCopilotTranscriptBestEffort({
        sessionFile,
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "ok" }],
            timestamp: Date.now(),
          }),
        ],
        idempotencyScope: "scope",
      }),
    ).resolves.toBeUndefined();
    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"assistant"');
  });

  it("swallows infrastructure failures and never rejects", async () => {
    // Pointing sessionFile at a path under a non-existent root with an
    // empty-string segment can fail differently on different platforms;
    // instead force failure by passing an invalid type and asserting
    // that the wrapper itself does not reject. Use any-cast for the
    // bad input shape since we are testing the wrapper's catch.
    await expect(
      dualWriteCopilotTranscriptBestEffort({
        sessionFile: "" as unknown as string,
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "should-not-throw" }],
            timestamp: Date.now(),
          }),
        ],
        idempotencyScope: "scope",
      }),
    ).resolves.toBeUndefined();
  });
});
