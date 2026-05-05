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
import { attachCodexMirrorIdentity, mirrorCodexAppServerTranscript } from "./transcript-mirror.js";

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;

// Mirrors transcript-mirror.ts's fallback fingerprint exactly so test
// expectations stay in sync without exposing the helper publicly.
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
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userMessage, assistantMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"user"');
    expect(raw).toContain('"content":[{"type":"text","text":"hello"}]');
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"hi there"}]');
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
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
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"content":[{"type":"text","text":"hello [hooked]"}]');
    // The idempotency fingerprint is derived from the pre-hook message so a
    // hook rewrite cannot bypass dedupe by reshaping content on every retry.
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
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
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
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

  // Helpers for the identity-based regression tests below.
  //
  // The mirror dedupe key is now `${idempotencyScope}:${identity}`, where
  // `identity` is either an explicit `attachCodexMirrorIdentity` tag (the
  // production path; event-projector emits `${turnId}:${kind}`) or the
  // role/content fingerprint fallback (legacy callers).
  type FileMessage = {
    type?: string;
    message?: { role?: string; content?: Array<{ text?: string }> };
  };
  function readFileMessages(raw: string): Array<{ role?: string; text?: string }> {
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FileMessage)
      .filter((record) => record.type === "message")
      .map((record) => ({
        role: record.message?.role,
        text: record.message?.content?.[0]?.text,
      }));
  }

  // Regression for #77012 (within-turn snapshot reordering). When mirror is
  // invoked twice under the same scope/turn but the second snapshot inserts
  // a reasoning record between the user prompt and the assistant reply,
  // every assistant-role record after the inserted slot shifts. With the
  // previous `:role:index` key, the second call's reasoning record collided
  // with the first call's assistant key (both `:assistant:1`) — the
  // legitimately-new reasoning entry was silently dropped, and the
  // assistant content was re-appended under `:assistant:2`, producing a
  // duplicate assistant entry. The identity-based key (event-projector
  // tags `${turnId}:reasoning` and `${turnId}:assistant`) makes each kind
  // its own dedupe slot.
  it("dedupes mirrored messages despite snapshot positional shifts", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });
    const reasoningMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "[Codex reasoning] thinking" }],
        timestamp: Date.now() + 2,
      }),
      "turn-1:reasoning",
    );
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userMessage, reasoningMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });

    const messageTexts = readFileMessages(await fs.readFile(sessionFile, "utf8")).map(
      (m) => m.text,
    );
    expect(messageTexts).toEqual(["hello", "hi there", "[Codex reasoning] thinking"]);
  });

  // Two distinct turns where the user types the same thing must not collapse:
  // each entry carries its own `${turnId}:${kind}` identity so the dedupe
  // key differs even when role+content match. (Prior content-fingerprint-only
  // designs would have collapsed the second user turn here.)
  it("keeps repeated same-content turns distinct", async () => {
    const sessionFile = await createTempSessionFile();
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "yes" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );
    const assistantTurn1 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "ok 1" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );
    const userTurn2 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "yes" }],
        timestamp: Date.now() + 2,
      }),
      "turn-2:prompt",
    );
    const assistantTurn2 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "ok 2" }],
        timestamp: Date.now() + 3,
      }),
      "turn-2:assistant",
    );

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(readFileMessages(await fs.readFile(sessionFile, "utf8"))).toEqual([
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 1" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 2" },
    ]);
  });

  // Cross-turn re-emit: an entry first written under turn 1 may be re-emitted
  // as part of a later turn's snapshot (e.g. a context-engine flow that
  // bundles prior history). Because every entry carries its own original
  // `${turnId}:${kind}` identity, the re-emitted entries collide with their
  // existing on-disk keys and become true no-ops — instead of being
  // appended again on a sibling branch (the on-disk symptom in #77012).
  it("dedupes prior-turn entries re-emitted into a later turn's snapshot", async () => {
    const sessionFile = await createTempSessionFile();
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "msg1" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );
    const assistantTurn1 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "reply1" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });

    const userTurn2 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "msg2" }],
        timestamp: Date.now() + 2,
      }),
      "turn-2:prompt",
    );
    const assistantTurn2 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "reply2" }],
        timestamp: Date.now() + 3,
      }),
      "turn-2:assistant",
    );
    // Buggy upstream: snapshot for turn 2 also includes the just-completed
    // turn 1's entries (with their original identities preserved).
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userTurn1, assistantTurn1, userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(readFileMessages(await fs.readFile(sessionFile, "utf8"))).toEqual([
      { role: "user", text: "msg1" },
      { role: "assistant", text: "reply1" },
      { role: "user", text: "msg2" },
      { role: "assistant", text: "reply2" },
    ]);
  });

  // Backward-compat: callers that do not tag messages with a mirror identity
  // (e.g. third-party harnesses or tests routed through the legacy path)
  // still get the role/content fingerprint key. Distinct turns are then
  // distinguished by the caller's idempotency scope.
  it("falls back to the role+content fingerprint when no identity is attached", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [userMessage, assistantMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
  });
});
