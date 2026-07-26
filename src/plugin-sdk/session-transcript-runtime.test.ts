import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  listSessionEntries,
  loadSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  publishSessionTranscriptUpdateByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptRawDelta,
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
  resolveSessionTranscriptIdentity,
  resolveSessionTranscriptTarget,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

describe("session transcript runtime SDK", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("resolves transcript identity and reads events without returning sessionFile", async () => {
    const scope = {
      agentId: "Main",
      sessionId: "session-with-colon",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-1", type: "metadata" };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendTranscriptEvent(scope, event);

    const identity = await resolveSessionTranscriptIdentity(scope);

    expect(identity).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:session-with-colon",
      sessionId: scope.sessionId,
      sessionKey: "agent:main:main",
    });
    expect(identity).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
  });

  it("does not persist sessionFile metadata for identity-only reads", async () => {
    const scope = {
      agentId: "main",
      sessionId: "read-only-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await expect(resolveSessionTranscriptIdentity(scope)).resolves.toMatchObject({
      memoryKey: "transcript:main:read-only-session",
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
    expect(loadSessionEntry(scope)?.sessionFile).toBeUndefined();
  });

  it("pages raw events across appends and resets after replacement", async () => {
    const scope = {
      agentId: "main",
      sessionId: "raw-delta-session",
      sessionKey: "agent:main:raw-delta",
      storePath,
    };
    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    for (const id of ["event-1", "event-2", "event-3"]) {
      await appendTranscriptEvent(scope, { id, type: "custom" });
    }

    const first = await readSessionTranscriptRawDelta({
      ...scope,
      maxBytes: 10_000,
      maxEvents: 2,
    });
    expect(first).toMatchObject({
      kind: "page",
      events: [
        { event: { id: "event-1", type: "custom" }, seq: 0 },
        { event: { id: "event-2", type: "custom" }, seq: 1 },
      ],
      hasMore: true,
    });
    if (first.kind !== "page") {
      throw new Error("expected the first raw transcript page");
    }

    await appendTranscriptEvent(scope, { id: "event-4", type: "custom" });
    const second = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: first.cursor,
      maxBytes: 10_000,
      maxEvents: 2,
    });
    expect(second).toMatchObject({
      kind: "page",
      events: [
        { event: { id: "event-3", type: "custom" }, seq: 2 },
        { event: { id: "event-4", type: "custom" }, seq: 3 },
      ],
      hasMore: false,
    });

    await replaceTranscriptEvents(scope, [{ id: "replacement", type: "custom" }]);
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: first.cursor,
        maxBytes: 10_000,
        maxEvents: 2,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "generation_mismatch" });
  });

  it("bounds raw pages before parsing an oversized event", async () => {
    const missingScope = {
      agentId: "main",
      sessionId: "missing-raw-delta",
      sessionKey: "agent:main:missing-raw-delta",
      storePath,
    };
    await upsertSessionEntry(missingScope, { sessionId: missingScope.sessionId, updatedAt: 10 });
    await expect(
      readSessionTranscriptRawDelta({ ...missingScope, maxBytes: 10, maxEvents: 1 }),
    ).resolves.toEqual({ kind: "missing" });

    const scope = {
      ...missingScope,
      sessionId: "oversized-raw-delta",
      sessionKey: "agent:main:oversized-raw-delta",
    };
    await appendTranscriptEvent(scope, { id: "large", text: "x".repeat(200), type: "custom" });
    const blocked = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: "not-a-cursor",
      maxBytes: 10,
      maxEvents: 1,
    });
    expect(blocked).toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: "",
        maxBytes: 10,
        maxEvents: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    if (blocked.kind !== "reset") {
      throw new Error("expected invalid cursor reset");
    }
    const unsafeCursor = Buffer.from(
      JSON.stringify({
        agentId: scope.agentId,
        generation: "untrusted",
        lastSeq: 1e100,
        sessionId: scope.sessionId,
        version: 1,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: unsafeCursor,
        maxBytes: 10,
        maxEvents: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });

    const bounded = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: blocked.cursor,
      maxBytes: 10,
      maxEvents: 1,
    });
    expect(bounded).toMatchObject({
      kind: "page",
      events: [],
      hasMore: true,
      requiredBytes: expect.any(Number),
      serializedBytes: 0,
    });
    if (bounded.kind !== "page" || bounded.requiredBytes === undefined) {
      throw new Error("expected oversized event metadata");
    }

    const retried = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: bounded.cursor,
      maxBytes: bounded.requiredBytes,
      maxEvents: 1,
    });
    expect(retried).toMatchObject({
      kind: "page",
      events: [{ event: { id: "large", text: "x".repeat(200), type: "custom" }, seq: 0 }],
      hasMore: false,
      serializedBytes: bounded.requiredBytes,
    });

    const otherScope = {
      ...scope,
      sessionId: "other-raw-delta",
      sessionKey: "agent:main:other-raw-delta",
    };
    await appendTranscriptEvent(otherScope, { id: "other", type: "custom" });
    await expect(
      readSessionTranscriptRawDelta({
        ...otherScope,
        cursor: retried.kind === "page" ? retried.cursor : "",
        maxBytes: 1_000,
        maxEvents: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "scope_mismatch" });
  });

  it("projects only visible transcript message entries with read-order metadata", async () => {
    const scope = {
      agentId: "main",
      sessionId: "visible-projection-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const root = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "user",
        content: "root prompt",
        idempotencyKey: "root-user",
      },
      now: 1_000,
    });
    const inactive = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "assistant",
        content: "inactive answer",
        idempotencyKey: "inactive-assistant",
      },
      parentId: root?.messageId,
      now: 2_000,
    });
    const active = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "assistant",
        content: "active answer",
        idempotencyKey: "active-assistant",
      },
      parentId: root?.messageId,
      now: 3_000,
    });
    if (!root || !inactive || !active) {
      throw new Error("expected projected transcript setup messages");
    }
    await appendTranscriptEvent(scope, {
      type: "label",
      id: "label-1",
      parentId: active.messageId,
      value: "non-message metadata",
    });
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-active",
      parentId: inactive.messageId,
      targetId: active.messageId,
    });

    await expect(readVisibleSessionTranscriptMessageEntries(scope)).resolves.toEqual([
      {
        entryId: root.messageId,
        parentId: null,
        seq: 2,
        message: expect.objectContaining({
          role: "user",
          content: "root prompt",
          idempotencyKey: "root-user",
        }),
        role: "user",
        createdAt: "1970-01-01T00:00:01.000Z",
        idempotencyKey: "root-user",
      },
      {
        entryId: active.messageId,
        parentId: root.messageId,
        seq: 4,
        message: expect.objectContaining({
          role: "assistant",
          content: "active answer",
          idempotencyKey: "active-assistant",
        }),
        role: "assistant",
        createdAt: "1970-01-01T00:00:03.000Z",
        idempotencyKey: "active-assistant",
      },
    ]);
  });

  it("appends assistant mirrors through the guarded session facade", async () => {
    const scope = {
      agentId: "main",
      sessionId: "guarded-mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        deliveryMirror: { kind: "channel-final", sourceMessageId: "delivery-1" },
        idempotencyKey: "delivery-1",
        text: "visible assistant reply",
      }),
    ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        deliveryMirror: { kind: "channel-final", sourceMessageId: "delivery-2" },
        idempotencyKey: "delivery-2",
        text: "visible assistant reply",
      }),
    ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    await expect(readLatestAssistantTextByIdentity(scope)).resolves.toBeUndefined();
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(2);

    const unkeyedScope = {
      ...scope,
      sessionId: "unkeyed-mirror-session",
      sessionKey: "agent:main:unkeyed",
    };
    await upsertSessionEntry(unkeyedScope, {
      sessionId: unkeyedScope.sessionId,
      updatedAt: 20,
    });
    const firstUnkeyed = await appendAssistantMirrorMessageByIdentity({
      ...unkeyedScope,
      text: "unkeyed assistant reply",
    });
    const secondUnkeyed = await appendAssistantMirrorMessageByIdentity({
      ...unkeyedScope,
      text: "unkeyed assistant reply",
    });
    expect(firstUnkeyed).toMatchObject({ ok: true, messageId: expect.any(String) });
    expect(secondUnkeyed).toEqual(firstUnkeyed);
    const unkeyedAssistantMessages = (await readSessionTranscriptEvents(unkeyedScope)).filter(
      (event) => {
        const message = (event as { message?: { role?: unknown } }).message;
        return message?.role === "assistant";
      },
    );
    expect(unkeyedAssistantMessages).toHaveLength(1);

    await upsertSessionEntry(scope, { sessionId: "new-session", updatedAt: 20 });

    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        text: "stale assistant reply",
      }),
    ).resolves.toMatchObject({ ok: false, code: "session-rebound" });
  });

  it("dedupes unkeyed assistant mirrors against only the visible SQLite branch", async () => {
    const scope = {
      agentId: "main",
      sessionId: "visible-branch-mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const active = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "visible branch reply" }],
      },
    });
    const inactive = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "inactive mirror reply" }],
      },
    });
    if (!active || !inactive) {
      throw new Error("expected branch setup messages");
    }
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-active-branch",
      parentId: inactive.messageId,
      targetId: active.messageId,
    });

    const result = await appendAssistantMirrorMessageByIdentity({
      ...scope,
      text: "inactive mirror reply",
    });

    expect(result).toMatchObject({ ok: true, messageId: expect.any(String) });
    expect(result.ok ? result.messageId : undefined).not.toBe(inactive.messageId);
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(3);
  });

  it("does not dedupe unkeyed assistant mirrors across a later user turn", async () => {
    const scope = {
      agentId: "main",
      sessionId: "user-turn-mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const firstAssistant = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "repeatable answer" }],
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "next question" },
    });

    const result = await appendAssistantMirrorMessageByIdentity({
      ...scope,
      text: "repeatable answer",
    });

    expect(firstAssistant).toMatchObject({ messageId: expect.any(String) });
    expect(result).toMatchObject({ ok: true, messageId: expect.any(String) });
    expect(result.ok ? result.messageId : undefined).not.toBe(firstAssistant?.messageId);
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(2);
  });

  it("publishes assistant mirror updates only for newly appended notified rows", async () => {
    const scope = {
      agentId: "main",
      sessionId: "mirror-update-mode-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const internalUpdates: unknown[] = [];
    const offInternal = transcriptEvents.onInternalSessionTranscriptUpdate((update) => {
      internalUpdates.push(update);
    });

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    try {
      await expect(
        appendAssistantMirrorMessageByIdentity({
          ...scope,
          text: "quiet assistant reply",
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
      expect(internalUpdates).toEqual([]);

      const first = await appendAssistantMirrorMessageByIdentity({
        ...scope,
        idempotencyKey: "mirror-once",
        text: "notified assistant reply",
      });
      const second = await appendAssistantMirrorMessageByIdentity({
        ...scope,
        idempotencyKey: "mirror-once",
        text: "notified assistant reply",
      });

      expect(second).toEqual(first);
      expect(internalUpdates).toEqual([
        expect.objectContaining({
          messageId: first.ok ? first.messageId : undefined,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        }),
      ]);
    } finally {
      offInternal();
    }
  });

  it("reads SQLite events by scoped identity when a legacy locator is present", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "legacy-locator.jsonl"),
      sessionId: "locator-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-locator", type: "metadata" };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendTranscriptEvent(scope, event);

    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
    expect(fs.existsSync(scope.sessionFile)).toBe(false);
  });

  it("binds scoped reads to the SQLite transcript without exposing the legacy locator", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "active-session.jsonl"),
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-active", type: "metadata" };

    await upsertSessionEntry(scope, {
      sessionFile: path.join(tempDir, "store-default.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, event);

    const target = await resolveSessionTranscriptTarget(scope);

    expect(target).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:active-session",
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      targetKind: "runtime-session",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
    expect(fs.existsSync(scope.sessionFile)).toBe(false);
  });

  it("appends messages by the same explicit scoped transcript target", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "mirror-target.jsonl"),
      sessionId: "mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    };

    const appended = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message,
    });

    expect(appended).toBeDefined();
    expect(appended?.message).toMatchObject(message);
    await expect(readLatestAssistantTextByIdentity(scope)).resolves.toMatchObject({
      id: appended?.messageId,
      text: "hello",
      timestamp: 1,
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("publishes internal updates for SQLite transcript identity", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "publish-target.jsonl"),
      sessionId: "publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    const internalUpdates: unknown[] = [];
    const offInternal = transcriptEvents.onInternalSessionTranscriptUpdate((update) => {
      internalUpdates.push(update);
    });

    try {
      await publishSessionTranscriptUpdateByIdentity({
        ...scope,
        update: {
          agentId: "stale-agent",
          messageId: "message-from-direct-publish",
          sessionKey: "agent:stale:other",
        },
      });
    } finally {
      offInternal();
    }

    expect(emitSpy).toHaveBeenCalledWith({
      agentId: "main",
      messageId: "message-from-direct-publish",
      sessionId: "publish-session",
      sessionKey: "agent:main:main",
      target: {
        agentId: "main",
        sessionId: "publish-session",
        sessionKey: "agent:main:main",
      },
    });
    expect(internalUpdates).toEqual([
      {
        agentId: "main",
        messageId: "message-from-direct-publish",
        sessionId: "publish-session",
        sessionKey: "agent:main:main",
        target: {
          agentId: "main",
          sessionId: "publish-session",
          sessionKey: "agent:main:main",
        },
      },
    ]);
  });

  it("locks read and append helpers to one scoped transcript target", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "locked-target.jsonl"),
      sessionId: "locked-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    const target = await withSessionTranscriptWriteLock(scope, async (locked) => {
      expect(await locked.readEvents()).toEqual([]);
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "locked" }],
          timestamp: 1,
        },
      });
      return locked.target;
    });

    expect(target).toMatchObject({
      sessionId: "locked-session",
      targetKind: "runtime-session",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("serializes caller-checked idempotency inside scoped locked appends", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "caller-checked-lock-target.jsonl"),
      sessionId: "caller-checked-lock-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const steps: string[] = [];
    const appendIfMissing = async (label: string) =>
      await withSessionTranscriptWriteLock(scope, async (locked) => {
        steps.push(`${label}:read`);
        const events = await locked.readEvents();
        const alreadyAppended = events.some((event) => {
          const message = (event as { message?: { idempotencyKey?: unknown } }).message;
          return message?.idempotencyKey === "mirror-once";
        });
        if (label === "first") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        if (!alreadyAppended) {
          await locked.appendMessage({
            idempotencyLookup: "caller-checked",
            message: {
              role: "assistant",
              content: [{ type: "text", text: label }],
              idempotencyKey: "mirror-once",
              timestamp: 1,
            },
          });
        }
        steps.push(`${label}:done`);
      });

    const first = appendIfMissing("first");
    await Promise.resolve();
    const second = appendIfMissing("second");
    await Promise.all([first, second]);

    expect(steps).toEqual(["first:read", "first:done", "second:read", "second:done"]);
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(1);
  });

  it("publishes queued locked updates after callback appends are visible", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "queued-publish-target.jsonl"),
      sessionId: "queued-publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    let callbackCompleted = false;
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await withSessionTranscriptWriteLock(scope, async (locked) => {
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "queued publish" }],
          timestamp: 1,
        },
      });
      await locked.publishUpdate({
        messageId: "message-from-callback",
      });
      expect(emitSpy).not.toHaveBeenCalled();
      callbackCompleted = true;
      return "complete";
    });

    expect(result).toBe("complete");
    expect(callbackCompleted).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith({
      agentId: "main",
      messageId: "message-from-callback",
      sessionId: "queued-publish-session",
      sessionKey: "agent:main:main",
      target: {
        agentId: "main",
        sessionId: "queued-publish-session",
        sessionKey: "agent:main:main",
      },
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ role: "assistant" }),
      }),
    ]);
  });

  it("does not publish queued locked updates when the callback throws", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "failed-queued-publish-target.jsonl"),
      sessionId: "failed-queued-publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await expect(
      withSessionTranscriptWriteLock(scope, async (locked) => {
        await locked.appendMessage({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "durable but failed" }],
            timestamp: 1,
          },
        });
        await locked.publishUpdate({ sessionKey: scope.sessionKey });
        throw new Error("stop before commit");
      }),
    ).rejects.toThrow("stop before commit");
    expect(emitSpy).not.toHaveBeenCalled();
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ role: "assistant" }),
      }),
    ]);
  });

  it("round-trips encoded memory hit keys with opaque session ids", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "SECONDARY",
      sessionId: "my-plugin:task/1",
    });

    expect(key).toBe("transcript:secondary:my-plugin%3Atask%2F1");
    expect(parseSessionTranscriptMemoryHitKey(key)).toEqual({
      agentId: "secondary",
      key,
      sessionId: "my-plugin:task/1",
    });
  });

  it("resolves memory hit keys by agent and session id instead of transcript basename", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-id",
      sessionKey: "agent:main:telegram:direct:123",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionFile: path.join(tempDir, "legacy-file-name.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const keys = resolveSessionTranscriptMemoryHitKeyToSessionKeys({
      key: formatSessionTranscriptMemoryHitKey(scope),
      store: Object.fromEntries(
        listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
      ),
    });

    expect(keys).toEqual(["agent:main:telegram:direct:123"]);
  });

  it("can avoid synthetic fallback keys for strict live-store checks", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "main",
      sessionId: "deleted-session",
    });

    expect(resolveSessionTranscriptMemoryHitKeyToSessionKeys({ key, store: {} })).toEqual([
      "agent:main:deleted-session",
    ]);
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        includeSyntheticFallback: false,
        key,
        store: {},
      }),
    ).toEqual([]);
  });
});
