import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { flushSessionManagerTranscript } from "./attempt-transcript-helpers.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-transcript-"));
  tempPaths.push(dir);
  return dir;
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("embedded attempt transcript persistence", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("resumes a raw cursor after append-only attempt settlement", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "embedded-generation",
      sessionKey: "agent:main:embedded-generation",
      storePath,
    };
    const marker = formatSqliteSessionFileMarker(target);
    await upsertSessionEntry(target, {
      sessionFile: marker,
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(target, {
      cwd: dir,
      eventId: "first-user",
      message: { role: "user", content: "first turn" },
      now: 1,
    });

    const bootstrap = await readSessionTranscriptRawDelta({
      ...target,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    expect(bootstrap.kind).toBe("page");
    if (bootstrap.kind !== "page") {
      throw new Error(`expected bootstrap page, got ${bootstrap.kind}`);
    }

    const sessionManager = SessionManager.open(marker, dir, dir);
    sessionManager.appendMessage({
      role: "user",
      content: "second turn",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage(buildAssistantMessage("second answer"));

    // Production settlement invokes this barrier immediately before afterTurn.
    flushSessionManagerTranscript(sessionManager);

    const resumed = await readSessionTranscriptRawDelta({
      ...target,
      cursor: bootstrap.cursor,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    expect(resumed.kind).toBe("page");
    if (resumed.kind !== "page") {
      throw new Error(`expected append page, got ${resumed.kind}`);
    }
    expect(
      resumed.events
        .map((row) => row.event)
        .filter((event): event is { message: { content: unknown }; type: "message" } =>
          Boolean(
            event && typeof event === "object" && "type" in event && event.type === "message",
          ),
        )
        .map((event) => event.message.content),
    ).toEqual(["second turn", [{ type: "text", text: "second answer" }]]);
  });
});
