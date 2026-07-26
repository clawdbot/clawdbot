// @vitest-environment node
// Control UI tests cover history merge behavior.
import { describe, expect, it } from "vitest";
import { preserveOptimisticTailMessages } from "./history-merge.ts";

describe("preserveOptimisticTailMessages", () => {
  it("keeps optimistic tail messages while history is stale", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      __openclaw: { seq: 1 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      timestamp: 10,
    };
    const optimisticAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "latest answer" }],
      timestamp: 11,
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser],
        [persistedUser, optimisticUser, optimisticAssistant],
      ),
    ).toEqual([persistedUser, optimisticUser, optimisticAssistant]);
  });

  it("keeps a new same-text user turn while history still ends at the earlier turn", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 10,
      __openclaw: {
        id: "first-user-message",
        idempotencyKey: "first-run:user",
        seq: 1,
      },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: { idempotencyKey: "second-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([persistedUser], [persistedUser, optimisticUser]),
    ).toEqual([persistedUser, optimisticUser]);
  });

  it("finds an earlier authoritative duplicate before preserving a distinct pending turn", () => {
    const firstRepeatedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { seq: 1 },
    };
    const secondRepeatedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { seq: 2 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "a distinct pending turn" }],
      __openclaw: { idempotencyKey: "third-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [firstRepeatedUser, secondRepeatedUser],
        [firstRepeatedUser, optimisticUser],
      ),
    ).toEqual([firstRepeatedUser, secondRepeatedUser, optimisticUser]);
  });

  it("does not revive an unmatched pending turn beyond unrelated authoritative history", () => {
    const sharedUser = {
      role: "user",
      content: [{ type: "text", text: "shared earlier turn" }],
      __openclaw: { id: "shared-user", seq: 1 },
    };
    const laterUser = {
      role: "user",
      content: [{ type: "text", text: "different authoritative turn" }],
      __openclaw: { id: "later-user", seq: 2 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([sharedUser, laterUser], [sharedUser, optimisticUser]),
    ).toEqual([sharedUser, laterUser]);
  });

  it("does not anchor a native transcript to a colliding imported source-local id", () => {
    const nativeUser = {
      role: "user",
      content: [{ type: "text", text: "native transcript" }],
      __openclaw: { id: "source-local-id" },
    };
    const importedUser = {
      role: "user",
      content: [{ type: "text", text: "imported transcript" }],
      __openclaw: {
        id: "source-local-id",
        externalId: "source-local-id",
        importedFrom: "claude-cli",
        cliSessionId: "imported-session",
      },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([nativeUser, importedUser], [nativeUser, optimisticUser]),
    ).toEqual([nativeUser, importedUser]);
  });

  it("does not invent an imported source identity from an incomplete source tuple", () => {
    const firstImportedUser = {
      role: "user",
      content: [{ type: "text", text: "repeated imported turn" }],
      __openclaw: {
        id: "source-local-id",
        externalId: "source-local-id",
        importedFrom: "claude-cli",
      },
    };
    const secondImportedUser = {
      role: "user",
      content: [{ type: "text", text: "repeated imported turn" }],
      __openclaw: {
        id: "source-local-id",
        externalId: "source-local-id",
        importedFrom: "claude-cli",
      },
    };
    const previousImportedUser = {
      role: "user",
      content: [{ type: "text", text: "repeated imported turn" }],
      __openclaw: {
        id: "source-local-id",
        externalId: "source-local-id",
        importedFrom: "claude-cli",
      },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [firstImportedUser, secondImportedUser],
        [previousImportedUser, optimisticUser],
      ),
    ).toEqual([firstImportedUser, secondImportedUser]);
  });

  it("does not substitute a different same-sequence projection for a missing canonical id", () => {
    const unrelatedProjection = {
      role: "user",
      content: [{ type: "text", text: "different sequence projection" }],
      __openclaw: { seq: 7 },
    };
    const previousProjection = {
      role: "user",
      content: [{ type: "text", text: "original sequence projection" }],
      __openclaw: { id: "missing-canonical-id", seq: 7 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([unrelatedProjection], [previousProjection, optimisticUser]),
    ).toEqual([unrelatedProjection]);
  });

  it("keeps import provenance without an external id out of native identity", () => {
    const nativeUser = {
      role: "user",
      content: [{ type: "text", text: "native transcript" }],
      __openclaw: { id: "source-local-id" },
    };
    const importedUser = {
      role: "user",
      content: [{ type: "text", text: "imported transcript" }],
      __openclaw: {
        id: "source-local-id",
        importedFrom: "claude-cli",
        cliSessionId: "imported-session",
      },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([nativeUser, importedUser], [nativeUser, optimisticUser]),
    ).toEqual([nativeUser, importedUser]);
  });

  it("does not use display text as authority for an incomplete imported identity", () => {
    const previousImportedUser = {
      role: "user",
      content: [{ type: "text", text: "repeated imported turn" }],
      __openclaw: { externalId: "first-import", importedFrom: "claude-cli" },
    };
    const otherImportedUser = {
      role: "user",
      content: [{ type: "text", text: "repeated imported turn" }],
      __openclaw: { externalId: "different-import", importedFrom: "claude-cli" },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([otherImportedUser], [previousImportedUser, optimisticUser]),
    ).toEqual([otherImportedUser]);
  });

  it("does not discard a canonical id when a sequence has the same visible text", () => {
    const unrelatedProjection = {
      role: "user",
      content: [{ type: "text", text: "repeated projection" }],
      __openclaw: { seq: 7 },
    };
    const previousProjection = {
      role: "user",
      content: [{ type: "text", text: "repeated projection" }],
      __openclaw: { id: "missing-canonical-id", seq: 7 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([unrelatedProjection], [previousProjection, optimisticUser]),
    ).toEqual([unrelatedProjection]);
  });

  it("does not revive an identity-free tail past a distinct same-text history turn", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "first-user", seq: 1 },
    };
    const secondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "second-user", seq: 2 },
    };
    const identityFreeTail = {
      role: "user",
      content: [{ type: "text", text: "identity-free pending turn" }],
    };

    expect(
      preserveOptimisticTailMessages([firstUser, secondUser], [firstUser, identityFreeTail]),
    ).toEqual([firstUser, secondUser]);
  });

  it("does not display-match a native legacy row to an imported transcript", () => {
    const previousNativeUser = {
      role: "user",
      content: [{ type: "text", text: "same visible turn" }],
      __openclaw: { senderId: "native-user" },
    };
    const importedUser = {
      role: "user",
      content: [{ type: "text", text: "same visible turn" }],
      __openclaw: {
        externalId: "external-user",
        importedFrom: "claude-cli",
        cliSessionId: "external-session",
      },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([importedUser], [previousNativeUser, optimisticUser]),
    ).toEqual([importedUser]);
  });

  it("does not replay a send that history already persisted before its current anchor", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "already persisted prompt" }],
      __openclaw: { id: "persisted-user", seq: 1, idempotencyKey: "persisted-run:user" },
    };
    const persistedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "already persisted answer" }],
      __openclaw: { id: "persisted-assistant", seq: 2 },
    };
    const staleOptimisticUser = {
      role: "user",
      content: [{ type: "text", text: "already persisted prompt" }],
      __openclaw: { idempotencyKey: "persisted-run:user" },
    };

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
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unmatched pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([firstMarker, laterMarker], [firstMarker, optimisticUser]),
    ).toEqual([firstMarker, laterMarker]);
  });

  it("does not duplicate a repeated turn whose persisted row has no send identity", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "first-user", seq: 1 },
    };
    const persistedRepeatedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "persisted-repeated-user", seq: 2 },
    };
    const optimisticRepeatedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { idempotencyKey: "repeated-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [firstUser, persistedRepeatedUser],
        [firstUser, optimisticRepeatedUser],
      ),
    ).toEqual([firstUser, persistedRepeatedUser]);
  });

  it("does not replay an assistant tail after consuming its already-persisted user", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "already persisted prompt" }],
      __openclaw: { id: "persisted-user", seq: 1, idempotencyKey: "persisted-run:user" },
    };
    const persistedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "already persisted answer" }],
      __openclaw: { id: "persisted-assistant", seq: 2 },
    };
    const staleOptimisticUser = {
      role: "user",
      content: [{ type: "text", text: "already persisted prompt" }],
      __openclaw: { idempotencyKey: "persisted-run:user" },
    };
    const staleOptimisticAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "stale streamed assistant" }],
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistant],
        [persistedUser, persistedAssistant, staleOptimisticUser, staleOptimisticAssistant],
      ),
    ).toEqual([persistedUser, persistedAssistant]);
  });

  it("preserves a distinct keyed repeated turn after an anchor with different text", () => {
    const setupUser = {
      role: "user",
      content: [{ type: "text", text: "setup" }],
      __openclaw: { id: "setup-user", seq: 1, idempotencyKey: "setup-run:user" },
    };
    const secondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "second-user", seq: 2, idempotencyKey: "second-run:user" },
    };
    const thirdUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { idempotencyKey: "third-run:user" },
    };

    expect(preserveOptimisticTailMessages([setupUser, secondUser], [setupUser, thirdUser])).toEqual(
      [setupUser, secondUser, thirdUser],
    );
  });

  it("anchors an updated display projection by its authoritative transcript id", () => {
    const previousUser = {
      role: "user",
      content: [{ type: "text", text: "original projection" }],
      __openclaw: { id: "persisted-user", seq: 3 },
    };
    const authoritativeUser = {
      role: "user",
      content: [{ type: "text", text: "updated projection" }],
      __openclaw: { id: "persisted-user", seq: 3 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "still pending" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([authoritativeUser], [previousUser, optimisticUser]),
    ).toEqual([authoritativeUser, optimisticUser]);
  });

  it("distinguishes same-sequence projections by their authoritative transcript ids", () => {
    const firstProjection = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "first-projection", seq: 7 },
    };
    const persistedSecondProjection = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: {
        id: "second-projection",
        idempotencyKey: "second-run:user",
        seq: 7,
      },
    };
    const optimisticSecondProjection = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { idempotencyKey: "second-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [firstProjection, persistedSecondProjection],
        [firstProjection, optimisticSecondProjection],
      ),
    ).toEqual([firstProjection, persistedSecondProjection]);
  });

  it("keeps transcript projections with the same entry identity in their own roles", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "show the source reply" }],
      __openclaw: { id: "shared-transcript-entry", seq: 7 },
    };
    const persistedAssistantMirror = {
      role: "assistant",
      content: [{ type: "text", text: "source reply" }],
      __openclaw: { id: "shared-transcript-entry", seq: 7 },
    };
    const optimisticAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "source reply" }],
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistantMirror],
        [persistedUser, optimisticAssistant],
      ),
    ).toEqual([persistedUser, persistedAssistantMirror]);
  });

  it("scopes imported external identities to their provider and CLI session", () => {
    const firstImportedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: {
        id: "shared-external-id",
        externalId: "shared-external-id",
        importedFrom: "claude-cli",
        cliSessionId: "first-session",
      },
    };
    const secondImportedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: {
        id: "shared-external-id",
        externalId: "shared-external-id",
        importedFrom: "claude-cli",
        cliSessionId: "second-session",
      },
    };
    const optimisticSecondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
    };

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
    const previousImportedUser = {
      role: "user",
      content: [{ type: "text", text: "original imported text" }],
      __openclaw: metadata,
    };
    const authoritativeImportedUser = {
      role: "user",
      content: [{ type: "text", text: "updated imported text" }],
      __openclaw: { ...metadata },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "pending after import" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [authoritativeImportedUser],
        [previousImportedUser, optimisticUser],
      ),
    ).toEqual([authoritativeImportedUser, optimisticUser]);
  });

  it("does not guess between repeated history rows without authoritative identity", () => {
    const firstLegacyUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { senderId: "alice" },
    };
    const secondLegacyUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { senderId: "alice" },
    };
    const previousLegacyUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { senderId: "alice" },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "unproven pending turn" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [firstLegacyUser, secondLegacyUser],
        [previousLegacyUser, optimisticUser],
      ),
    ).toEqual([firstLegacyUser, secondLegacyUser]);
  });

  it("uses an unambiguous display match when transcript identity is unavailable", () => {
    const previousLegacyUser = {
      role: "user",
      content: [{ type: "text", text: "unique legacy message" }],
      __openclaw: { senderId: "alice" },
    };
    const authoritativeLegacyUser = {
      role: "user",
      content: [{ type: "text", text: "unique legacy message" }],
      __openclaw: { senderId: "alice" },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "pending after legacy history" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [authoritativeLegacyUser],
        [previousLegacyUser, optimisticUser],
      ),
    ).toEqual([authoritativeLegacyUser, optimisticUser]);
  });

  it("preserves a repeated optimistic prompt distinguished by its send identity", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "first-user", idempotencyKey: "first-run:user", seq: 1 },
    };
    const secondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { id: "second-user", idempotencyKey: "second-run:user", seq: 2 },
    };
    const optimisticThirdUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: { idempotencyKey: "third-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([firstUser, secondUser], [firstUser, optimisticThirdUser]),
    ).toEqual([firstUser, secondUser, optimisticThirdUser]);
  });

  it("does not revive a pending tail from an unrelated older history snapshot", () => {
    const olderHistoryUser = {
      role: "user",
      content: [{ type: "text", text: "older snapshot" }],
      __openclaw: { id: "older-user", seq: 1 },
    };
    const currentHistoryUser = {
      role: "user",
      content: [{ type: "text", text: "current snapshot" }],
      __openclaw: { id: "current-user", seq: 2 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "pending on the current snapshot" }],
      __openclaw: { idempotencyKey: "pending-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([olderHistoryUser], [currentHistoryUser, optimisticUser]),
    ).toEqual([olderHistoryUser]);
  });

  it("never preserves a hidden optimistic tail", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "visible prompt" }],
      __openclaw: { id: "visible-user", seq: 1 },
    };
    const hiddenAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser],
        [persistedUser, hiddenAssistant],
        (message) => message === hiddenAssistant,
      ),
    ).toEqual([persistedUser]);
  });

  it("keeps a repeated user turn after the previous persisted assistant reply", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: {
        id: "first-user-message",
        idempotencyKey: "first-run:user",
        seq: 1,
      },
    };
    const persistedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      __openclaw: { id: "first-assistant-message", seq: 2 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: { idempotencyKey: "second-run:user" },
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, persistedAssistant],
        [persistedUser, persistedAssistant, optimisticUser],
      ),
    ).toEqual([persistedUser, persistedAssistant, optimisticUser]);
  });

  it("does not duplicate a repeated user turn after its own history entry arrives", () => {
    const persistedFirstUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      __openclaw: {
        id: "first-user-message",
        idempotencyKey: "first-run:user",
        seq: 1,
      },
    };
    const optimisticSecondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: { idempotencyKey: "second-run:user" },
    };
    const persistedSecondUser = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 20,
      __openclaw: {
        id: "second-user-message",
        idempotencyKey: "second-run:user",
        seq: 2,
      },
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedFirstUser, persistedSecondUser],
        [persistedFirstUser, optimisticSecondUser],
      ),
    ).toEqual([persistedFirstUser, persistedSecondUser]);
  });

  it("drops streamed assistant tail when final history has caught up past the shared user", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const streamedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial streamed answer" }],
      timestamp: 10,
    };
    const historyAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "complete persisted answer" }],
      __openclaw: { seq: 2 },
    };

    expect(
      preserveOptimisticTailMessages(
        [persistedUser, historyAssistant],
        [persistedUser, streamedAssistant],
      ),
    ).toEqual([persistedUser, historyAssistant]);
  });

  it("keeps an idempotency-marked queued turn while history is stale", () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      __openclaw: { seq: 1 },
    };
    const materializedQueuedUser = {
      role: "user",
      content: [{ type: "text", text: "steered follow-up" }],
      timestamp: 10,
      __openclaw: { idempotencyKey: "steer-run:user" },
    };

    expect(
      preserveOptimisticTailMessages([persistedUser], [persistedUser, materializedQueuedUser]),
    ).toEqual([persistedUser, materializedQueuedUser]);
  });
});
