// Codex tests cover mirrored session-history branch selection.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  captureCodexSettledTurnFinalizationContext,
  CodexSettledTurnContext,
} from "./settled-turn-context.js";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function writeSession(records: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "codex-session",
    timestamp: "2026-06-15T00:00:00.000Z",
    cwd: dir,
  };
  await fs.writeFile(
    sessionFile,
    [header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return sessionFile;
}

// Fixtures keep legacy string content on purpose: session ingest normalizes
// assistant strings into [{ type: "text" }] blocks, so expectations below
// assert the canonical block-array shape for assistant rows.
function messageEntry(params: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: "2026-06-15T00:00:00.000Z",
    message: {
      role: params.role,
      content: params.content,
      timestamp: 1,
    },
  };
}

function bashEntry(params: {
  id: string;
  parentId: string;
  output: string;
  excludeFromContext: boolean;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: "2026-06-15T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: `print ${params.output}`,
      output: params.output,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
      excludeFromContext: params.excludeFromContext,
    },
  };
}

function mirroredTarget(sessionFile: string) {
  return {
    sessionFile,
    sessionId: "codex-session",
    sessionKey: "codex-session",
  };
}

async function writeSqliteSession(params: { storedSessionFile?: string } = {}): Promise<{
  marker: string;
  sessionKey: string;
  sessionTarget: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-sqlite-"));
  tempDirs.push(dir);
  const storePath = path.join(dir, "openclaw-agent.sqlite");
  const sessionId = "codex-sqlite-session";
  const sessionKey = "agent:main:codex-sqlite";
  const marker = `sqlite:main:${sessionId}:${storePath}`;
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  await upsertSessionEntry({
    ...scope,
    entry: {
      sessionFile: params.storedSessionFile ?? marker,
      sessionId,
      updatedAt: 1,
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: { role: "user", content: "sqlite prompt", timestamp: 1 },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: { role: "assistant", content: "sqlite answer", timestamp: 2 },
  });
  return { marker, sessionKey, sessionTarget: scope };
}

describe("readCodexMirroredSessionHistoryMessages", () => {
  it.each([false, true])(
    "projects persisted native evidence without reading beyond the budget (oversized=%s)",
    async (oversized) => {
      const { marker, sessionTarget } = await writeSqliteSession();
      for (let index = 0; index < (oversized ? 201 : 0); index += 1) {
        await appendSessionTranscriptMessageByIdentity({
          ...sessionTarget,
          message: { role: "user", content: `prior-${index}`, timestamp: index + 3 },
        });
      }
      const unreadMarker = "synthetic-unread-settled-payload:";
      if (oversized) {
        await appendSessionTranscriptMessageByIdentity({
          ...sessionTarget,
          message: {
            role: "user",
            content: unreadMarker + "x".repeat(1024 * 1024),
            timestamp: 205,
          },
        });
      }
      const upstreamPrompt = "Native context\nSend the synthetic update.";
      const settledMessages = [
        attachUpstreamUserText(
          attachCodexMirrorIdentity(
            { role: "user", content: "Send the synthetic update.", timestamp: 206 },
            "settled:prompt",
          ),
          upstreamPrompt,
        ),
        attachCodexMirrorIdentity(
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "sent", name: "message", arguments: {} }],
            timestamp: 207,
          } as AgentMessage,
          "settled:tool:sent:call",
        ),
        attachCodexMirrorIdentity(
          {
            role: "toolResult",
            toolCallId: "sent",
            toolName: "message",
            isError: false,
            content: [{ type: "text", text: "Synthetic update sent." }],
            timestamp: 208,
          },
          "settled:tool:sent:result",
        ),
      ];
      for (const message of settledMessages) {
        await appendSessionTranscriptMessageByIdentity({ ...sessionTarget, message });
      }
      const originalParse = JSON.parse;
      let laterPayloadReads = 0;
      const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(unreadMarker)) {
          laterPayloadReads += 1;
        }
        return originalParse(text, reviver);
      });
      try {
        const captured = await captureCodexSettledTurnFinalizationContext({
          ...sessionTarget,
          sessionTarget,
          sessionFile: marker,
          model: "gpt-5.6-luna",
          settledMessages,
          mirroredMessages: settledMessages,
          turnId: "settled",
        });
        if (oversized) {
          expect(captured).toBeUndefined();
        } else {
          expect(captured).toBeInstanceOf(CodexSettledTurnContext);
          expect(captured?.data).toContainEqual({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: upstreamPrompt }],
          });
          expect(Object.isFrozen(captured?.data)).toBe(true);
          expect(captured?.data.at(-1)).toMatchObject({
            type: "function_call_output",
            call_id: "sent",
            output: "Synthetic update sent.",
          });
        }
        expect(laterPayloadReads).toBe(0);
      } finally {
        parse.mockRestore();
      }
    },
  );

  it("preserves native prompt evidence across explicit model-only reads", async () => {
    const { marker, sessionTarget } = await writeSqliteSession();
    const upstreamUserText = "synthetic-native-prompt:" + "x".repeat(1024 * 1024);
    const message = {
      role: "user" as const,
      content: "native visible",
      timestamp: 3,
      __openclaw: {
        upstreamUserText,
        mirrorIdentity: "synthetic-native-turn",
        mirrorOrigin: "codex",
        turnTainted: true,
      },
    };
    await appendSessionTranscriptMessageByIdentity({ ...sessionTarget, message });
    const target = { ...sessionTarget, sessionTarget, sessionFile: marker };
    const hash = (text: string | undefined) =>
      createHash("sha256")
        .update(text ?? "")
        .digest("hex");
    const before = (await readCodexMirroredSessionHistoryMessages(target))!.at(-1)!;
    expect(hash(readUpstreamUserText(before))).toBe(hash(upstreamUserText));
    const model = (await readCodexMirroredSessionHistoryMessages(
      target,
      undefined,
      "model-context",
    ))!.at(-1)!;
    expect(readUpstreamUserText(model)).toBeUndefined();
    expect(readMirrorIdentity(model)).toBe("synthetic-native-turn");
    expect(model).toMatchObject({
      content: "native visible",
      timestamp: 3,
      __openclaw: { mirrorOrigin: "codex", turnTainted: true },
    });
    const after = (await readCodexMirroredSessionHistoryMessages(target))!.at(-1)!;
    expect(hash(readUpstreamUserText(after))).toBe(hash(upstreamUserText));
    expect(readMirrorIdentity(after)).toBe("synthetic-native-turn");
  });
  it("treats a missing mirrored session file as empty history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toEqual([]);
  });

  it("does not create a database for a missing explicit SQLite session key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-missing-"));
    tempDirs.push(dir);
    const sessionId = "missing-codex-session";
    const storePath = path.join(dir, "openclaw-agent.sqlite");

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: `sqlite:main:${sessionId}:${storePath}`,
        sessionId,
        sessionKey: "agent:main:missing-codex",
      }),
    ).resolves.toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("returns [] for transcripts that do not open with a Codex session marker", async () => {
    // A non-Codex-shaped transcript (e.g. a non-Codex model run reusing this
    // hook) is an empty mirror, not a read failure, so callers must not warn.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({ type: "message", id: "orphan" }) + "\n");

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toEqual([]);
  });

  it("returns undefined for a session header without a string id", async () => {
    // A `session` header with corrupt metadata is a Codex transcript gone bad,
    // not a foreign transcript — it must stay on the warn path.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-session-history-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({ type: "session", id: 42 }) + "\n");

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toBeUndefined();
  });

  it("rejects a legacy transcript whose session header belongs to another session", async () => {
    const sessionFile = await writeSession([
      messageEntry({
        id: "foreign",
        parentId: null,
        role: "assistant",
        content: "foreign answer",
      }),
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages({
        sessionFile,
        sessionId: "another-session",
      }),
    ).resolves.toEqual([]);
  });

  it("replays SQLite marker history by session identity", async () => {
    const { marker, sessionKey } = await writeSqliteSession();

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
        sessionKey,
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("replays SQLite history from the canonical typed session target", async () => {
    const { sessionKey, sessionTarget } = await writeSqliteSession({
      storedSessionFile: "agent:main:codex-sqlite",
    });

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: sessionKey,
        sessionId: "codex-sqlite-session",
        sessionKey,
        sessionTarget,
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it.each([
    ["agent id", { agentId: "other" }],
    ["session id", { sessionId: "another-session" }],
    ["session key", { sessionKey: "agent:main:another-session" }],
  ])("fails closed when the typed target has a mismatched %s", async (_label, targetPatch) => {
    const { marker, sessionKey, sessionTarget } = await writeSqliteSession();

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
        sessionKey,
        sessionTarget: { ...sessionTarget, ...targetPatch },
      }),
    ).resolves.toEqual([]);
  });

  it("fails closed when the typed session target is incomplete", async () => {
    const { sessionKey, sessionTarget } = await writeSqliteSession();

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: sessionKey,
        sessionId: "codex-sqlite-session",
        sessionKey,
        sessionTarget: { ...sessionTarget, storePath: undefined },
      }),
    ).resolves.toEqual([]);
  });

  it("resolves SQLite marker history when the caller has no session key", async () => {
    const { marker } = await writeSqliteSession();

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("falls back from an unregistered requested key to the marker's verified session key", async () => {
    const { marker } = await writeSqliteSession();
    const staleSessionKey = "agent:main:stale-codex-session";

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
        sessionKey: staleSessionKey,
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("resolves synthesized SQLite markers for stale file-backed session metadata", async () => {
    const { marker } = await writeSqliteSession({
      storedSessionFile: "/tmp/legacy-session.jsonl",
    });

    await expect(
      readCodexMirroredSessionHistoryMessages({
        agentId: "main",
        sessionFile: marker,
        sessionId: "codex-sqlite-session",
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("applies the admission fence when session metadata still points to a legacy file", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "prior", parentId: null, role: "user", content: "legacy prior prompt" }),
      messageEntry({
        id: "current",
        parentId: "prior",
        role: "user",
        content: "legacy current prompt",
      }),
    ]);
    const { sessionKey, sessionTarget } = await writeSqliteSession({
      storedSessionFile: sessionFile,
    });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...sessionTarget,
      message: { role: "user", content: "sqlite current prompt", timestamp: 3 },
    });
    if (!admitted?.anchor) {
      throw new Error("expected current-turn admission anchor");
    }

    await expect(
      readCodexMirroredSessionHistoryMessages(
        {
          agentId: sessionTarget.agentId,
          sessionFile,
          sessionId: sessionTarget.sessionId,
          sessionKey,
        },
        {
          ...admitted.anchor,
          logicalTurnId: "codex-legacy-file-turn",
          role: "user",
        },
      ),
    ).resolves.toMatchObject([
      { role: "user", content: "sqlite prompt" },
      { role: "assistant", content: "sqlite answer" },
    ]);
  });

  it("replays only the branch selected by a leaf control", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "root", parentId: null, role: "user", content: "root prompt" }),
      messageEntry({
        id: "active",
        parentId: "root",
        role: "assistant",
        content: "active answer",
      }),
      messageEntry({
        id: "inactive",
        parentId: "root",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "active",
      },
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "root prompt" },
      { role: "assistant", content: [{ type: "text", text: "active answer" }] },
    ]);
  });

  it("projects private shell rows out of mirrored history without rewriting persisted bytes", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "root", parentId: null, role: "user", content: "root prompt" }),
      bashEntry({
        id: "private-shell",
        parentId: "root",
        output: "private shell output",
        excludeFromContext: true,
      }),
      bashEntry({
        id: "visible-shell",
        parentId: "private-shell",
        output: "visible shell output",
        excludeFromContext: false,
      }),
      messageEntry({
        id: "continued",
        parentId: "visible-shell",
        role: "user",
        content: "continue prompt",
      }),
    ]);
    const persistedBefore = await fs.readFile(sessionFile, "utf8");

    const messages = await readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile));

    expect(messages).toMatchObject([
      { role: "user", content: "root prompt" },
      { role: "bashExecution", output: "visible shell output" },
      { role: "user", content: "continue prompt" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("private shell output");
    expect(await fs.readFile(sessionFile, "utf8")).toBe(persistedBefore);
    expect(persistedBefore).toContain("private shell output");
  });

  it("honors explicit navigation to an empty branch", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "old", parentId: null, role: "user", content: "old prompt" }),
      {
        type: "leaf",
        id: "empty-leaf",
        parentId: "old",
        targetId: null,
        appendParentId: "old",
      },
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toEqual([]);
  });

  it("keeps visible history when continuation rows use a disjoint append cursor", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "visible", parentId: null, role: "user", content: "visible prompt" }),
      messageEntry({
        id: "inactive",
        parentId: "visible",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "metadata",
        id: "append-metadata",
        parentId: "inactive",
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
        appendParentId: "append-metadata",
      },
      messageEntry({
        id: "continued",
        parentId: "append-metadata",
        role: "assistant",
        content: "continued answer",
      }),
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "visible prompt" },
      { role: "assistant", content: [{ type: "text", text: "continued answer" }] },
    ]);
  });

  it("keeps visible history when a continuation references the leaf marker", async () => {
    const sessionFile = await writeSession([
      messageEntry({ id: "visible", parentId: null, role: "user", content: "visible prompt" }),
      messageEntry({
        id: "inactive",
        parentId: "visible",
        role: "assistant",
        content: "inactive answer",
      }),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive",
        targetId: "visible",
      },
      messageEntry({
        id: "continued",
        parentId: "active-leaf",
        role: "assistant",
        content: "continued answer",
      }),
    ]);

    await expect(
      readCodexMirroredSessionHistoryMessages(mirroredTarget(sessionFile)),
    ).resolves.toMatchObject([
      { role: "user", content: "visible prompt" },
      { role: "assistant", content: [{ type: "text", text: "continued answer" }] },
    ]);
  });
});
