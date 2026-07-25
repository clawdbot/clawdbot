import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import {
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  replaceTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { ContextEngine, ContextEngineSessionTarget } from "../../context-engine/types.js";
import {
  bootstrapHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
} from "./context-engine-lifecycle.js";

function requireTranscriptTarget(params: {
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
}): SessionTranscriptTargetParams {
  const sessionId = params.sessionTarget?.sessionId ?? params.sessionId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey;
  if (!sessionKey) {
    throw new Error("context engine transcript reads require a session key");
  }
  return {
    sessionId,
    sessionKey,
    ...(params.sessionTarget?.agentId ? { agentId: params.sessionTarget.agentId } : {}),
    ...(params.sessionTarget?.storePath ? { storePath: params.sessionTarget.storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
}

function readMessageContent(message: AgentMessage): unknown {
  return "content" in message ? message.content : undefined;
}

describe("context engine transcript cursor contract", () => {
  it("bootstraps, resumes appends, and rebuilds after replacement through the public SDK", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-engine-cursor-"));
    const storePath = path.join(tempDir, "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "context-engine-cursor",
      sessionKey: "agent:main:context-engine-cursor",
      storePath,
    };
    const projectedMessages: AgentMessage[] = [];
    let cursor: string | undefined;
    let resetCount = 0;

    const consumeVisibleTranscript = async (params: {
      sessionId: string;
      sessionKey?: string;
      sessionTarget?: ContextEngineSessionTarget;
    }) => {
      const readTarget = requireTranscriptTarget(params);
      for (;;) {
        const result = await readSessionTranscriptVisibleMessageDelta({
          ...readTarget,
          ...(cursor ? { cursor } : {}),
          maxBytes: 10_000,
          maxMessages: 1,
        });
        if (result.kind === "missing" || result.kind === "unavailable") {
          return;
        }
        if (result.kind === "reset") {
          projectedMessages.length = 0;
          cursor = result.cursor;
          resetCount += 1;
          continue;
        }
        projectedMessages.push(...result.entries.map((entry) => entry.message));
        cursor = result.cursor;
        if (!result.hasMore) {
          return;
        }
      }
    };
    const engine: ContextEngine = {
      info: { id: "cursor-proof", name: "Cursor proof" },
      bootstrap: async (params) => {
        await consumeVisibleTranscript(params);
        return { bootstrapped: true, importedMessages: projectedMessages.length };
      },
      ingest: async () => ({ ingested: true }),
      assemble: async (params) => ({ messages: params.messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      afterTurn: consumeVisibleTranscript,
    };
    const skipMaintenance: NonNullable<
      Parameters<typeof bootstrapHarnessContextEngine>[0]["runMaintenance"]
    > = async () => undefined;

    try {
      await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 10 });
      const first = await appendTranscriptMessage(target, {
        message: { role: "user", content: "first" },
        now: 1_000,
      });
      await appendTranscriptMessage(target, {
        message: { role: "assistant", content: "second" },
        parentId: first?.messageId,
        now: 2_000,
      });

      await bootstrapHarnessContextEngine({
        hadSessionFile: true,
        contextEngine: engine,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: "sqlite://context-engine-cursor",
        runMaintenance: skipMaintenance,
        warn: () => {},
      });
      expect(projectedMessages.map(readMessageContent)).toEqual(["first", "second"]);

      await appendTranscriptMessage(target, {
        message: { role: "user", content: "third" },
        now: 3_000,
      });
      await finalizeHarnessContextEngineTurn({
        contextEngine: engine,
        promptError: false,
        aborted: false,
        yieldAborted: false,
        sessionIdUsed: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: "sqlite://context-engine-cursor",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        runMaintenance: skipMaintenance,
        warn: () => {},
      });
      expect(projectedMessages.map(readMessageContent)).toEqual(["first", "second", "third"]);

      await replaceTranscriptEvents(target, [
        {
          type: "message",
          id: "replacement",
          parentId: null,
          timestamp: "1970-01-01T00:00:04.000Z",
          message: { role: "user", content: "replacement" },
        },
      ]);
      await finalizeHarnessContextEngineTurn({
        contextEngine: engine,
        promptError: false,
        aborted: false,
        yieldAborted: false,
        sessionIdUsed: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: "sqlite://context-engine-cursor",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        runMaintenance: skipMaintenance,
        warn: () => {},
      });
      expect(resetCount).toBe(1);
      expect(projectedMessages.map(readMessageContent)).toEqual(["replacement"]);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
