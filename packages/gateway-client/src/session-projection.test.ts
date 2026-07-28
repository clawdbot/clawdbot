import { describe, expect, it } from "vitest";
import { readSessionMessageIdentity as readBrowserSessionMessageIdentity } from "./browser.js";
import { readSessionMessageIdentity as readNodeSessionMessageIdentity } from "./index.js";
import {
  createSessionProjection,
  getSessionProjectionMessages,
  hasSessionProjectionAcceptedFinal,
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
      runId: "persisted-run",
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
      runId: "envelope-run",
    });
  });

  it("prefers a message-root send key to an envelope run", () => {
    expect(
      readSessionMessageIdentity(
        { ...createMessage("user", "hello"), idempotencyKey: "record-run:user" },
        { clientRunId: "envelope-run" },
      ),
    ).toMatchObject({ idempotencyKey: "record-run:user", runId: "record-run" });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "does not trust unsafe transcript sequence %s",
    (sequence) => {
      expect(
        readSessionMessageIdentity(createMessage("user", "hello", { seq: sequence })),
      ).toHaveProperty("sequence", null);
    },
  );

  it("uses a safe envelope sequence when persisted sequence is malformed", () => {
    expect(
      readSessionMessageIdentity(createMessage("user", "hello", { seq: 0 }), {
        messageSeq: 12,
      }),
    ).toHaveProperty("sequence", 12);
  });

  it.each([null, undefined, [], "user", 1, {}, { role: "  " }])(
    "rejects non-message identity %j",
    (message) => {
      expect(readSessionMessageIdentity(message)).toBeNull();
    },
  );

  it("normalizes role and run ownership without changing the persisted send key", () => {
    expect(
      readSessionMessageIdentity({ role: " USER ", __openclaw: { idempotencyKey: "run:user" } }),
    ).toMatchObject({ role: "user", idempotencyKey: "run:user", runId: "run" });
  });

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

  it("prefers a valid persisted marker sequence to a conflicting envelope", () => {
    expect(readSessionMessageSequence({ __openclaw: { seq: 7 } }, { messageSeq: 8 })).toBe(7);
  });

  it("uses a safe envelope when a role-less persisted marker is invalid", () => {
    expect(readSessionMessageSequence({ __openclaw: { seq: 0 } }, { messageSeq: 8 })).toBe(8);
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

  it("drops old live provenance when an authoritative snapshot changes branch", () => {
    const oldPrompt = createMessage("user", "old leaf", { id: "old", seq: 1 });
    const nextPrompt = createMessage("user", "next leaf", { id: "next", seq: 1 });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), oldPrompt);
    const nextScope = { ...primaryScope, activeLeafEntryId: "leaf-2" };

    expect(reconcileSessionProjectionSnapshot(state, [nextPrompt], nextScope).messages).toEqual([
      nextPrompt,
    ]);
  });

  it("drops old live provenance when an authoritative snapshot changes lifecycle", () => {
    const oldPrompt = createMessage("user", "before reset", { id: "old", seq: 1 });
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), oldPrompt);
    expect(
      reconcileSessionProjectionSnapshot(state, [], { ...primaryScope, lifecycleRevision: 2 })
        .messages,
    ).toEqual([]);
  });

  it("deduplicates a repeated durable message without matching visible text", () => {
    const first = createMessage("user", "same words", { id: "user-1", seq: 1 });
    const repeated = createMessage("user", "same words", { id: "user-1", seq: 1 });
    let state = createSessionProjection(primaryScope);
    state = projectLiveSessionMessage(state, first);
    state = projectLiveSessionMessage(state, repeated);

    expect(getSessionProjectionMessages(state)).toEqual([repeated]);
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

  it("retains an attachment-only canonical turn without extracting or mutating media", () => {
    const media = [{ path: "/media/inbound/image.png", contentType: "image/png" }];
    const attachment = { role: "user", content: "", __openclaw: { id: "image", seq: 1, media } };
    const state = projectLiveSessionMessage(createSessionProjection(primaryScope), attachment);

    expect(state.messages).toEqual([attachment]);
    expect(state.messages[0]).toBe(attachment);
    expect((state.messages[0] as typeof attachment)["__openclaw"].media).toBe(media);
  });

  it("reconciles the actual pending run and keeps a same-text peer pending turn", () => {
    const firstPending = createMessage("user", "continue", { idempotencyKey: "first-run:user" });
    const secondPending = createMessage("user", "continue", { idempotencyKey: "second-run:user" });
    const firstPersisted = createMessage("user", "continue", {
      id: "first-user",
      seq: 1,
      idempotencyKey: "first-run:user",
    });
    let state = createSessionProjection(primaryScope);
    state = reduceSessionProjection(state, {
      type: "sendPending",
      runId: "first-run",
      message: firstPending,
    });
    state = reduceSessionProjection(state, {
      type: "sendPending",
      runId: "second-run",
      message: secondPending,
    });
    state = reconcileSessionProjectionSnapshot(state, [firstPersisted], primaryScope);

    expect(state.messages).toEqual([firstPersisted, secondPending]);
    expect(state.entries[1]).toMatchObject({ pending: true, pendingRunId: "second-run" });
  });

  it("reconciles an attachment-only optimistic turn solely by its actual send key", () => {
    const pending = { role: "user", content: "", __openclaw: { idempotencyKey: "image-run:user" } };
    const persisted = {
      role: "user",
      content: "",
      __openclaw: {
        id: "image-user",
        seq: 1,
        idempotencyKey: "image-run:user",
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
  });

  it("does not duplicate a metadata-free retry of the same optimistic send", () => {
    const pending = createMessage("user", "same request");
    const event = {
      type: "sendPending",
      runId: "same-run",
      message: pending,
    } as const;
    const first = reduceSessionProjection(createSessionProjection(primaryScope), event);

    expect(reduceSessionProjection(first, event)).toBe(first);
    expect(first.messages).toEqual([pending]);
  });

  it("sorts authoritative persisted batches by canonical transcript sequence", () => {
    const second = createMessage("assistant", "second", { id: "second", seq: 2 });
    const first = createMessage("user", "first", { id: "first", seq: 1 });
    let state = projectLiveSessionMessage(createSessionProjection(primaryScope), second);
    state = projectLiveSessionMessage(state, first);

    expect(state.messages).toEqual([first, second]);
  });

  it("clears messages, pending sends, and terminal runs on an explicit session reset", () => {
    let state = projectLiveSessionMessage(
      createSessionProjection(primaryScope),
      createMessage("user", "before reset", { id: "old", seq: 1 }),
    );
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "old-run",
      status: "completed",
    });
    state = reduceSessionProjection(state, {
      type: "sessionReset",
      lifecycleRevision: 2,
    });

    expect(state.messages).toEqual([]);
    expect(state.runs).toEqual({});
    expect(state.scope.lifecycleRevision).toBe(2);
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

  it("does not reset the selected session for another agent's reset event", () => {
    const prompt = createMessage("user", "selected", { id: "selected", seq: 1 });
    const state = createSessionProjection(primaryScope, [prompt]);

    expect(
      reduceSessionProjection(state, {
        type: "sessionReset",
        sessionKey: "agent:other:shared",
        agentId: "other",
        lifecycleRevision: 2,
      }),
    ).toBe(state);
  });

  it("rejects a delayed old-branch snapshot without restoring its live messages", () => {
    const currentScope = { ...primaryScope, activeLeafEntryId: "leaf-2" };
    const current = createMessage("user", "current branch", { id: "current", seq: 1 });
    const old = createMessage("user", "abandoned branch", { id: "old", seq: 1 });
    const state = createSessionProjection(currentScope, [current]);

    expect(
      reduceSessionProjection(state, {
        type: "snapshotLoaded",
        scope: primaryScope,
        messages: [old],
      }),
    ).toBe(state);
  });

  it("keeps a delivered final immutable while retaining a later error as diagnostic", () => {
    const finalMessage = createMessage("assistant", "delivered");
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: finalMessage,
      stopReason: "stop",
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "late error",
    });

    expect(state.runs["run-1"]).toMatchObject({
      runId: "run-1",
      status: "completed",
      message: finalMessage,
      stopReason: "stop",
      errorKind: "provider_error",
      errorMessage: "late error",
    });
  });

  it("does not reopen a completed run when a stale stream delta arrives", () => {
    const completed = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
    });

    expect(
      reduceSessionProjection(completed, {
        type: "runDelta",
        runId: "run-1",
        message: createMessage("assistant", "late stream"),
      }),
    ).toBe(completed);
  });

  it("upgrades an empty completed final exactly once without reopening the run", () => {
    const emptyMessage = createMessage("assistant", "");
    const deliveredMessage = createMessage("assistant", "eventual final");
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: emptyMessage,
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: deliveredMessage,
    });

    expect(state.runs["run-1"]).toMatchObject({
      status: "completed",
      message: deliveredMessage,
    });
    const laterFinal = createMessage("assistant", "later distinct final");
    const laterEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: laterFinal,
    } as const;
    const acceptedLaterFinal = reduceSessionProjection(state, laterEvent);
    expect(acceptedLaterFinal.runs["run-1"]?.message).toBe(deliveredMessage);
    expect(hasSessionProjectionAcceptedFinal(acceptedLaterFinal.runs["run-1"], laterFinal)).toBe(
      true,
    );
    expect(reduceSessionProjection(acceptedLaterFinal, laterEvent)).toBe(acceptedLaterFinal);
  });

  it("accepts distinct same-run persisted finals and ignores the later final's replay", () => {
    const first = createMessage("assistant", "first final", { id: "assistant-a", seq: 4 });
    const second = createMessage("assistant", "second final", { id: "assistant-b", seq: 5 });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(false);

    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduceSessionProjection(state, secondEvent);

    expect(state.runs["run-1"]?.message).toBe(first);
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], first)).toBe(true);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduceSessionProjection(state, secondEvent)).toBe(state);
  });

  it.each(["error", "aborted"] as const)(
    "accepts a displayable final after a message-less %s without replaying it",
    (initialStatus) => {
      const delivered = createMessage("assistant", "recovered final", {
        id: "recovered-assistant",
        seq: 7,
      });
      let state = reduceSessionProjection(createSessionProjection(primaryScope), {
        type: "runTerminal",
        runId: "run-1",
        status: initialStatus,
        ...(initialStatus === "error"
          ? { errorKind: "provider_error", errorMessage: "provider diagnostic" }
          : { stopReason: "aborted" }),
      });
      const finalEvent = {
        type: "runTerminal",
        runId: "run-1",
        status: "completed",
        message: delivered,
      } as const;
      state = reduceSessionProjection(state, finalEvent);

      expect(state.runs["run-1"]).toMatchObject({
        status: initialStatus,
        message: delivered,
      });
      expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], delivered)).toBe(true);
      expect(reduceSessionProjection(state, finalEvent)).toBe(state);
      if (initialStatus === "error") {
        expect(state.runs["run-1"]?.errorMessage).toBe("provider diagnostic");
      }
    },
  );

  it("remembers distinct recovered finals after an initial message-less error", () => {
    const first = createMessage("assistant", "first recovered final", {
      id: "recovered-a",
      seq: 7,
    });
    const second = createMessage("assistant", "second recovered final", {
      id: "recovered-b",
      seq: 8,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "original diagnostic",
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduceSessionProjection(state, secondEvent);

    expect(state.runs["run-1"]).toMatchObject({
      status: "error",
      message: first,
      errorMessage: "original diagnostic",
    });
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduceSessionProjection(state, secondEvent)).toBe(state);
  });

  it("does not replace a displayable error with a conflicting later final", () => {
    const errorMessage = createMessage("assistant", "displayable failure");
    const state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      message: errorMessage,
    });

    expect(
      reduceSessionProjection(state, {
        type: "runTerminal",
        runId: "run-1",
        status: "completed",
        message: createMessage("assistant", "conflicting final"),
      }),
    ).toBe(state);
    expect(state.runs["run-1"]?.message).toBe(errorMessage);
  });

  it("distinguishes and deduplicates metadata-free finals by canonical visible content", () => {
    const first = createMessage("assistant", "first metadata-free final");
    const second = createMessage("assistant", "second metadata-free final");
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduceSessionProjection(state, secondEvent);

    expect(state.runs["run-1"]?.message).toBe(first);
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduceSessionProjection(state, secondEvent)).toBe(state);
  });

  it("never classifies an empty final as an accepted displayable reply", () => {
    const empty = createMessage("assistant", "");
    const state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: empty,
    });

    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], empty)).toBe(false);
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toBeUndefined();
  });

  it("bounds accepted same-run final identities without losing the first delivered reply", () => {
    const first = createMessage("assistant", "final 0", { id: "assistant-0", seq: 1 });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    for (let index = 1; index < 48; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runTerminal",
        runId: "run-1",
        status: "completed",
        message: createMessage("assistant", `final ${index}`, {
          id: `assistant-${index}`,
          seq: index + 1,
        }),
      });
    }

    expect(state.runs["run-1"]?.message).toBe(first);
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(32);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], first)).toBe(true);
    expect(
      hasSessionProjectionAcceptedFinal(
        state.runs["run-1"],
        createMessage("assistant", "final 47", { id: "assistant-47", seq: 48 }),
      ),
    ).toBe(true);
  });

  it("retains an identical late terminal diagnostic exactly once", () => {
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
    });
    const lateError = {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "late error",
    } as const;
    state = reduceSessionProjection(state, lateError);

    expect(reduceSessionProjection(state, lateError)).toBe(state);
  });

  it("ignores whitespace diagnostics and accepts one meaningful late provider error", () => {
    const delivered = createMessage("assistant", "delivered final", {
      id: "delivered-assistant",
      seq: 7,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: delivered,
    });
    const completed = state;
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "  \n\t ",
    });
    expect(state).toBe(completed);

    const actionableError = {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "  provider rejected request  ",
    } as const;
    state = reduceSessionProjection(state, actionableError);

    expect(state.runs["run-1"]).toMatchObject({
      status: "completed",
      message: delivered,
      errorKind: "provider_error",
      errorMessage: "provider rejected request",
    });
    expect(reduceSessionProjection(state, actionableError)).toBe(state);
  });

  it("does not let an initial whitespace-only error block the first real diagnostic", () => {
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: " \n\t ",
    });
    expect(state.runs["run-1"]?.errorMessage).toBeUndefined();

    const actionableError = {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "  provider diagnostic  ",
    } as const;
    state = reduceSessionProjection(state, actionableError);

    expect(state.runs["run-1"]).toMatchObject({
      status: "error",
      errorKind: "provider_error",
      errorMessage: "provider diagnostic",
    });
    expect(reduceSessionProjection(state, actionableError)).toBe(state);
  });

  it.each(["aborted", "timeout", "yielded"] as const)(
    "preserves canonical %s terminal metadata",
    (status) => {
      const state = reduceSessionProjection(createSessionProjection(primaryScope), {
        type: "runTerminal",
        runId: "run-1",
        status,
        stopReason: status,
        errorKind: status,
      });
      expect(state.runs["run-1"]).toMatchObject({ status, stopReason: status, errorKind: status });
    },
  );

  it("bounds long-session terminal history without evicting any active stream", () => {
    let state = createSessionProjection(primaryScope);
    for (const runId of ["active-first", "active-second"]) {
      state = reduceSessionProjection(state, {
        type: "runDelta",
        runId,
        message: createMessage("assistant", `stream ${runId}`),
      });
    }
    for (let index = 0; index < 1_000; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runTerminal",
        runId: `completed-${index}`,
        status: "completed",
        stopReason: "stop",
      });
    }

    expect(Object.keys(state.runs).length).toBeLessThanOrEqual(200);
    expect(state.runs["active-first"]?.status).toBe("streaming");
    expect(state.runs["active-second"]?.status).toBe("streaming");
    expect(state.runs["completed-0"]).toBeUndefined();
    expect(state.runs["completed-999"]).toMatchObject({
      status: "completed",
      stopReason: "stop",
    });
  });

  it("retains a newly completed live stream ahead of older terminal diagnostics", () => {
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runDelta",
      runId: "active-first",
      message: createMessage("assistant", "stream"),
    });
    for (let index = 0; index < 199; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runTerminal",
        runId: `older-${index}`,
        status: "completed",
      });
    }
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "active-first",
      status: "completed",
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "newest",
      status: "completed",
    });

    expect(Object.keys(state.runs)).toHaveLength(150);
    expect(state.runs["older-0"]).toBeUndefined();
    expect(state.runs["active-first"]?.status).toBe("completed");
    expect(state.runs.newest?.status).toBe("completed");
  });

  it("protects every concurrent active stream when terminal retention reaches its soft cap", () => {
    let state = createSessionProjection(primaryScope);
    for (let index = 0; index < 205; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runDelta",
        runId: `active-${index}`,
      });
    }

    expect(Object.keys(state.runs)).toHaveLength(205);
    expect(state.runs["active-0"]?.status).toBe("streaming");
    expect(state.runs["active-204"]?.status).toBe("streaming");
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

  it("does not mutate source messages, snapshots, or previous reducer states", () => {
    const message = Object.freeze(createMessage("user", "immutable", { id: "user", seq: 1 }));
    const messages = Object.freeze([message]);
    const initial = createSessionProjection(primaryScope);
    const live = projectLiveSessionMessage(initial, message);
    const replayed = reconcileSessionProjectionSnapshot(live, messages, primaryScope);

    expect(initial.messages).toEqual([]);
    expect(live.messages).toEqual([message]);
    expect(replayed.messages).toEqual([message]);
    expect(messages).toEqual([message]);
  });
});
