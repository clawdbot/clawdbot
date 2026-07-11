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
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
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

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function readEventMessages(events: unknown[]): Array<{ role?: string; text?: string }> {
  return events
    .map((event) =>
      event && typeof event === "object" ? (event as { message?: unknown }).message : undefined,
    )
    .filter((message): message is { role?: string; content?: unknown } =>
      Boolean(message && typeof message === "object"),
    )
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.find((part): part is { text: string } =>
            Boolean(part && typeof part === "object" && typeof part.text === "string"),
          )?.text
        : typeof message.content === "string"
          ? message.content
          : undefined;
      return { role: message.role, text: content };
    });
}

async function createSqliteMirrorTarget(prefix: string, options: { sessionId?: string } = {}) {
  const root = await makeRoot(prefix);
  const agentId = "main";
  const sessionId = options.sessionId ?? "session-1";
  const sessionKey = `agent:${agentId}:${sessionId}`;
  const storePath = path.join(root, "openclaw-agent.sqlite");
  await upsertSessionEntry({
    agentId,
    sessionKey,
    storePath,
    entry: {
      sessionFile: `sqlite:${agentId}:${sessionId}:${storePath}`,
      sessionId,
      updatedAt: 1,
    },
  });
  return {
    agentId,
    sessionId,
    sessionKey,
    storePath,
    bogusSessionFile: path.join(root, "should-not-be-created.jsonl"),
  };
}

async function readMirrorEvents(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  return await readSessionTranscriptEvents(target);
}

async function readMirrorRaw(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<string> {
  return (await readMirrorEvents(target)).map((event) => JSON.stringify(event)).join("\n");
}

async function readMirrorMessages(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<{ role?: string; text?: string }>> {
  return readEventMessages(await readMirrorEvents(target));
}

describe("mirrorCopilotTranscript", () => {
  it("mirrors user, assistant, and tool result messages by SQLite identity", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-basic-");
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
      content: [{ type: "toolResult", toolCallId: "call-1", content: "read output" }],
      timestamp: Date.now() + 2,
    }) as MirroredAgentMessage;

    await mirrorCopilotTranscript({
      ...target,
      messages: [userMessage, assistantMessage, toolResultMessage],
      idempotencyScope: "copilot:session-1",
    });

    const raw = await readMirrorRaw(target);
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
    await expect(fs.readFile(target.bogusSessionFile, "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("preserves gateway user-turn identity across Copilot transcript mirroring", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-user-identity-");
    const userMessage = castAgentMessage({
      ...makeAgentUserMessage({
        content: [{ type: "text", text: "client prompt" }],
        timestamp: Date.now(),
      }),
      idempotencyKey: "client-run:user",
    });

    await mirrorCopilotTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "copilot:session-1",
    });
    await mirrorCopilotTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "copilot:session-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"idempotencyKey":"client-run:user"');
    expect(raw).not.toContain('"idempotencyKey":"copilot:session-1:user:');
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("rejects mirror writes without a runtime session identity", async () => {
    await expect(
      mirrorCopilotTranscript({
        sessionId: "session-1",
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "no identity" }],
            timestamp: Date.now(),
          }),
        ],
      }),
    ).rejects.toThrow("runtime session identity");
  });

  it("deduplicates re-emits by idempotency scope", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-dedupe-");
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
      ...target,
      messages: [...messages],
      idempotencyScope: "copilot:session-1",
    });
    await mirrorCopilotTranscript({
      ...target,
      messages: [...messages],
      idempotencyScope: "copilot:session-1",
    });

    expect((await readMirrorMessages(target)).filter((message) => message.role)).toHaveLength(2);
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
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-hook-");
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCopilotTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "copilot:session-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"content":[{"type":"text","text":"hello [hooked]"}]');
    expect(raw).toContain(
      `"idempotencyKey":"copilot:session-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
  });

  it("respects before_message_write blocking decisions", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_message_write", handler: () => ({ block: true }) },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-block-");

    await mirrorCopilotTranscript({
      ...target,
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "should not persist" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "copilot:session-1",
    });

    expect(await readMirrorMessages(target)).toEqual([]);
  });

  it("is a no-op when no mirrorable messages are present", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-empty-");

    await mirrorCopilotTranscript({
      ...target,
      messages: [],
      idempotencyScope: "copilot:session-1",
    });

    expect(await readMirrorMessages(target)).toEqual([]);
  });

  it("uses content fingerprint when no explicit mirror identity is attached", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-fingerprint-");
    const message = makeAgentAssistantMessage({
      content: [{ type: "text", text: "fp" }],
      timestamp: Date.now(),
    });

    await mirrorCopilotTranscript({
      ...target,
      messages: [message],
      idempotencyScope: "scope-fp",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain(`"idempotencyKey":"scope-fp:assistant:${expectedFingerprint(message)}"`);
  });

  it("uses attached identity instead of content fingerprint when provided", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-identity-");
    const baseMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "explicit" }],
      timestamp: Date.now(),
    });
    const tagged = attachCopilotMirrorIdentity(baseMessage, "sdk-session-1:assistant:0");

    await mirrorCopilotTranscript({
      ...target,
      messages: [tagged],
      idempotencyScope: "copilot:openclaw-session-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain(
      '"idempotencyKey":"copilot:openclaw-session-1:sdk-session-1:assistant:0"',
    );
    expect(raw).not.toContain(expectedFingerprint(baseMessage));
  });

  it("omits idempotencyKey when no idempotencyScope is provided", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-no-scope-");

    await mirrorCopilotTranscript({
      ...target,
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "no scope" }],
          timestamp: Date.now(),
        }),
      ],
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"content":[{"type":"text","text":"no scope"}]');
    expect(raw).not.toContain("idempotencyKey");
  });

  it("filters out non-mirrorable roles", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-filter-");
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
      ...target,
      messages: [userMessage, systemLike],
      idempotencyScope: "scope",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"role":"user"');
    expect(raw).not.toContain("system note");
  });

  it("preserves explicit identity across attachCopilotMirrorIdentity overrides", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-override-");
    const base = makeAgentAssistantMessage({
      content: [{ type: "text", text: "x" }],
      timestamp: Date.now(),
    });
    const first = attachCopilotMirrorIdentity(base, "id-1");
    const second = attachCopilotMirrorIdentity(first, "id-2");

    await mirrorCopilotTranscript({
      ...target,
      messages: [second],
      idempotencyScope: "scope",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"idempotencyKey":"scope:id-2"');
    expect(raw).not.toContain('"idempotencyKey":"scope:id-1"');
  });
});

describe("dualWriteCopilotTranscriptBestEffort", () => {
  it("returns normally when mirror succeeds", async () => {
    const target = await createSqliteMirrorTarget("openclaw-copilot-mirror-best-effort-");
    await expect(
      dualWriteCopilotTranscriptBestEffort({
        ...target,
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "ok" }],
            timestamp: Date.now(),
          }),
        ],
        idempotencyScope: "scope",
      }),
    ).resolves.toBeUndefined();
    expect(await readMirrorMessages(target)).toContainEqual({ role: "assistant", text: "ok" });
  });

  it("swallows missing runtime identity and does not write JSONL", async () => {
    const root = await makeRoot("openclaw-copilot-mirror-invalid-");
    const sessionFile = path.join(root, "agents", "main", "sessions", "session-1.jsonl");
    await expect(
      dualWriteCopilotTranscriptBestEffort({
        agentId: "main",
        sessionId: "session-1",
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "should-not-throw" }],
            timestamp: Date.now(),
          }),
        ],
        idempotencyScope: "scope",
      }),
    ).resolves.toBeUndefined();
    await expect(fs.access(sessionFile)).rejects.toHaveProperty("code", "ENOENT");
  });
});
