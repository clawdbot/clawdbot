import { describe, expect, it } from "vitest";
import { readSessionMessageIdentity as readBrowserSessionMessageIdentity } from "./browser.js";
import { readSessionMessageIdentity as readNodeSessionMessageIdentity } from "./index.js";
import {
  createSessionProjection,
  isLocallyOptimisticSessionMessage,
  normalizeSessionProjectionRunId,
  projectLiveSessionMessage,
  readSessionMessageIdentity,
  readSessionMessageSequence,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

const primaryScope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

function createMessage(
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

describe("readSessionMessageIdentity", () => {
  it("reads the same canonical contract from both supported package barrels", () => {
    const message = createMessage("user", "hello", { id: "persisted", seq: 7 });
    expect(readBrowserSessionMessageIdentity(message)).toEqual(readSessionMessageIdentity(message));
    expect(readNodeSessionMessageIdentity(message)).toEqual(readSessionMessageIdentity(message));
  });

  it("prefers persisted identity, sequence, and send key to conflicting Gateway facts", () => {
    const message = createMessage("user", "hello", {
      id: "persisted-message",
      seq: 7,
      idempotencyKey: "persisted-run:user",
      runId: "queued-execution",
    });
    expect(
      readSessionMessageIdentity(message, {
        messageId: "conflicting-envelope",
        messageSeq: 8,
        clientRunId: "conflicting-run",
      }),
    ).toEqual({
      role: "user",
      id: "persisted-message",
      sequence: 7,
      idempotencyKey: "persisted-run:user",
      sendId: "persisted-run",
      runId: "queued-execution",
      isImported: false,
      externalSource: null,
    });
  });

  it("adopts metadata-free authoritative Gateway envelopes", () => {
    expect(
      readSessionMessageIdentity(createMessage("user", "hello"), {
        messageId: "envelope-message",
        messageSeq: 9,
        clientRunId: "envelope-run",
      }),
    ).toMatchObject({
      id: "envelope-message",
      sequence: 9,
      idempotencyKey: "envelope-run",
      sendId: "envelope-run",
      runId: "envelope-run",
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "does not trust unsafe transcript sequence %s",
    (sequence) => {
      expect(
        readSessionMessageIdentity(createMessage("user", "hello", { seq: sequence })),
      ).toHaveProperty("sequence", null);
    },
  );

  it.each([null, undefined, [], "user", 1, {}, { role: "  " }])(
    "rejects non-message identity %j",
    (message) => {
      expect(readSessionMessageIdentity(message)).toBeNull();
    },
  );

  it.each([
    ["run:user", "run"],
    ["run:user:user", "run:user"],
    ["  run:user  ", "run"],
    ["run", "run"],
    [":user", null],
    ["  ", null],
    [undefined, null],
  ])("normalizes exactly one user suffix from %j", (input, expected) => {
    expect(normalizeSessionProjectionRunId(input)).toBe(expected);
  });

  it("recovers the originating run from a persisted CLI assistant send key", () => {
    expect(
      readSessionMessageIdentity({
        role: "assistant",
        api: "cli",
        content: "Done",
        idempotencyKey: "cli-assistant:run-cli-1",
      }),
    ).toMatchObject({
      idempotencyKey: "cli-assistant:run-cli-1",
      sendId: null,
      runId: "run-cli-1",
    });
  });

  it("keeps assistant dedupe identity separate from producer-owned run identity", () => {
    expect(
      readSessionMessageIdentity({
        role: "assistant",
        content: "Commentary",
        idempotencyKey: "codex-app-server:thread-1:turn-1:commentary:item-1",
        __openclaw: { mirrorOrigin: "codex-app-server", runId: "run-1" },
      }),
    ).toMatchObject({
      idempotencyKey: "codex-app-server:thread-1:turn-1:commentary:item-1",
      runId: "run-1",
    });
    expect(
      readSessionMessageIdentity({
        role: "assistant",
        content: "Imported history",
        idempotencyKey: "codex-app-server:thread-1:history:turn-1:assistant",
        __openclaw: { mirrorOrigin: "codex-app-server" },
      }),
    ).toHaveProperty("runId", null);
  });

  it("requires every imported source component before claiming provider identity", () => {
    const identity = readSessionMessageIdentity(
      createMessage("user", "imported", {
        id: "provider-local",
        importedFrom: "claude-cli",
        cliSessionId: "cli-session",
        externalId: "provider-local",
      }),
    );
    expect(identity).toMatchObject({
      isImported: true,
      externalSource: JSON.stringify(["claude-cli", "cli-session", "provider-local"]),
    });
  });

  it.each([
    { importedFrom: "claude-cli", cliSessionId: "cli-session" },
    { importedFrom: "claude-cli", externalId: "provider-local" },
    { cliSessionId: "cli-session", externalId: "provider-local" },
  ])("does not invent a complete source for partial imported metadata %j", (metadata) => {
    expect(readSessionMessageIdentity(createMessage("user", "imported", metadata))).toMatchObject({
      isImported: true,
      externalSource: null,
    });
  });
});

describe("readSessionMessageSequence", () => {
  it("preserves the durable sequence of role-less history and status markers", () => {
    expect(readSessionMessageSequence({ __openclaw: { seq: 7 } })).toBe(7);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe role-less marker sequence %s",
    (sequence) => {
      expect(readSessionMessageSequence({ __openclaw: { seq: sequence } })).toBeNull();
    },
  );
});

describe("session transcript projection", () => {
  it("preserves live authoritative prompts missing from stale history in sequence order", () => {
    const prompt = createMessage("user", "shared prompt", { id: "user-1", seq: 1 });
    const reply = createMessage("assistant", "shared reply", { id: "assistant-2", seq: 2 });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), prompt);

    expect(reconcileSessionProjectionSnapshot(state, [reply], primaryScope).messages).toEqual([
      prompt,
      reply,
    ]);
  });

  it("adopts the snapshot projection of an already observed live message exactly once", () => {
    const live = createMessage("user", "live projection", { id: "user-1", seq: 1 });
    const persisted = createMessage("user", "persisted projection", { id: "user-1", seq: 1 });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), live);

    expect(reconcileSessionProjectionSnapshot(state, [persisted], primaryScope).messages).toEqual([
      persisted,
    ]);
  });

  it("promotes a synthetic final exactly once when canonical run history catches up", () => {
    const synthetic = createMessage("assistant", "delta-only final", {
      idempotencyKey: "final-run",
    });
    const persisted = createMessage("assistant", "canonical final", {
      id: "assistant-final",
      seq: 7,
      idempotencyKey: "final-run",
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), synthetic);
    state = reconcileSessionProjectionSnapshot(state, [], primaryScope);
    expect(state.messages).toEqual([synthetic]);
    state = reconcileSessionProjectionSnapshot(state, [persisted], primaryScope);
    expect(state.messages).toEqual([persisted]);
    expect(reconcileSessionProjectionSnapshot(state, [persisted], primaryScope).messages).toEqual([
      persisted,
    ]);
  });

  it("adopts a durable assistant identity from the same live run", () => {
    const synthetic = createMessage("assistant", "streamed final");
    const persisted = createMessage("assistant", "persisted final", {
      id: "assistant-final",
      seq: 2,
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), synthetic, {
      runId: "final-run",
    });

    state = projectLiveSessionMessage(state, persisted, { runId: "final-run" });

    expect(state.messages).toEqual([persisted]);
  });

  it("reorders a provisional final when older durable neighbors arrive first", () => {
    const synthetic = createMessage("assistant", "current final");
    const previous = createMessage("assistant", "previous final", {
      id: "previous-final",
      seq: 370,
      runId: "previous-run",
    });
    const prompt = createMessage("user", "current prompt", {
      id: "current-user",
      seq: 371,
    });
    const persisted = createMessage("assistant", "current final", {
      id: "current-final",
      seq: 372,
      runId: "current-run",
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), synthetic, {
      runId: "current-run",
    });
    state = projectLiveSessionMessage(state, previous, { runId: "previous-run" });
    state = projectLiveSessionMessage(state, prompt);
    state = projectLiveSessionMessage(state, persisted, { runId: "current-run" });

    expect(state.messages).toEqual([previous, prompt, persisted]);
  });

  it("keeps older durable neighbors before a late prompt and its provisional final", () => {
    const runId = "current-run";
    const synthetic = createMessage("assistant", "current final");
    const previous = createMessage("assistant", "previous final", {
      id: "previous-final",
      seq: 370,
      runId: "previous-run",
    });
    const prompt = createMessage("user", "current prompt", {
      id: "current-user",
      seq: 371,
      idempotencyKey: `${runId}:user`,
    });
    const persisted = createMessage("assistant", "current final", {
      id: "current-final",
      seq: 372,
      runId,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, synthetic, { runId });
    state = projectLiveSessionMessage(state, previous, { runId: "previous-run" });
    state = projectLiveSessionMessage(state, prompt, { clientRunId: runId });
    state = projectLiveSessionMessage(state, persisted, { runId });

    expect(state.messages).toEqual([previous, prompt, persisted]);
  });

  it("keeps every early same-run reply behind its delayed durable prompt", () => {
    const first = createMessage("assistant", "first current reply");
    const second = createMessage("assistant", "second current reply");
    const later = createMessage("assistant", "later current reply");
    const unrelated = createMessage("assistant", "unrelated live reply");
    const previous = createMessage("assistant", "previous durable reply", {
      id: "previous",
      seq: 10,
    });
    const following = createMessage("user", "following durable prompt", {
      id: "following",
      seq: 20,
    });
    const prompt = createMessage("user", "delayed current prompt", {
      id: "current-prompt",
      seq: 11,
      idempotencyKey: "current-run:user",
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), unrelated, {
      runId: "unrelated-run",
    });
    state = projectLiveSessionMessage(state, first, { runId: "current-run" });
    state = projectLiveSessionMessage(state, second, { runId: "current-run" });
    state = projectLiveSessionMessage(state, previous);
    state = projectLiveSessionMessage(state, following);
    state = projectLiveSessionMessage(state, later, { runId: "current-run" });
    state = projectLiveSessionMessage(state, prompt);

    expect(state.messages).toEqual([unrelated, previous, prompt, first, second, following, later]);
    expect(reconcileSessionProjectionSnapshot(state, [], primaryScope).messages).toEqual(
      state.messages,
    );
  });

  it("does not move an earlier durable same-run reply behind a later prompt", () => {
    const previous = createMessage("assistant", "earlier reply from the same run", {
      id: "earlier-reply",
      seq: 10,
      runId: "shared-run",
    });
    const prompt = createMessage("user", "later prompt", {
      id: "later-prompt",
      seq: 11,
      idempotencyKey: "shared-run:user",
    });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), previous);
    expect(projectLiveSessionMessage(state, prompt).messages).toEqual([previous, prompt]);
  });

  it("does not promote a provisional final into same-run Codex commentary", () => {
    const commentary = createMessage("assistant", "commentary", {
      id: "commentary-1",
      mirrorOrigin: "codex-app-server",
      runId: "run-1",
    });
    const final = createMessage("assistant", "final answer");
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), commentary, {
      runId: "run-1",
    });

    state = projectLiveSessionMessage(state, final, { runId: "run-1" });

    expect(state.messages).toEqual([commentary, final]);
  });

  it.each([
    { name: "matching run and item", itemId: "item-1", runId: "run-1", adopts: true },
    { name: "same prose from another item", itemId: "item-2", runId: "run-1", adopts: false },
    { name: "reused item from another run", itemId: "item-1", runId: "run-2", adopts: false },
    { name: "item with unknown run", itemId: "item-1", runId: undefined, adopts: false },
    { name: "unkeyed prose", itemId: undefined, runId: "run-1", adopts: false },
    {
      name: "another durable row",
      itemId: "item-1",
      runId: "run-1",
      id: "other-row",
      adopts: false,
    },
    { name: "another sequenced row", itemId: "item-1", runId: "run-1", seq: 2, adopts: false },
    {
      name: "imported provider row",
      itemId: "item-1",
      runId: "run-1",
      importedFrom: "external",
      adopts: false,
    },
  ])(
    "reconciles commentary by identity: $name",
    ({ itemId, runId, id, seq, importedFrom, adopts }) => {
      const local = {
        ...createMessage("assistant", "Repeated progress.", { id, seq, importedFrom }),
        openclawStreamFallback: { itemId, runId, source: "segment" },
      };
      const durable = {
        ...createMessage("assistant", "Repeated progress.", {
          id: "persisted",
          seq: 3,
          runId: "run-1",
          mirrorOrigin: "codex-app-server",
        }),
        openclawStreamFallback: { itemId: "item-1", source: "segment" },
      };
      const final = createMessage("assistant", "Finished.", {
        id: "final",
        seq: 4,
        runId: "run-1",
      });
      let state = createSessionProjection(primaryScope, [local, final]);

      state = projectLiveSessionMessage(state, durable);

      expect(state.messages).toEqual(adopts ? [durable, final] : [local, durable, final]);
      state = reduceSessionProjection(state, { type: "transportGap" });
      state = reduceSessionProjection(state, { type: "reconnected" });
      state = projectLiveSessionMessage(state, durable);
      expect(state.messages).toEqual(adopts ? [durable, final] : [local, durable, final]);
    },
  );

  it("keeps authoritative commentary when its provisional item replays with different text", () => {
    const durable = {
      ...createMessage("assistant", "Authoritative progress.", {
        id: "persisted",
        seq: 3,
        runId: "run-1",
      }),
      openclawStreamFallback: { itemId: "item-1", source: "segment" },
    };
    const local = {
      ...createMessage("assistant", "Partial progress."),
      openclawStreamFallback: { itemId: "item-1", runId: "run-1", source: "segment" },
    };
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), durable);

    expect(projectLiveSessionMessage(state, local).messages).toEqual([durable]);
    expect(reconcileSessionProjectionSnapshot(state, [durable], primaryScope).messages).toEqual([
      durable,
    ]);
  });

  it("keeps the durable assistant identity when its run's terminal projection replays", () => {
    const persisted = createMessage("assistant", "persisted final", {
      id: "assistant-final",
      seq: 2,
    });
    const synthetic = createMessage("assistant", "persisted final");
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), persisted, {
      runId: "final-run",
    });

    state = projectLiveSessionMessage(state, synthetic, { runId: "final-run" });

    expect(state.messages).toEqual([persisted]);
    expect(reconcileSessionProjectionSnapshot(state, [persisted], primaryScope).messages).toEqual([
      persisted,
    ]);
  });

  it("does not adopt an ambiguous synthetic final across distinct same-run assistants", () => {
    const synthetic = createMessage("assistant", "delta-only final", {
      idempotencyKey: "final-run",
    });
    const first = createMessage("assistant", "first final", {
      id: "assistant-first",
      seq: 7,
      idempotencyKey: "final-run",
    });
    const second = createMessage("assistant", "second final", {
      id: "assistant-second",
      seq: 8,
      idempotencyKey: "final-run",
    });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), synthetic);

    expect(
      reconcileSessionProjectionSnapshot(state, [first, second], primaryScope).messages,
    ).toEqual([first, second, synthetic]);
  });

  it("promotes a native sequence-only live row to its durable snapshot identity", () => {
    const live = createMessage("user", "live projection", { seq: 7 });
    const persisted = createMessage("user", "persisted projection", {
      id: "canonical-user-7",
      seq: 7,
    });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), live);

    expect(reconcileSessionProjectionSnapshot(state, [persisted], primaryScope).messages).toEqual([
      persisted,
    ]);
  });

  it("does not promote conflicting durable identities that share a snapshot sequence", () => {
    const live = createMessage("user", "different live turn", {
      id: "different-canonical-user",
      seq: 7,
    });
    const persisted = createMessage("user", "persisted turn", {
      id: "snapshot-canonical-user",
      seq: 7,
    });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), live);

    expect(reconcileSessionProjectionSnapshot(state, [persisted], primaryScope).messages).toEqual([
      persisted,
      live,
    ]);
  });

  it("never promotes a sequence-only live row from a second live Gateway event", () => {
    const first = createMessage("user", "first live turn", { seq: 7 });
    const second = createMessage("user", "different live turn", {
      id: "canonical-user-7",
      seq: 7,
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), first);
    state = projectLiveSessionMessage(state, second);

    expect(state.messages).toEqual([first, second]);
  });

  it("does not promote an imported live row into a native snapshot identity", () => {
    const imported = createMessage("user", "imported turn", {
      importedFrom: "claude-cli",
      seq: 7,
    });
    const native = createMessage("user", "native turn", {
      id: "canonical-user-7",
      seq: 7,
    });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), imported);

    expect(reconcileSessionProjectionSnapshot(state, [native], primaryScope).messages).toEqual([
      native,
      imported,
    ]);
  });

  it("never resurrects an ordinary removed historical message", () => {
    const removed = createMessage("user", "removed", { id: "removed", seq: 1 });
    const retained = createMessage("assistant", "retained", { id: "retained", seq: 2 });
    const state = createSessionProjection(primaryScope, [removed, retained]);

    expect(reconcileSessionProjectionSnapshot(state, [retained], primaryScope).messages).toEqual([
      retained,
    ]);
  });

  it("rejects live events from another agent, session, reset epoch, or branch", () => {
    const prompt = createMessage("user", "isolated", { id: "isolated", seq: 1 });
    const state = createSessionProjection(primaryScope);
    for (const scope of [
      { sessionKey: "agent:other:shared" },
      { sessionId: "other-session" },
      { agentId: "other" },
      { lifecycleRevision: 2 },
      { activeLeafEntryId: "other-leaf" },
    ]) {
      expect(projectLiveSessionMessage(state, prompt, undefined, scope)).toBe(state);
    }
  });

  it("preserves distinct same-text prompts belonging to different runs", () => {
    const first = createMessage("user", "continue", {
      id: "first-user",
      seq: 1,
      idempotencyKey: "first-run:user",
    });
    const second = createMessage("user", "continue", {
      id: "second-user",
      seq: 2,
      idempotencyKey: "second-run:user",
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), first);
    state = projectLiveSessionMessage(state, second);

    expect(state.messages).toEqual([first, second]);
  });

  it("does not mistake a shared run for the identity of distinct persisted messages", () => {
    const first = createMessage("user", "first", { idempotencyKey: "shared-run:user" });
    const second = createMessage("user", "second", { idempotencyKey: "shared-run:user" });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), first);
    state = projectLiveSessionMessage(state, second);

    expect(state.messages).toEqual([first, second]);
  });

  it("does not merge native messages with colliding imported provider-local IDs", () => {
    const native = createMessage("user", "native", { id: "provider-local", seq: 1 });
    const imported = createMessage("user", "imported", {
      id: "provider-local",
      seq: 2,
      importedFrom: "claude-cli",
      cliSessionId: "cli-session",
      externalId: "provider-local",
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), native);
    state = projectLiveSessionMessage(state, imported);

    expect(state.messages).toEqual([native, imported]);
  });

  it("does not merge incomplete imported source tuples", () => {
    const first = createMessage("user", "same words", {
      id: "source-local",
      importedFrom: "cli",
      externalId: "source-local",
    });
    const second = createMessage("user", "same words", {
      id: "source-local",
      importedFrom: "cli",
      externalId: "source-local",
    });
    expect(
      projectLiveSessionMessage(projectLiveSessionMessage(createSessionProjection(), first), second)
        .messages,
    ).toEqual([first, second]);
  });

  it("deduplicates incomplete imported live replays by their canonical session sequence", () => {
    const live = createMessage("user", "imported live", {
      id: "provider-local",
      importedFrom: "claude-cli",
      seq: 7,
    });
    const replay = createMessage("user", "imported replay", {
      id: "provider-local",
      importedFrom: "claude-cli",
      seq: 7,
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), live);
    state = projectLiveSessionMessage(state, replay);

    expect(state.messages).toEqual([replay]);
  });

  it("adopts snapshot projections of partial imports by canonical session sequence", () => {
    const live = createMessage("user", "live imported projection", {
      id: "provider-local",
      importedFrom: "claude-cli",
      seq: 7,
    });
    const snapshot = createMessage("user", "snapshot imported projection", {
      id: "provider-local",
      importedFrom: "claude-cli",
      seq: 7,
    });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), live);

    expect(reconcileSessionProjectionSnapshot(state, [snapshot], primaryScope).messages).toEqual([
      snapshot,
    ]);
  });

  it("keeps partial imported sources with distinct canonical sequences separate", () => {
    const first = createMessage("user", "same imported words", {
      id: "provider-local",
      importedFrom: "claude-cli",
      seq: 7,
    });
    const second = createMessage("user", "same imported words", {
      id: "provider-local",
      importedFrom: "other-cli",
      seq: 8,
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), first);
    state = projectLiveSessionMessage(state, second);

    expect(state.messages).toEqual([first, second]);
  });

  it("does not merge a partial import into a complete source tuple at the same sequence", () => {
    const partial = createMessage("user", "partial source", {
      importedFrom: "claude-cli",
      seq: 7,
    });
    const complete = createMessage("user", "complete source", {
      importedFrom: "claude-cli",
      cliSessionId: "cli-session",
      externalId: "provider-local",
      seq: 7,
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), partial);
    state = projectLiveSessionMessage(state, complete);

    expect(state.messages).toEqual([partial, complete]);
  });

  it("explicitly promotes only the admitted sequenced handoff", () => {
    const peer = createMessage("user", "continue", {
      idempotencyKey: "initial-run:user",
      seq: 1,
    });
    const handoff = createMessage("user", "continue", {
      idempotencyKey: "initial-run:user",
      seq: 2,
    });
    const followingAssistant = createMessage("assistant", "already working", { seq: 3 });
    let state = createSessionProjection(primaryScope, [peer, handoff, followingAssistant]);

    state = reduceSessionProjection(state, {
      type: "sendPending",
      runId: "initial-run",
      message: handoff,
    });

    expect(state.entries).toMatchObject([
      { message: peer, pending: false },
      { message: handoff, pending: true, pendingRunId: "initial-run" },
      { message: followingAssistant, pending: false },
    ]);
    expect(
      reduceSessionProjection(state, { type: "sendFailed", runId: "initial-run" }).messages,
    ).toEqual([peer, followingAssistant]);

    const wrongSequence = createMessage("user", "continue", {
      id: "wrong-sequence-user",
      idempotencyKey: "initial-run:user",
      seq: 4,
    });
    state = reduceSessionProjection(state, {
      type: "messagePersisted",
      message: wrongSequence,
    });
    expect(state.messages).toEqual([peer, handoff, followingAssistant, wrongSequence]);
    expect(state.entries[1]).toMatchObject({ pending: true, pendingRunId: "initial-run" });

    const authoritative = createMessage("user", "continue", {
      id: "initial-user",
      idempotencyKey: "initial-run:user",
      seq: 2,
    });
    state = reduceSessionProjection(state, {
      type: "messagePersisted",
      message: authoritative,
    });

    expect(state.messages).toEqual([peer, authoritative, followingAssistant, wrongSequence]);
    expect(state.entries[1]).toMatchObject({
      identity: { id: "initial-user" },
      pending: false,
    });
    expect(reduceSessionProjection(state, { type: "sendFailed", runId: "initial-run" })).toBe(
      state,
    );
    for (const protectedMessage of [
      createMessage("user", "persisted", {
        id: "persisted-user",
        idempotencyKey: "protected-run:user",
        seq: 4,
      }),
      createMessage("user", "imported", {
        importedFrom: "claude-cli",
        cliSessionId: "cli-session",
        externalId: "external-user",
        idempotencyKey: "protected-run:user",
        seq: 4,
      }),
    ]) {
      const protectedState = createSessionProjection(primaryScope, [protectedMessage]);
      expect(
        reduceSessionProjection(protectedState, {
          type: "sendPending",
          runId: "protected-run",
          message: protectedMessage,
        }),
      ).toBe(protectedState);
    }
  });

  it.each([undefined, "queued-execution"])(
    "reconciles an attachment-only optimistic turn by its send key with execution %s",
    (runId) => {
      const pending = {
        role: "user",
        content: "",
        __openclaw: { idempotencyKey: "image-run:user" },
      };
      const persisted = {
        role: "user",
        content: "",
        __openclaw: {
          id: "image-user",
          seq: 1,
          idempotencyKey: "image-run:user",
          runId,
          media: [{ path: "/image.png", contentType: "image/png" }],
        },
      };
      let state = reduceSessionProjection(createSessionProjection(primaryScope), {
        type: "sendPending",
        runId: "image-run",
        message: pending,
      });
      state = projectLiveSessionMessage(state, persisted);

      expect(state.messages).toEqual([persisted]);
      expect(state.entries[0]).toMatchObject({ live: true, pending: false });
    },
  );

  it("reconciles a restored pending send with a completed queued execution", () => {
    const pending = createMessage("user", "Update the menu", {
      idempotencyKey: "queued-send:user",
    });
    const persisted = createMessage("user", "Update the menu", {
      id: "persisted-prompt",
      seq: 1,
      idempotencyKey: "queued-send:user",
      runId: "queued-execution",
    });
    const reply = createMessage("assistant", "Menu updated", {
      id: "persisted-reply",
      seq: 2,
      runId: "queued-execution",
    });
    const state = createSessionProjection(primaryScope, [persisted, reply, pending]);

    const reconciled = reconcileSessionProjectionSnapshot(state, [persisted, reply], primaryScope);

    expect(reconciled.messages).toEqual([persisted, reply]);
    expect(reconciled.entries[0]?.identity?.runId).toBe("queued-execution");
    expect(
      reduceSessionProjection(reconciled, {
        type: "sendPending",
        runId: "queued-send",
        message: pending,
      }).messages,
    ).toEqual([persisted, reply]);
  });

  it("rejects a delayed old-epoch snapshot after the selected session resets", () => {
    const oldMessage = createMessage("user", "before reset", { id: "old", seq: 1 });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), oldMessage);
    state = reduceSessionProjection(state, {
      type: "sessionReset",
      lifecycleRevision: 2,
    });
    const resetState = state;
    state = reduceSessionProjection(state, {
      type: "snapshotLoaded",
      scope: primaryScope,
      messages: [oldMessage],
    });

    expect(state).toBe(resetState);
    expect(state.scope.lifecycleRevision).toBe(2);
    expect(state.messages).toEqual([]);
  });

  it("clears a transport gap only after an authoritative snapshot", () => {
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "transportGap",
    });
    expect(state.hasTransportGap).toBe(true);

    state = reduceSessionProjection(state, { type: "reconnected" });
    expect(state.hasTransportGap).toBe(true);

    state = reduceSessionProjection(state, { type: "snapshotLoaded", messages: [] });
    expect(state.hasTransportGap).toBe(false);
  });

  it("classifies only metadata-free or send-key-only local turns as optimistic", () => {
    const pending = createMessage("user", "local", { idempotencyKey: "local-run:user" });
    const assistant = createMessage("assistant", "streaming locally");
    const sequenced = createMessage("user", "durable sequence", { seq: 2 });
    const persisted = createMessage("user", "durable", {
      id: "persisted-user",
      seq: 3,
      idempotencyKey: "local-run:user",
    });

    expect(isLocallyOptimisticSessionMessage(pending)).toBe(true);
    expect(isLocallyOptimisticSessionMessage(assistant)).toBe(true);
    expect(isLocallyOptimisticSessionMessage(sequenced)).toBe(false);
    expect(isLocallyOptimisticSessionMessage(persisted)).toBe(false);
    expect(isLocallyOptimisticSessionMessage({ role: "system", content: "marker" })).toBe(false);
  });

  it("infers one canonical pending owner for a local prompt and its assistant stream", () => {
    const pending = createMessage("user", "local prompt", {
      idempotencyKey: "local-run:user",
    });
    const assistant = createMessage("assistant", "streaming locally");
    const projection = createSessionProjection(primaryScope, [pending, assistant]);

    expect(
      projection.entries.map(({ pending: isPending, pendingRunId }) => ({
        pending: isPending,
        pendingRunId,
      })),
    ).toEqual([
      { pending: true, pendingRunId: "local-run" },
      { pending: true, pendingRunId: "local-run" },
    ]);
  });

  it("filters hidden snapshot, authoritative live, and pending rows in one canonical pass", () => {
    const visible = createMessage("user", "visible", { id: "visible", seq: 1 });
    const hiddenSnapshot = createMessage("assistant", "hidden snapshot", {
      id: "hidden-snapshot",
      seq: 2,
    });
    const hiddenLive = createMessage("user", "hidden live", { id: "hidden-live", seq: 3 });
    const hiddenPending = createMessage("user", "hidden pending", {
      idempotencyKey: "hidden-run:user",
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "sendPending",
      runId: "hidden-run",
      message: hiddenPending,
    });
    state = projectLiveSessionMessage(state, hiddenLive);
    state = reduceSessionProjection(state, {
      type: "snapshotLoaded",
      messages: [visible, hiddenSnapshot],
      scope: primaryScope,
      options: {
        shouldIncludeMessage: (message) =>
          message !== hiddenSnapshot && message !== hiddenLive && message !== hiddenPending,
      },
    });

    expect(state.messages).toEqual([visible]);
  });

  it("rekeys provisional pending turns without adopting a same-text peer", () => {
    const pending = createMessage("user", "same prompt", {
      idempotencyKey: "provisional-run:user",
    });
    const peer = createMessage("user", "same prompt", {
      id: "peer-user",
      seq: 1,
      idempotencyKey: "peer-run:user",
      runId: "provisional-run",
    });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope, [pending]), peer);
    state = reduceSessionProjection(state, {
      type: "sendAcknowledged",
      previousRunId: "provisional-run",
      runId: "accepted-run",
    });

    expect(state.messages).toEqual([pending, peer]);
    expect(state.entries[0]).toMatchObject({ pending: true, pendingRunId: "accepted-run" });
    const accepted = createMessage("user", "same prompt", {
      id: "accepted-user",
      seq: 2,
      idempotencyKey: "accepted-run:user",
      runId: "queued-execution",
    });
    expect(projectLiveSessionMessage(state, accepted).messages).toEqual([peer, accepted]);

    const persistedBeforeAck = projectLiveSessionMessage(
      createSessionProjection(primaryScope, [pending]),
      accepted,
    );
    const acknowledge = {
      type: "sendAcknowledged",
      previousRunId: "provisional-run",
      runId: "accepted-run",
    } as const;
    const adopted = reduceSessionProjection(persistedBeforeAck, acknowledge);
    expect(adopted.messages).toEqual([accepted]);
    expect(reduceSessionProjection(adopted, acknowledge)).toBe(adopted);
  });

  it("removes only a failed pending turn while preserving same-text authoritative peers", () => {
    const pending = createMessage("user", "same prompt", {
      idempotencyKey: "failed-run:user",
    });
    const assistant = createMessage("assistant", "optimistic stream");
    const independentAssistant = createMessage("assistant", "independent stream", {
      idempotencyKey: "other-run",
    });
    const unkeyedUser = createMessage("user", "intervening unkeyed user");
    const unownedAssistant = createMessage("assistant", "unowned stream");
    const peer = createMessage("user", "same prompt", {
      id: "peer-user",
      seq: 1,
      idempotencyKey: "peer-run:user",
    });
    const initial = createSessionProjection(primaryScope, [
      pending,
      assistant,
      independentAssistant,
      unkeyedUser,
      unownedAssistant,
      peer,
    ]);
    expect(initial.entries.map((entry) => entry.pendingRunId)).toEqual([
      "failed-run",
      "failed-run",
      "other-run",
      null,
      null,
      null,
    ]);
    const failed = reduceSessionProjection(initial, { type: "sendFailed", runId: "failed-run" });

    expect(failed.messages).toEqual([independentAssistant, unkeyedUser, unownedAssistant, peer]);
    expect(reduceSessionProjection(failed, { type: "sendFailed", runId: "failed-run" })).toBe(
      failed,
    );
  });

  it("places an authoritative prompt ahead of its already projected same-run final", () => {
    const assistant = createMessage("assistant", "already delivered", {
      id: "assistant-1",
      idempotencyKey: "shared-run",
    });
    let state = createSessionProjection(primaryScope, [assistant]);
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "shared-run",
      status: "completed",
      message: assistant,
    });
    const prompt = createMessage("user", "late peer prompt", {
      id: "user-1",
      idempotencyKey: "shared-run:user",
    });

    expect(projectLiveSessionMessage(state, prompt).messages).toEqual([prompt, assistant]);
  });

  it("does not mutate source messages, snapshots, or previous reducer states", () => {
    const message = Object.freeze(createMessage("user", "immutable", { id: "user", seq: 1 }));
    const messages = Object.freeze([message]);
    const initial = createSessionProjection(primaryScope);
    const live = projectLiveSessionMessage(initial, message);
    const replayed = reconcileSessionProjectionSnapshot(live, messages, primaryScope);

    expect(initial.messages).toEqual([]);
    expect(replayed.messages).toEqual([message]);
    expect(messages).toEqual([message]);
  });
});
