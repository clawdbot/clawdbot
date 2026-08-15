import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  readSessionMessageIdentity,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "./session-projection.js";

const sharedScope: SessionProjectionScope = {
  activeLeafEntryId: "shared-leaf",
  agentId: "main",
  lifecycleRevision: 7,
  sessionId: "shared-session",
  sessionKey: "agent:main:shared",
};

function persistedUser(params: {
  id: string;
  sequence: number;
  runId?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  media?: unknown[];
}): Record<string, unknown> {
  return {
    __openclaw: {
      id: params.id,
      idempotencyKey: `${params.runId ?? params.id}:user`,
      seq: params.sequence,
      ...(params.media ? { media: params.media } : {}),
      ...params.metadata,
    },
    content: params.media ? "" : [{ text: params.text ?? params.id, type: "text" }],
    role: "user",
  };
}

function replayInBothClients(
  events: readonly SessionProjectionEvent[],
  scope: SessionProjectionScope = sharedScope,
): SessionProjectionState {
  let browser = createSessionProjection(scope);
  let tui = createSessionProjection(scope);
  for (const event of events) {
    browser = reduceSessionProjection(browser, event);
    tui = reduceSessionProjection(tui, event);
    expect(browser, `clients diverged after ${event.type}`).toEqual(tui);
  }
  return browser;
}

describe("cross-client session projection conformance", () => {
  it.each([
    {
      name: "persisted identity wins over conflicting Gateway envelope",
      message: persistedUser({ id: "persisted-id", runId: "persisted-run", sequence: 3 }),
      envelope: {
        clientRunId: "envelope-run",
        messageId: "envelope-id",
        messageSeq: 99,
      },
      expected: {
        id: "persisted-id",
        idempotencyKey: "persisted-run:user",
        role: "user",
        runId: "persisted-run",
        sequence: 3,
      },
    },
    {
      name: "metadata-free events remain compatible with their envelope",
      message: { content: [{ text: "legacy event", type: "text" }], role: "user" },
      envelope: { clientRunId: "legacy-run", messageId: "legacy-id", messageSeq: 4 },
      expected: {
        id: "legacy-id",
        idempotencyKey: "legacy-run",
        role: "user",
        runId: "legacy-run",
        sequence: 4,
      },
    },
    {
      name: "unsafe persisted sequence falls back to a valid envelope sequence",
      message: persistedUser({
        id: "unsafe-sequence",
        sequence: Number.MAX_SAFE_INTEGER + 1,
      }),
      envelope: { messageSeq: 5 },
      expected: { id: "unsafe-sequence", role: "user", sequence: 5 },
    },
    {
      name: "attachment-only transcript messages retain authoritative identity",
      message: persistedUser({
        id: "attachment-message",
        media: [{ fileName: "diagram.png", mimeType: "image/png" }],
        sequence: 6,
      }),
      expected: { id: "attachment-message", role: "user", sequence: 6 },
    },
    {
      name: "complete imported identity includes its provider and CLI session",
      message: persistedUser({
        id: "provider-local-id",
        metadata: {
          cliSessionId: "provider-session",
          externalId: "provider-local-id",
          importedFrom: "provider-a",
        },
        sequence: 7,
      }),
      expected: {
        externalSource: JSON.stringify(["provider-a", "provider-session", "provider-local-id"]),
        isImported: true,
        role: "user",
        sequence: 7,
      },
    },
    {
      name: "incomplete imported identity does not enter a native identity namespace",
      message: persistedUser({
        id: "provider-local-id",
        metadata: { importedFrom: "provider-a" },
        sequence: 8,
      }),
      expected: { externalSource: null, isImported: true, role: "user", sequence: 8 },
    },
  ])("normalizes $name identically for browser and TUI", ({ message, envelope, expected }) => {
    expect(readSessionMessageIdentity(message, envelope)).toMatchObject(expected);
  });

  it("replays stale history, same-text sends, duplicates, gaps, and terminal events identically", () => {
    const text = "The same prompt from both clients.";
    const pending = {
      content: [{ text, type: "text" }],
      idempotencyKey: "local-run:user",
      role: "user",
    };
    const peer = persistedUser({ id: "peer-message", runId: "peer-run", sequence: 1, text });
    const local = persistedUser({ id: "local-message", runId: "local-run", sequence: 2, text });
    const events: SessionProjectionEvent[] = [
      { message: pending, runId: "local-run", type: "sendPending" },
      {
        envelope: { messageId: "wrong-peer-envelope", messageSeq: 99 },
        message: peer,
        type: "messagePersisted",
      },
      { idempotencyKey: "local-run:user", type: "sendAcknowledged" },
      { message: local, type: "messagePersisted" },
      {
        envelope: { messageId: "another-wrong-envelope", messageSeq: 100 },
        message: peer,
        type: "messagePersisted",
      },
      { messages: [peer], type: "snapshotLoaded" },
      { type: "transportGap" },
      { type: "reconnected" },
      { message: { content: "streaming" }, runId: "local-run", type: "runDelta" },
      { runId: "local-run", status: "completed", type: "runTerminal" },
      {
        errorMessage: "A delayed diagnostic must not reopen the run.",
        runId: "local-run",
        status: "error",
        type: "runTerminal",
      },
      { messages: [peer], type: "snapshotLoaded" },
    ];

    const state = replayInBothClients(events);

    expect(state.entries.map((entry) => entry.identity?.id)).toEqual([
      "peer-message",
      "local-message",
    ]);
    expect(state.entries.map((entry) => entry.pending)).toEqual([false, false]);
    expect(state.hasTransportGap).toBe(false);
    expect(state.runs["local-run"]).toMatchObject({
      errorMessage: "A delayed diagnostic must not reopen the run.",
      status: "completed",
    });
  });

  it("keeps imported IDs isolated from colliding native and other-provider messages", () => {
    const externalId = "colliding-id";
    const native = persistedUser({ id: externalId, sequence: 1 });
    const firstImport = persistedUser({
      id: externalId,
      metadata: { cliSessionId: "cli-a", externalId, importedFrom: "provider-a" },
      sequence: 2,
    });
    const secondImport = persistedUser({
      id: externalId,
      metadata: { cliSessionId: "cli-b", externalId, importedFrom: "provider-a" },
      sequence: 3,
    });
    const incompleteImport = persistedUser({
      id: externalId,
      metadata: { importedFrom: "provider-a" },
      sequence: 4,
    });

    const state = replayInBothClients([
      { message: native, type: "messagePersisted" },
      { message: firstImport, type: "messagePersisted" },
      { message: secondImport, type: "messagePersisted" },
      { message: incompleteImport, type: "messagePersisted" },
      { message: firstImport, type: "messagePersisted" },
    ]);

    expect(state.entries).toHaveLength(4);
    expect(state.entries.map((entry) => entry.identity?.externalSource)).toEqual([
      null,
      JSON.stringify(["provider-a", "cli-a", externalId]),
      JSON.stringify(["provider-a", "cli-b", externalId]),
      null,
    ]);
  });

  it("drops obsolete leaf and lifecycle events after a session reset in both clients", () => {
    const obsolete = persistedUser({ id: "before-reset", sequence: 1 });
    const current = persistedUser({ id: "after-reset", sequence: 1 });
    const currentScope = {
      ...sharedScope,
      activeLeafEntryId: "reset-leaf",
      lifecycleRevision: 8,
    };

    const state = replayInBothClients([
      { message: obsolete, scope: sharedScope, type: "messagePersisted" },
      { scope: currentScope, type: "sessionReset" },
      { message: obsolete, scope: sharedScope, type: "messagePersisted" },
      { messages: [obsolete], scope: sharedScope, type: "snapshotLoaded" },
      { message: current, scope: currentScope, type: "messagePersisted" },
    ]);

    expect(state.scope).toEqual(currentScope);
    expect(state.entries.map((entry) => entry.identity?.id)).toEqual(["after-reset"]);
  });

  it("replays a deterministic seeded transcript without conflating identical prompt text", () => {
    let seed = 0x51a7_c0de;
    const nextSeed = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const events: SessionProjectionEvent[] = [];
    const persisted: Record<string, unknown>[] = [];

    for (let sequence = 1; sequence <= 32; sequence += 1) {
      const value = nextSeed();
      const message = persistedUser({
        id: `seeded-message-${sequence}`,
        runId: `seeded-run-${sequence}`,
        sequence,
        text: value % 3 === 0 ? "A legitimately repeated prompt." : `Prompt ${sequence}`,
      });
      persisted.push(message);
      events.push({
        envelope: {
          messageId: `conflicting-seeded-envelope-${sequence}`,
          messageSeq: 1000 + sequence,
        },
        message,
        type: "messagePersisted",
      });
      if (value % 5 === 0) {
        events.push({ message, type: "messagePersisted" });
      }
      if (value % 7 === 0) {
        events.push({ messages: persisted.slice(0, -1), type: "snapshotLoaded" });
      }
    }

    const state = replayInBothClients(events);

    expect(state.entries).toHaveLength(32);
    expect(state.entries.map((entry) => entry.identity?.sequence)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    expect(state.entries.map((entry) => entry.identity?.id)).toEqual(
      Array.from({ length: 32 }, (_, index) => `seeded-message-${index + 1}`),
    );
  });
});
