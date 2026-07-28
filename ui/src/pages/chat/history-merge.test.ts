// @vitest-environment node
// Control UI tests cover history merge behavior.
import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
  getChatSessionProjection,
  preserveLiveAuthoritativeUserMessages,
  preserveOptimisticTailMessages,
  readTranscriptSequence,
  rememberLiveAuthoritativeUserMessage,
  setChatSessionProjection,
} from "./history-merge.ts";

function createHistoryMessage(
  role: "assistant" | "user",
  text: string,
  metadata?: Record<string, unknown>,
  timestamp?: number,
) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(metadata === undefined ? {} : { __openclaw: metadata }),
  };
}

describe("canonical browser session projection", () => {
  it("keeps each split pane's live projection independent", () => {
    const scope = { sessionKey: "agent:main:shared", sessionId: "shared-session" };
    const firstPane = {};
    const secondPane = {};
    const liveUser = createHistoryMessage("user", "first pane", { id: "first-user", seq: 1 });
    const firstProjection = reduceSessionProjection(
      getChatSessionProjection(firstPane, [], scope),
      {
        type: "messagePersisted",
        message: liveUser,
        scope,
      },
    );
    setChatSessionProjection(firstPane, firstProjection);

    expect(getChatSessionProjection(firstPane, [liveUser], scope).messages).toEqual([liveUser]);
    expect(getChatSessionProjection(secondPane, [], scope).messages).toEqual([]);
  });

  it("binds newly learned session and branch identity without losing live messages or runs", () => {
    const owner = {};
    const liveUser = createHistoryMessage("user", "same live turn", {
      id: "same-live-user",
      seq: 1,
    });
    const initialScope = { sessionKey: "agent:main:shared" };
    const initialProjection = reduceSessionProjection(
      getChatSessionProjection(owner, [liveUser], initialScope),
      { type: "runDelta", runId: "same-live-run", scope: initialScope },
    );
    setChatSessionProjection(owner, initialProjection);

    const boundScope = {
      ...initialScope,
      sessionId: "learned-session",
      activeLeafEntryId: "learned-leaf",
    };
    const boundProjection = getChatSessionProjection(owner, [liveUser], boundScope);

    expect(boundProjection.scope).toEqual(boundScope);
    expect(boundProjection.entries).toBe(initialProjection.entries);
    expect(boundProjection.runs).toBe(initialProjection.runs);
    expect(boundProjection.messages).toEqual([liveUser]);
    expect(boundProjection.runs["same-live-run"]?.status).toBe("streaming");
  });

  it("resets learned live and run state when a subsequently proven branch changes", () => {
    const owner = {};
    const initialScope = { sessionKey: "agent:main:shared" };
    const liveUser = createHistoryMessage("user", "obsolete live turn", {
      id: "obsolete-live-user",
      seq: 1,
    });
    const liveProjection = reduceSessionProjection(
      getChatSessionProjection(owner, [], initialScope),
      { type: "messagePersisted", message: liveUser, scope: initialScope },
    );
    const runningProjection = reduceSessionProjection(liveProjection, {
      type: "runDelta",
      runId: "obsolete-run",
      scope: initialScope,
    });
    setChatSessionProjection(owner, runningProjection);
    const learnedScope = {
      ...initialScope,
      sessionId: "learned-session",
      activeLeafEntryId: "learned-leaf",
    };
    expect(getChatSessionProjection(owner, [liveUser], learnedScope).runs).toHaveProperty(
      "obsolete-run",
    );

    const nextProjection = getChatSessionProjection(owner, [], {
      ...learnedScope,
      activeLeafEntryId: "next-leaf",
    });

    expect(nextProjection.messages).toEqual([]);
    expect(nextProjection.runs).toEqual({});
    expect(nextProjection.scope.activeLeafEntryId).toBe("next-leaf");
  });

  it("binds an explicitly unbranched transcript before a later branch is selected", () => {
    const owner = {};
    const initialScope = { sessionKey: "agent:main:shared" };
    const liveUser = createHistoryMessage("user", "unbranched live turn", {
      id: "unbranched-user",
      seq: 1,
    });
    const liveProjection = reduceSessionProjection(
      getChatSessionProjection(owner, [], initialScope),
      { type: "messagePersisted", message: liveUser, scope: initialScope },
    );
    setChatSessionProjection(owner, liveProjection);
    const unbranchedScope = { ...initialScope, activeLeafEntryId: null };

    expect(getChatSessionProjection(owner, [liveUser], unbranchedScope).scope).toEqual(
      unbranchedScope,
    );
    expect(
      getChatSessionProjection(owner, [], {
        ...initialScope,
        activeLeafEntryId: "selected-leaf",
      }).messages,
    ).toEqual([]);
  });

  it("discards a previous session projection when a pane changes session", () => {
    const owner = {};
    const previousScope = { sessionKey: "agent:main:previous", sessionId: "previous-session" };
    const previousUser = createHistoryMessage("user", "previous session", {
      id: "previous-user",
      seq: 1,
    });
    const previousProjection = reduceSessionProjection(
      getChatSessionProjection(owner, [], previousScope),
      { type: "messagePersisted", message: previousUser, scope: previousScope },
    );
    setChatSessionProjection(owner, previousProjection);

    const nextScope = { sessionKey: "agent:main:next", sessionId: "next-session" };
    expect(getChatSessionProjection(owner, [], nextScope).messages).toEqual([]);
  });

  it("discards obsolete live messages when the active transcript branch changes", () => {
    const owner = {};
    const previousScope = {
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
      activeLeafEntryId: "previous-leaf",
    };
    const previousUser = createHistoryMessage("user", "removed branch", {
      id: "removed-user",
      seq: 1,
    });
    const previousProjection = reduceSessionProjection(
      getChatSessionProjection(owner, [], previousScope),
      { type: "messagePersisted", message: previousUser, scope: previousScope },
    );
    setChatSessionProjection(owner, previousProjection);

    expect(
      getChatSessionProjection(owner, [], {
        ...previousScope,
        activeLeafEntryId: "current-leaf",
      }).messages,
    ).toEqual([]);
  });

  it("discards obsolete live messages when the active transcript branch is cleared", () => {
    const owner = {};
    const previousScope = {
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
      activeLeafEntryId: "previous-leaf",
    };
    const previousUser = createHistoryMessage("user", "removed branch", {
      id: "removed-user",
      seq: 1,
    });
    const previousProjection = reduceSessionProjection(
      getChatSessionProjection(owner, [], previousScope),
      { type: "messagePersisted", message: previousUser, scope: previousScope },
    );
    setChatSessionProjection(owner, previousProjection);

    expect(
      getChatSessionProjection(owner, [], {
        ...previousScope,
        activeLeafEntryId: null,
      }).messages,
    ).toEqual([]);
  });

  it("keeps a pane's live projection when a consumer omits its optional branch scope", () => {
    const owner = {};
    const scope = {
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
      activeLeafEntryId: "current-leaf",
    };
    const liveUser = createHistoryMessage("user", "same branch", {
      id: "live-user",
      seq: 1,
    });
    const projection = reduceSessionProjection(getChatSessionProjection(owner, [], scope), {
      type: "messagePersisted",
      message: liveUser,
      scope,
    });
    setChatSessionProjection(owner, projection);

    expect(
      getChatSessionProjection(owner, [liveUser], {
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
      }),
    ).toBe(projection);
  });

  it("adopts a later pending send after its pane projection already exists", () => {
    const owner = {};
    const scope = { sessionKey: "agent:main:shared", sessionId: "shared-session" };
    const firstUser = createHistoryMessage("user", "first persisted prompt", {
      id: "first-user",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    getChatSessionProjection(owner, [firstUser], scope);

    const pendingSecondUser = createHistoryMessage("user", "second prompt", {
      idempotencyKey: "second-run:user",
    });
    const pendingProjection = getChatSessionProjection(
      owner,
      [firstUser, pendingSecondUser],
      scope,
    );
    expect(pendingProjection.entries[0]?.pending).toBe(false);
    expect(pendingProjection.entries[1]).toMatchObject({
      pending: true,
      pendingRunId: "second-run",
    });

    const authoritativeSecondUser = createHistoryMessage("user", "second prompt", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    const persistedProjection = reduceSessionProjection(pendingProjection, {
      type: "messagePersisted",
      message: authoritativeSecondUser,
      scope,
    });

    expect(persistedProjection.messages).toEqual([firstUser, authoritativeSecondUser]);
    expect(persistedProjection.entries[1]).toMatchObject({
      pending: false,
      identity: { id: "second-user", runId: "second-run" },
    });
  });

  it("does not classify later canonical history messages as pending sends", () => {
    const owner = {};
    const scope = { sessionKey: "agent:main:shared", sessionId: "shared-session" };
    const firstUser = createHistoryMessage("user", "first persisted prompt", {
      id: "first-user",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const secondUser = createHistoryMessage("user", "second persisted prompt", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    getChatSessionProjection(owner, [firstUser], scope);

    const projection = getChatSessionProjection(owner, [firstUser, secondUser], scope);

    expect(projection.messages).toEqual([firstUser, secondUser]);
    expect(projection.entries.map((entry) => entry.pending)).toEqual([false, false]);
  });

  it("adopts an attachment-only pending turn through canonical run identity", () => {
    const owner = {};
    const scope = { sessionKey: "agent:main:shared", sessionId: "shared-session" };
    const pendingUser = {
      role: "user",
      content: "",
      __openclaw: { idempotencyKey: "attachment-run:user" },
    };
    const authoritativeUser = {
      role: "user",
      content: "",
      __openclaw: {
        id: "attachment-user",
        idempotencyKey: "attachment-run:user",
        seq: 4,
        media: [{ mimeType: "application/pdf", fileName: "brief.pdf" }],
      },
    };

    const projection = reduceSessionProjection(
      getChatSessionProjection(owner, [pendingUser], scope),
      { type: "messagePersisted", message: authoritativeUser, scope },
    );

    expect(projection.messages).toEqual([authoritativeUser]);
  });

  it("keeps same-text peer turns with distinct canonical message identities", () => {
    const scope = { sessionKey: "agent:main:shared" };
    const first = createHistoryMessage("user", "continue", {
      id: "first-peer-user",
      idempotencyKey: "first-peer:user",
      seq: 1,
    });
    const second = createHistoryMessage("user", "continue", {
      id: "second-peer-user",
      idempotencyKey: "second-peer:user",
      seq: 2,
    });
    const firstProjection = reduceSessionProjection(getChatSessionProjection({}, [], scope), {
      type: "messagePersisted",
      message: first,
      scope,
    });
    const projection = reduceSessionProjection(firstProjection, {
      type: "messagePersisted",
      message: second,
      scope,
    });

    expect(projection.messages).toEqual([first, second]);
  });

  it("keeps persisted identity and ordering ahead of misleading event envelopes", () => {
    const canonicalUser = createHistoryMessage("user", "canonical prompt", {
      id: "persisted-user",
      seq: 3,
    });
    const projection = reduceSessionProjection(getChatSessionProjection({}, []), {
      type: "messagePersisted",
      message: canonicalUser,
      envelope: { messageId: "misleading-envelope", messageSeq: 90 },
    });

    expect(projection.entries[0]?.identity).toMatchObject({ id: "persisted-user", sequence: 3 });
    expect(readTranscriptSequence(canonicalUser)).toBe(3);
  });

  it("retains transcript sequences for role-less status and history markers", () => {
    const marker = {
      content: [{ type: "status", value: "transcript marker" }],
      __openclaw: { id: "history-marker", seq: 7 },
    };

    expect(readTranscriptSequence(marker)).toBe(7);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe persisted transcript sequence %s",
    (sequence) => {
      expect(
        readTranscriptSequence(createHistoryMessage("user", "prompt", { seq: sequence })),
      ).toBe(null);
    },
  );
});

describe("preserveLiveAuthoritativeUserMessages", () => {
  it("keeps a gateway-projected user ahead of a later stale-history reply", () => {
    const liveUser = createHistoryMessage("user", "shared prompt", {
      id: "shared-user",
      seq: 1,
    });
    const reply = createHistoryMessage("assistant", "shared reply", {
      id: "shared-reply",
      seq: 2,
    });
    rememberLiveAuthoritativeUserMessage(liveUser);

    expect(preserveLiveAuthoritativeUserMessages([reply], [liveUser, reply])).toEqual([
      liveUser,
      reply,
    ]);
  });

  it("adopts the history projection without duplicating an authoritative user identity", () => {
    const liveUser = createHistoryMessage("user", "live prompt", {
      id: "shared-user",
      seq: 1,
    });
    const persistedUser = createHistoryMessage("user", "persisted prompt", {
      id: "shared-user",
      seq: 1,
    });
    rememberLiveAuthoritativeUserMessage(liveUser);

    expect(preserveLiveAuthoritativeUserMessages([persistedUser], [liveUser])).toEqual([
      persistedUser,
    ]);
  });

  it("does not revive an ordinary historical user absent from a new snapshot", () => {
    const previousUser = createHistoryMessage("user", "removed prompt", {
      id: "removed-user",
      seq: 1,
    });
    const reply = createHistoryMessage("assistant", "remaining reply", {
      id: "remaining-reply",
      seq: 2,
    });

    expect(preserveLiveAuthoritativeUserMessages([reply], [previousUser, reply])).toEqual([reply]);
  });

  it("uses the next authoritative row to place an id-only live prompt", () => {
    const liveUser = createHistoryMessage("user", "shared prompt", { id: "shared-user" });
    const reply = createHistoryMessage("assistant", "shared reply", { id: "shared-reply" });
    rememberLiveAuthoritativeUserMessage(liveUser);

    expect(preserveLiveAuthoritativeUserMessages([reply], [liveUser, reply])).toEqual([
      liveUser,
      reply,
    ]);
  });

  it("does not restore a gateway message hidden from the selected transcript", () => {
    const liveUser = createHistoryMessage("user", "hidden prompt", {
      id: "hidden-user",
      seq: 1,
    });
    rememberLiveAuthoritativeUserMessage(liveUser);

    expect(preserveLiveAuthoritativeUserMessages([], [liveUser], () => true)).toEqual([]);
  });
});

describe("preserveOptimisticTailMessages", () => {
  it("keeps optimistic tail messages while history is stale", () => {
    const persistedUser = createHistoryMessage("user", "first", { seq: 1 });
    const optimisticUser = createHistoryMessage("user", "latest ask", undefined, 10);
    const optimisticAssistant = createHistoryMessage("assistant", "latest answer", undefined, 11);

    expect(
      preserveOptimisticTailMessages(
        [persistedUser],
        [persistedUser, optimisticUser, optimisticAssistant],
      ),
    ).toEqual([persistedUser, optimisticUser, optimisticAssistant]);
  });

  it("keeps a new same-text user turn while history still ends at the earlier turn", () => {
    const persistedUser = createHistoryMessage(
      "user",
      "continue",
      {
        id: "first-user-message",
        idempotencyKey: "first-run:user",
        seq: 1,
      },
      10,
    );
    const optimisticUser = createHistoryMessage(
      "user",
      "continue",
      { idempotencyKey: "second-run:user" },
      20,
    );

    expect(
      preserveOptimisticTailMessages([persistedUser], [persistedUser, optimisticUser]),
    ).toEqual([persistedUser, optimisticUser]);
  });

  it("finds an earlier authoritative duplicate before preserving a distinct pending turn", () => {
    const firstRepeatedUser = createHistoryMessage("user", "continue", { seq: 1 });
    const secondRepeatedUser = createHistoryMessage("user", "continue", { seq: 2 });
    const optimisticUser = createHistoryMessage("user", "a distinct pending turn", {
      idempotencyKey: "third-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [firstRepeatedUser, secondRepeatedUser],
        [firstRepeatedUser, optimisticUser],
      ),
    ).toEqual([firstRepeatedUser, secondRepeatedUser, optimisticUser]);
  });

  it("does not revive an unmatched pending turn beyond unrelated authoritative history", () => {
    const sharedUser = createHistoryMessage("user", "shared earlier turn", {
      id: "shared-user",
      seq: 1,
    });
    const laterUser = createHistoryMessage("user", "different authoritative turn", {
      id: "later-user",
      seq: 2,
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([sharedUser, laterUser], [sharedUser, optimisticUser]),
    ).toEqual([sharedUser, laterUser]);
  });

  it("does not anchor a native transcript to a colliding imported source-local id", () => {
    const nativeUser = createHistoryMessage("user", "native transcript", { id: "source-local-id" });
    const importedUser = createHistoryMessage("user", "imported transcript", {
      id: "source-local-id",
      externalId: "source-local-id",
      importedFrom: "claude-cli",
      cliSessionId: "imported-session",
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([nativeUser, importedUser], [nativeUser, optimisticUser]),
    ).toEqual([nativeUser, importedUser]);
  });

  it("does not invent an imported source identity from an incomplete source tuple", () => {
    const firstImportedUser = createHistoryMessage("user", "repeated imported turn", {
      id: "source-local-id",
      externalId: "source-local-id",
      importedFrom: "claude-cli",
    });
    const secondImportedUser = createHistoryMessage("user", "repeated imported turn", {
      id: "source-local-id",
      externalId: "source-local-id",
      importedFrom: "claude-cli",
    });
    const previousImportedUser = createHistoryMessage("user", "repeated imported turn", {
      id: "source-local-id",
      externalId: "source-local-id",
      importedFrom: "claude-cli",
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [firstImportedUser, secondImportedUser],
        [previousImportedUser, optimisticUser],
      ),
    ).toEqual([firstImportedUser, secondImportedUser]);
  });

  it("does not substitute a different same-sequence projection for a missing canonical id", () => {
    const unrelatedProjection = createHistoryMessage("user", "different sequence projection", {
      seq: 7,
    });
    const previousProjection = createHistoryMessage("user", "original sequence projection", {
      id: "missing-canonical-id",
      seq: 7,
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([unrelatedProjection], [previousProjection, optimisticUser]),
    ).toEqual([unrelatedProjection]);
  });

  it("keeps import provenance without an external id out of native identity", () => {
    const nativeUser = createHistoryMessage("user", "native transcript", { id: "source-local-id" });
    const importedUser = createHistoryMessage("user", "imported transcript", {
      id: "source-local-id",
      importedFrom: "claude-cli",
      cliSessionId: "imported-session",
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([nativeUser, importedUser], [nativeUser, optimisticUser]),
    ).toEqual([nativeUser, importedUser]);
  });

  it("does not use display text as authority for an incomplete imported identity", () => {
    const previousImportedUser = createHistoryMessage("user", "repeated imported turn", {
      externalId: "first-import",
      importedFrom: "claude-cli",
    });
    const otherImportedUser = createHistoryMessage("user", "repeated imported turn", {
      externalId: "different-import",
      importedFrom: "claude-cli",
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([otherImportedUser], [previousImportedUser, optimisticUser]),
    ).toEqual([otherImportedUser]);
  });

  it("does not discard a canonical id when a sequence has the same visible text", () => {
    const unrelatedProjection = createHistoryMessage("user", "repeated projection", { seq: 7 });
    const previousProjection = createHistoryMessage("user", "repeated projection", {
      id: "missing-canonical-id",
      seq: 7,
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([unrelatedProjection], [previousProjection, optimisticUser]),
    ).toEqual([unrelatedProjection]);
  });

  it("does not revive an identity-free tail past a distinct same-text history turn", () => {
    const firstUser = createHistoryMessage("user", "continue", { id: "first-user", seq: 1 });
    const secondUser = createHistoryMessage("user", "continue", { id: "second-user", seq: 2 });
    const identityFreeTail = createHistoryMessage("user", "identity-free pending turn");

    expect(
      preserveOptimisticTailMessages([firstUser, secondUser], [firstUser, identityFreeTail]),
    ).toEqual([firstUser, secondUser]);
  });

  it("does not display-match a native legacy row to an imported transcript", () => {
    const previousNativeUser = createHistoryMessage("user", "same visible turn", {
      senderId: "native-user",
    });
    const importedUser = createHistoryMessage("user", "same visible turn", {
      externalId: "external-user",
      importedFrom: "claude-cli",
      cliSessionId: "external-session",
    });
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([importedUser], [previousNativeUser, optimisticUser]),
    ).toEqual([importedUser]);
  });

  it("does not replay a send that history already persisted before its current anchor", () => {
    const persistedUser = createHistoryMessage("user", "already persisted prompt", {
      id: "persisted-user",
      seq: 1,
      idempotencyKey: "persisted-run:user",
    });
    const persistedAssistant = createHistoryMessage("assistant", "already persisted answer", {
      id: "persisted-assistant",
      seq: 2,
    });
    const staleOptimisticUser = createHistoryMessage("user", "already persisted prompt", {
      idempotencyKey: "persisted-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistant],
        [persistedUser, persistedAssistant, staleOptimisticUser],
      ),
    ).toEqual([persistedUser, persistedAssistant]);
  });

  it("does not cross visible history markers with no display signature", () => {
    const firstMarker = {
      content: [{ type: "status", value: "first marker" }],
      __openclaw: { id: "first-marker", seq: 1 },
    };
    const laterMarker = {
      content: [{ type: "status", value: "different marker" }],
      __openclaw: { id: "later-marker", seq: 2 },
    };
    const optimisticUser = createHistoryMessage("user", "unmatched pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([firstMarker, laterMarker], [firstMarker, optimisticUser]),
    ).toEqual([firstMarker, laterMarker]);
  });

  it("does not duplicate a repeated turn whose persisted row has no send identity", () => {
    const firstUser = createHistoryMessage("user", "continue", { id: "first-user", seq: 1 });
    const persistedRepeatedUser = createHistoryMessage("user", "continue", {
      id: "persisted-repeated-user",
      seq: 2,
    });
    const optimisticRepeatedUser = createHistoryMessage("user", "continue", {
      idempotencyKey: "repeated-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [firstUser, persistedRepeatedUser],
        [firstUser, optimisticRepeatedUser],
      ),
    ).toEqual([firstUser, persistedRepeatedUser]);
  });

  it("does not replay an assistant tail after consuming its already-persisted user", () => {
    const persistedUser = createHistoryMessage("user", "already persisted prompt", {
      id: "persisted-user",
      seq: 1,
      idempotencyKey: "persisted-run:user",
    });
    const persistedAssistant = createHistoryMessage("assistant", "already persisted answer", {
      id: "persisted-assistant",
      seq: 2,
    });
    const staleOptimisticUser = createHistoryMessage("user", "already persisted prompt", {
      idempotencyKey: "persisted-run:user",
    });
    const staleOptimisticAssistant = createHistoryMessage("assistant", "stale streamed assistant");

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistant],
        [persistedUser, persistedAssistant, staleOptimisticUser, staleOptimisticAssistant],
      ),
    ).toEqual([persistedUser, persistedAssistant]);
  });

  it("preserves a distinct keyed repeated turn after an anchor with different text", () => {
    const setupUser = createHistoryMessage("user", "setup", {
      id: "setup-user",
      seq: 1,
      idempotencyKey: "setup-run:user",
    });
    const secondUser = createHistoryMessage("user", "continue", {
      id: "second-user",
      seq: 2,
      idempotencyKey: "second-run:user",
    });
    const thirdUser = createHistoryMessage("user", "continue", {
      idempotencyKey: "third-run:user",
    });

    expect(preserveOptimisticTailMessages([setupUser, secondUser], [setupUser, thirdUser])).toEqual(
      [setupUser, secondUser, thirdUser],
    );
  });

  it("anchors an updated display projection by its authoritative transcript id", () => {
    const previousUser = createHistoryMessage("user", "original projection", {
      id: "persisted-user",
      seq: 3,
    });
    const authoritativeUser = createHistoryMessage("user", "updated projection", {
      id: "persisted-user",
      seq: 3,
    });
    const optimisticUser = createHistoryMessage("user", "still pending", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([authoritativeUser], [previousUser, optimisticUser]),
    ).toEqual([authoritativeUser, optimisticUser]);
  });

  it("distinguishes same-sequence projections by their authoritative transcript ids", () => {
    const firstProjection = createHistoryMessage("user", "continue", {
      id: "first-projection",
      seq: 7,
    });
    const persistedSecondProjection = createHistoryMessage("user", "continue", {
      id: "second-projection",
      idempotencyKey: "second-run:user",
      seq: 7,
    });
    const optimisticSecondProjection = createHistoryMessage("user", "continue", {
      idempotencyKey: "second-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [firstProjection, persistedSecondProjection],
        [firstProjection, optimisticSecondProjection],
      ),
    ).toEqual([firstProjection, persistedSecondProjection]);
  });

  it("keeps transcript projections with the same entry identity in their own roles", () => {
    const persistedUser = createHistoryMessage("user", "show the source reply", {
      id: "shared-transcript-entry",
      seq: 7,
    });
    const persistedAssistantMirror = createHistoryMessage("assistant", "source reply", {
      id: "shared-transcript-entry",
      seq: 7,
    });
    const optimisticAssistant = createHistoryMessage("assistant", "source reply");

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistantMirror],
        [persistedUser, optimisticAssistant],
      ),
    ).toEqual([persistedUser, persistedAssistantMirror]);
  });

  it("scopes imported external identities to their provider and CLI session", () => {
    const firstImportedUser = createHistoryMessage("user", "continue", {
      id: "shared-external-id",
      externalId: "shared-external-id",
      importedFrom: "claude-cli",
      cliSessionId: "first-session",
    });
    const secondImportedUser = createHistoryMessage("user", "continue", {
      id: "shared-external-id",
      externalId: "shared-external-id",
      importedFrom: "claude-cli",
      cliSessionId: "second-session",
    });
    const optimisticSecondUser = createHistoryMessage("user", "continue");

    expect(
      preserveOptimisticTailMessages(
        [firstImportedUser, secondImportedUser],
        [firstImportedUser, optimisticSecondUser],
      ),
    ).toEqual([firstImportedUser, secondImportedUser]);
  });

  it("anchors updated imported messages by their source-scoped external identity", () => {
    const metadata = {
      id: "external-user",
      externalId: "external-user",
      importedFrom: "claude-cli",
      cliSessionId: "cli-session",
    };
    const previousImportedUser = createHistoryMessage("user", "original imported text", metadata);
    const authoritativeImportedUser = createHistoryMessage("user", "updated imported text", {
      ...metadata,
    });
    const optimisticUser = createHistoryMessage("user", "pending after import", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [authoritativeImportedUser],
        [previousImportedUser, optimisticUser],
      ),
    ).toEqual([authoritativeImportedUser, optimisticUser]);
  });

  it("does not guess between repeated history rows without authoritative identity", () => {
    const firstLegacyUser = createHistoryMessage("user", "continue", { senderId: "alice" });
    const secondLegacyUser = createHistoryMessage("user", "continue", { senderId: "alice" });
    const previousLegacyUser = createHistoryMessage("user", "continue", { senderId: "alice" });
    const optimisticUser = createHistoryMessage("user", "unproven pending turn", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [firstLegacyUser, secondLegacyUser],
        [previousLegacyUser, optimisticUser],
      ),
    ).toEqual([firstLegacyUser, secondLegacyUser]);
  });

  it("uses an unambiguous display match when transcript identity is unavailable", () => {
    const previousLegacyUser = createHistoryMessage("user", "unique legacy message", {
      senderId: "alice",
    });
    const authoritativeLegacyUser = createHistoryMessage("user", "unique legacy message", {
      senderId: "alice",
    });
    const optimisticUser = createHistoryMessage("user", "pending after legacy history", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages(
        [authoritativeLegacyUser],
        [previousLegacyUser, optimisticUser],
      ),
    ).toEqual([authoritativeLegacyUser, optimisticUser]);
  });

  it("preserves a repeated optimistic prompt distinguished by its send identity", () => {
    const firstUser = createHistoryMessage("user", "continue", {
      id: "first-user",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const secondUser = createHistoryMessage("user", "continue", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    const optimisticThirdUser = createHistoryMessage("user", "continue", {
      idempotencyKey: "third-run:user",
    });

    expect(
      preserveOptimisticTailMessages([firstUser, secondUser], [firstUser, optimisticThirdUser]),
    ).toEqual([firstUser, secondUser, optimisticThirdUser]);
  });

  it("does not revive a pending tail from an unrelated older history snapshot", () => {
    const olderHistoryUser = createHistoryMessage("user", "older snapshot", {
      id: "older-user",
      seq: 1,
    });
    const currentHistoryUser = createHistoryMessage("user", "current snapshot", {
      id: "current-user",
      seq: 2,
    });
    const optimisticUser = createHistoryMessage("user", "pending on the current snapshot", {
      idempotencyKey: "pending-run:user",
    });

    expect(
      preserveOptimisticTailMessages([olderHistoryUser], [currentHistoryUser, optimisticUser]),
    ).toEqual([olderHistoryUser]);
  });

  it("never preserves a hidden optimistic tail", () => {
    const persistedUser = createHistoryMessage("user", "visible prompt", {
      id: "visible-user",
      seq: 1,
    });
    const hiddenAssistant = createHistoryMessage("assistant", "NO_REPLY");

    expect(
      preserveOptimisticTailMessages(
        [persistedUser],
        [persistedUser, hiddenAssistant],
        (message) => message === hiddenAssistant,
      ),
    ).toEqual([persistedUser]);
  });

  it("keeps a repeated user turn after the previous persisted assistant reply", () => {
    const persistedUser = createHistoryMessage("user", "continue", {
      id: "first-user-message",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const persistedAssistant = createHistoryMessage("assistant", "first answer", {
      id: "first-assistant-message",
      seq: 2,
    });
    const optimisticUser = createHistoryMessage(
      "user",
      "continue",
      { idempotencyKey: "second-run:user" },
      20,
    );

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistant],
        [persistedUser, persistedAssistant, optimisticUser],
      ),
    ).toEqual([persistedUser, persistedAssistant, optimisticUser]);
  });

  it("does not duplicate a repeated user turn after its own history entry arrives", () => {
    const persistedFirstUser = createHistoryMessage("user", "continue", {
      id: "first-user-message",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const optimisticSecondUser = createHistoryMessage(
      "user",
      "continue",
      { idempotencyKey: "second-run:user" },
      20,
    );
    const persistedSecondUser = createHistoryMessage(
      "user",
      "continue",
      {
        id: "second-user-message",
        idempotencyKey: "second-run:user",
        seq: 2,
      },
      20,
    );

    expect(
      preserveOptimisticTailMessages(
        [persistedFirstUser, persistedSecondUser],
        [persistedFirstUser, optimisticSecondUser],
      ),
    ).toEqual([persistedFirstUser, persistedSecondUser]);
  });

  it("drops streamed assistant tail when final history has caught up past the shared user", () => {
    const persistedUser = createHistoryMessage("user", "latest ask", { seq: 1 });
    const streamedAssistant = createHistoryMessage(
      "assistant",
      "partial streamed answer",
      undefined,
      10,
    );
    const historyAssistant = createHistoryMessage("assistant", "complete persisted answer", {
      seq: 2,
    });

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, historyAssistant],
        [persistedUser, streamedAssistant],
      ),
    ).toEqual([persistedUser, historyAssistant]);
  });

  it("keeps an idempotency-marked queued turn while history is stale", () => {
    const persistedUser = createHistoryMessage("user", "first", { seq: 1 });
    const materializedQueuedUser = createHistoryMessage(
      "user",
      "steered follow-up",
      { idempotencyKey: "steer-run:user" },
      10,
    );

    expect(
      preserveOptimisticTailMessages([persistedUser], [persistedUser, materializedQueuedUser]),
    ).toEqual([persistedUser, materializedQueuedUser]);
  });
});
