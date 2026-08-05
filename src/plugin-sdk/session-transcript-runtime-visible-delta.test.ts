import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendTranscriptEvent, upsertSessionEntry } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptVisibleMessageDelta,
} from "./session-transcript-runtime.js";

describe("session transcript visible cursor SDK", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-visible-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("pages appends and resets when the active branch changes", async () => {
    const scope = {
      agentId: "main",
      sessionId: "visible-delta-session",
      sessionKey: "agent:main:visible-delta",
      storePath,
    };
    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const root = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "root" },
      now: 1_000,
    });
    const firstBranch = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "first branch" },
      parentId: root?.messageId,
      now: 2_000,
    });
    if (!root || !firstBranch) {
      throw new Error("expected visible delta setup messages");
    }

    const first = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      maxBytes: 10_000,
      maxMessages: 1,
    });
    expect(first).toMatchObject({
      kind: "page",
      entries: [
        {
          entryId: root.messageId,
          message: { role: "user", content: "root" },
          parentId: null,
        },
      ],
      hasMore: true,
    });
    if (first.kind !== "page") {
      throw new Error("expected first visible transcript page");
    }

    const second = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: first.cursor,
      maxBytes: 10_000,
      maxMessages: 1,
    });
    expect(second).toMatchObject({
      kind: "page",
      entries: [
        {
          entryId: firstBranch.messageId,
          message: { role: "assistant", content: "first branch" },
          parentId: root.messageId,
        },
      ],
      hasMore: false,
    });
    if (second.kind !== "page") {
      throw new Error("expected second visible transcript page");
    }
    const movedAnchorCursor = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(second.cursor, "base64url").toString("utf8")) as object),
        lastMessagePosition: 0,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: movedAnchorCursor,
        maxBytes: 10_000,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "anchor_moved" });

    const appended = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "linear append" },
      parentId: firstBranch.messageId,
      now: 3_000,
    });
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: second.cursor,
        maxBytes: 10_000,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [{ entryId: appended?.messageId, message: { content: "linear append" } }],
      hasMore: false,
    });

    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-replacement-branch",
      parentId: appended?.messageId,
      targetId: root.messageId,
    });
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: second.cursor,
        maxBytes: 10_000,
        maxMessages: 1,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "projection_rebuilding" });
    await waitForSessionTranscriptIndexReconcile(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      eventId: "replacement-branch",
      parentId: "select-replacement-branch",
      message: { role: "assistant", content: "replacement branch" },
      now: 4_000,
    });
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: second.cursor,
        maxBytes: 10_000,
        maxMessages: 1,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "projection_rebuilding" });
    await waitForSessionTranscriptIndexReconcile(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const reset = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: second.cursor,
      maxBytes: 10_000,
      maxMessages: 1,
    });
    expect(reset).toMatchObject({ kind: "reset", reason: "anchor_missing" });
    if (reset.kind !== "reset") {
      throw new Error("expected visible branch reset");
    }
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: reset.cursor,
        maxBytes: 10_000,
        maxMessages: 10,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [
        { entryId: root.messageId, parentId: null },
        { entryId: "replacement-branch", parentId: root.messageId },
      ],
      hasMore: false,
    });
  });

  it("bounds pages before parsing oversized entries", async () => {
    const scope = {
      agentId: "main",
      sessionId: "visible-delta-bounds",
      sessionKey: "agent:main:visible-delta-bounds",
      storePath,
    };
    const content = "x".repeat(200);
    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content },
      now: 1_000,
    });

    const invalid = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: "not-a-cursor",
      maxBytes: 10,
      maxMessages: 1,
    });
    expect(invalid).toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    if (invalid.kind !== "reset") {
      throw new Error("expected invalid visible cursor reset");
    }
    const inconsistentBootstrapCursor = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(invalid.cursor, "base64url").toString("utf8")) as object),
        lastMessagePosition: 0,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: inconsistentBootstrapCursor,
        maxBytes: 10,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    const bounded = await readSessionTranscriptVisibleMessageDelta({
      ...scope,
      cursor: invalid.cursor,
      maxBytes: 10,
      maxMessages: 1,
    });
    expect(bounded).toMatchObject({
      kind: "page",
      entries: [],
      hasMore: true,
      requiredBytes: expect.any(Number),
      serializedBytes: 0,
    });
    if (bounded.kind !== "page" || bounded.requiredBytes === undefined) {
      throw new Error("expected oversized visible entry metadata");
    }
    await expect(
      readSessionTranscriptVisibleMessageDelta({
        ...scope,
        cursor: bounded.cursor,
        maxBytes: bounded.requiredBytes,
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [{ message: { role: "user", content } }],
      hasMore: false,
      serializedBytes: bounded.requiredBytes,
    });
  });
});
