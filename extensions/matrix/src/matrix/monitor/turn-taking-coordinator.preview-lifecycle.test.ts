import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseMarker,
  createMatrixTurnTakingCoordinator,
  getTurnTakingCoordinatorCompletionMocks,
  protocolEdit,
  protocolRoot,
  register,
  resetTurnTakingCoordinatorTestMocks,
} from "./turn-taking-coordinator.test-fixtures.js";

const completionMocks = getTurnTakingCoordinatorCompletionMocks();

beforeEach(resetTurnTakingCoordinatorTestMocks);

describe("Matrix turn-taking coordinator: preview lifecycle", () => {
  it("correlates sibling replies across reply-thread settings only for their recorded trigger", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const roomId = "!reply-routes:example.org";
    const getJoinedRoomMembers = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
    for (const accountId of ["alpha", "beta"]) {
      register(coordinator, {
        accountId,
        userId: `@${accountId}:example.org`,
        getJoinedRoomMembers,
      });
    }
    const query = {
      roomId,
      triggerEventId: "$trigger",
      afterSequence: 0,
      view: { includesContext: () => true },
    };
    for (const triggerEventId of ["$trigger", "$unrelated"]) {
      const marker = {
        ...baseMarker,
        triggerEventId,
        threadId: triggerEventId,
        responseId: triggerEventId,
      };
      const root = protocolRoot(
        marker,
        `${triggerEventId}-preview`,
        `answer for ${triggerEventId}`,
      );
      root.content["m.relates_to"] = { rel_type: "m.thread", event_id: triggerEventId };
      const preview = await coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId,
        accountId: "beta",
        event: root,
      });
      if (preview.kind !== "authorize") {
        throw new Error("expected threaded preview");
      }
      await coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: preview.observationId,
      });
    }
    expect(coordinator.readFreshness(query).entries.map((entry) => entry.body)).toEqual([
      "answer for $trigger",
    ]);
    const finalMarker = {
      ...baseMarker,
      responseId: "$trigger",
      threadId: "$trigger",
      state: "final" as const,
      partIndex: 0,
      partCount: 1,
    };
    const final = protocolRoot(finalMarker, "$standalone-final", "final answer for trigger");
    final.content["m.relates_to"] = { rel_type: "m.thread", event_id: "$trigger" };
    const promoted = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: final,
    });
    if (promoted.kind !== "promote") {
      throw new Error("expected threaded final");
    }
    await coordinator.authorizePreviewObservation({
      roomId,
      accountId: "beta",
      observationId: promoted.observationId,
    });
    const activity = coordinator.readFreshness(query).entries;
    expect(activity).toContainEqual(expect.objectContaining({ body: "final answer for trigger" }));
    expect(activity).not.toContainEqual(expect.objectContaining({ body: "answer for $unrelated" }));
    expect(
      coordinator.readFreshness({ ...query, view: { includesContext: () => false } }).entries,
    ).toEqual([]);
  });

  it("suppresses partials and promotes one authenticated final on the preview root", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const getJoinedRoomMembers = vi.fn(async () => [
      "@alpha:example.org",
      "@beta:example.org",
      "@gamma:example.org",
    ]);
    register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers,
    });
    register(coordinator, {
      accountId: "beta",
      userId: "@beta:example.org",
      getJoinedRoomMembers,
      getEvent: vi.fn(async () => protocolRoot()),
    });

    register(coordinator, {
      accountId: "gamma",
      userId: "@gamma:example.org",
      getJoinedRoomMembers,
    });
    const preview = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId: "!room:example.org",
      accountId: "beta",
      event: protocolRoot(),
    });
    expect(preview).toMatchObject({ kind: "authorize" });
    expect(
      coordinator.readFreshness({
        view: { includesContext: () => true },
        roomId: "!room:example.org",
        afterSequence: 0,
      }).entries,
    ).toEqual([]);
    if (preview.kind !== "authorize") {
      throw new Error("expected receiver-authorizable preview");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId: "!room:example.org",
        accountId: "beta",
        observationId: preview.observationId,
      }),
    ).resolves.toBe(true);
    expect(
      coordinator.readFreshness({
        view: { includesContext: () => true },
        roomId: "!room:example.org",
        afterSequence: 0,
      }).entries,
    ).toContainEqual(expect.objectContaining({ body: "partial", state: "in-progress" }));
    const sequence = coordinator.currentSequence();
    const siblingObservation = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId: "!room:example.org",
      accountId: "gamma",
      event: protocolRoot(),
    });
    expect(siblingObservation.kind).toBe("authorize");
    if (siblingObservation.kind !== "authorize") {
      throw new Error("expected second receiver observation");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId: "!room:example.org",
        accountId: "gamma",
        observationId: siblingObservation.observationId,
      }),
    ).resolves.toBe(true);
    expect(coordinator.currentSequence()).toBe(sequence);
    const finalMarker = { ...baseMarker, state: "final" as const, revision: 1 };
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "beta",
        event: protocolEdit(finalMarker, "$final", "complete answer"),
      }),
    ).resolves.toMatchObject({
      kind: "promote",
      event: {
        event_id: "$root",
        sender: "@alpha:example.org",
        __openclawTrustedEnhancedFinal: true,
        content: { body: "complete answer" },
      },
    });
  });

  it("keeps sender-side preview and standalone-final bodies out of decision-visible state", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
    register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers: joined,
    });
    register(coordinator, {
      accountId: "beta",
      userId: "@beta:example.org",
      getJoinedRoomMembers: joined,
    });
    completionMocks.complete.mockResolvedValue({
      text: JSON.stringify({
        decisions: [
          { accountId: "alpha", disposition: "neutral" },
          { accountId: "beta", disposition: "neutral" },
        ],
      }),
    });
    await coordinator.observeOutboundPreview({
      roomId: "!private-transport:example.org",
      originalEventId: "$private-preview",
      sourceEventId: "$private-preview",
      senderId: "@alpha:example.org",
      marker: { ...baseMarker, responseId: "private-preview" },
      body: "sender-only preview body",
    });
    await coordinator.observeOutboundStandaloneFinalPart({
      roomId: "!private-transport:example.org",
      sourceEventId: "$private-final",
      senderId: "@alpha:example.org",
      marker: {
        ...baseMarker,
        responseId: "private-final",
        state: "final",
        partIndex: 0,
        partCount: 1,
      },
      body: "sender-only final body",
    });

    expect(
      coordinator.readFreshness({
        view: { includesContext: () => true },
        roomId: "!private-transport:example.org",
        afterSequence: 0,
      }).entries,
    ).toEqual([]);
    expect(coordinator.currentSequence()).toBe(0);
    await coordinator.decideParticipation({
      cfg: {} as never,
      roomId: "!private-transport:example.org",
      eventId: "$human-trigger",
      senderId: "@human:example.org",
      body: "question",
      accountId: "beta",
    });
    const classifierCall = completionMocks.complete.mock.calls.at(-1)?.[0] as {
      context: { messages: Array<{ content: string }> };
    };
    const classifierData = JSON.parse(classifierCall.context.messages[0]?.content ?? "{}") as {
      untrustedRoomData?: {
        activeSiblingPreviews?: Array<{ body?: string }>;
        recentHistory?: Array<{ body?: string }>;
      };
    };
    expect(classifierData.untrustedRoomData?.activeSiblingPreviews).toEqual([]);
    const visibleHistory = classifierData.untrustedRoomData?.recentHistory?.map(
      (entry) => entry.body,
    );
    expect(visibleHistory).not.toContain("sender-only preview body");
    expect(visibleHistory).not.toContain("sender-only final body");
  });

  it("authorizes exact sender-first roots and updates while withholding a denied exact update", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
    register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers: joined,
    });
    register(coordinator, {
      accountId: "beta",
      userId: "@beta:example.org",
      getJoinedRoomMembers: joined,
    });
    const roomId = "!sender-first:example.org";
    const marker = { ...baseMarker, responseId: "sender-first" };

    await coordinator.observeOutboundPreview({
      roomId,
      originalEventId: "$sender-root",
      sourceEventId: "$sender-root",
      senderId: "@alpha:example.org",
      marker,
      body: "sender-first root",
    });
    const root = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolRoot(marker, "$sender-root", "sender-first root"),
    });
    expect(root.kind).toBe("authorize");
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toEqual([]);
    if (root.kind !== "authorize") {
      throw new Error("expected exact sender-first root authorization");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: root.observationId,
      }),
    ).resolves.toBe(true);
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toContainEqual(expect.objectContaining({ body: "sender-first root", state: "in-progress" }));

    const updateMarker = { ...marker, revision: 1 };
    await coordinator.observeOutboundPreview({
      roomId,
      originalEventId: "$sender-root",
      sourceEventId: "$sender-update",
      senderId: "@alpha:example.org",
      marker: updateMarker,
      body: "sender-first update",
    });
    const update = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolEdit(updateMarker, "$sender-update", "sender-first update", "$sender-root"),
    });
    expect(update.kind).toBe("authorize");
    expect(
      coordinator
        .readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries.map((entry) => entry.body),
    ).toEqual(["sender-first root"]);
    if (update.kind !== "authorize") {
      throw new Error("expected exact sender-first update authorization");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: update.observationId,
      }),
    ).resolves.toBe(true);
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toContainEqual(
      expect.objectContaining({ body: "sender-first update", state: "in-progress" }),
    );

    const deniedMarker = { ...marker, revision: 2 };
    await coordinator.observeOutboundPreview({
      roomId,
      originalEventId: "$sender-root",
      sourceEventId: "$sender-denied",
      senderId: "@alpha:example.org",
      marker: deniedMarker,
      body: "withheld sender-first update",
    });
    const deniedUpdate = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolEdit(
        deniedMarker,
        "$sender-denied",
        "withheld sender-first update",
        "$sender-root",
      ),
    });
    expect(deniedUpdate.kind).toBe("authorize");
    const visibleBodies = coordinator
      .readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
      .entries.map((entry) => entry.body);
    expect(visibleBodies).toContain("sender-first update");
    expect(visibleBodies).not.toContain("withheld sender-first update");

    await coordinator.observeOutboundPreview({
      roomId,
      originalEventId: "$sender-root",
      sourceEventId: "$sender-newer",
      senderId: "@alpha:example.org",
      marker: { ...marker, revision: 3 },
      body: "newer unreviewed sender update",
    });
    if (deniedUpdate.kind !== "authorize") {
      throw new Error("expected withheld exact update to be prepared");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: deniedUpdate.observationId,
      }),
    ).resolves.toBe(false);
    const afterLateAuthorization = coordinator
      .readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
      .entries.map((entry) => entry.body);
    expect(afterLateAuthorization).toContain("sender-first update");
    expect(afterLateAuthorization).not.toContain("withheld sender-first update");
    expect(afterLateAuthorization).not.toContain("newer unreviewed sender update");
  });

  it("rejects older or conflicting equality against a sender-first observation", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => [
      "@alpha:example.org",
      "@beta:example.org",
      "@gamma:example.org",
    ]);
    register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers: joined,
    });
    register(coordinator, {
      accountId: "beta",
      userId: "@beta:example.org",
      getJoinedRoomMembers: joined,
    });
    register(coordinator, {
      accountId: "gamma",
      userId: "@gamma:example.org",
      getJoinedRoomMembers: joined,
    });
    const roomId = "!sender-first-conflicts:example.org";
    const marker = { ...baseMarker, responseId: "sender-first-conflicts" };
    await coordinator.observeOutboundPreview({
      roomId,
      originalEventId: "$conflict-root",
      sourceEventId: "$conflict-root",
      senderId: "@alpha:example.org",
      marker,
      body: "root body",
    });
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId,
        accountId: "gamma",
        event: protocolRoot(marker, "$conflict-root", "conflicting root body"),
      }),
    ).resolves.toEqual({ kind: "consume", reason: "invalid or stale preview lineage" });
    await coordinator.observeOutboundPreview({
      roomId,
      originalEventId: "$conflict-root",
      sourceEventId: "$exact-update",
      senderId: "@alpha:example.org",
      marker: { ...marker, revision: 2 },
      body: "exact update body",
    });

    for (const scenario of [
      {
        accountId: "beta",
        event: protocolEdit(
          { ...marker, revision: 2 },
          "$different-source",
          "exact update body",
          "$conflict-root",
        ),
      },
      {
        accountId: "beta",
        event: protocolEdit(
          { ...marker, revision: 2 },
          "$exact-update",
          "conflicting body",
          "$conflict-root",
        ),
      },
      {
        accountId: "gamma",
        event: protocolEdit(
          { ...marker, revision: 2, kind: "progress" },
          "$exact-update",
          "exact update body",
          "$conflict-root",
        ),
      },
      {
        accountId: "gamma",
        event: protocolEdit(
          { ...marker, revision: 1 },
          "$older-update",
          "older body",
          "$conflict-root",
        ),
      },
    ] as const) {
      await expect(
        coordinator.interceptPreviewEvent({
          cfg: {} as never,
          roomId,
          accountId: scenario.accountId,
          event: scenario.event,
        }),
      ).resolves.toEqual({ kind: "consume", reason: "invalid or stale preview lineage" });
    }
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toEqual([]);
  });

  it("retains the last authorized preview until the exact final passes receiver access", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
    register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers: joined,
    });
    register(coordinator, {
      accountId: "beta",
      userId: "@beta:example.org",
      getJoinedRoomMembers: joined,
      getEvent: vi.fn(async () => protocolRoot()),
    });
    completionMocks.complete.mockResolvedValue({
      text: JSON.stringify({
        decisions: [
          { accountId: "alpha", disposition: "neutral" },
          { accountId: "beta", disposition: "neutral" },
        ],
      }),
    });
    const acceptedRoot = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId: "!exact-authorization:example.org",
      accountId: "beta",
      event: protocolRoot(baseMarker, "$root", "allowed revision zero"),
    });
    expect(acceptedRoot.kind).toBe("authorize");
    if (acceptedRoot.kind !== "authorize") {
      throw new Error("expected receiver-authorizable root");
    }
    await coordinator.authorizePreviewObservation({
      roomId: "!exact-authorization:example.org",
      accountId: "beta",
      observationId: acceptedRoot.observationId,
    });

    const deniedUpdate = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId: "!exact-authorization:example.org",
      accountId: "beta",
      event: protocolEdit(
        { ...baseMarker, state: "in-progress", revision: 1 },
        "$denied-update",
        "denied revision one",
      ),
    });
    expect(deniedUpdate.kind).toBe("authorize");
    const freshnessBodies = coordinator
      .readFreshness({
        view: { includesContext: () => true },
        roomId: "!exact-authorization:example.org",
        afterSequence: 0,
      })
      .entries.map((entry) => entry.body);
    expect(freshnessBodies).toContain("allowed revision zero");
    expect(freshnessBodies).not.toContain("denied revision one");

    await coordinator.decideParticipation({
      cfg: {} as never,
      roomId: "!exact-authorization:example.org",
      eventId: "$human-check",
      senderId: "@human:example.org",
      body: "who is active?",
      accountId: "beta",
    });
    const classifierCall = completionMocks.complete.mock.calls.at(-1)?.[0] as {
      context: { messages: Array<{ content: string }> };
    };
    const classifierData = JSON.parse(classifierCall.context.messages[0]?.content ?? "{}") as {
      untrustedRoomData?: { activeSiblingPreviews?: Array<{ body?: string }> };
    };
    expect(classifierData.untrustedRoomData?.activeSiblingPreviews).toEqual([
      expect.objectContaining({ body: "allowed revision zero" }),
    ]);

    const finalMarker = { ...baseMarker, state: "final" as const, revision: 2 };
    await coordinator.observeOutboundPreview({
      roomId: "!exact-authorization:example.org",
      originalEventId: "$root",
      sourceEventId: "$denied-final",
      senderId: "@alpha:example.org",
      marker: finalMarker,
      body: "denied final body",
    });
    expect(
      coordinator
        .readFreshness({
          view: { includesContext: () => true },
          roomId: "!exact-authorization:example.org",
          afterSequence: 0,
        })
        .entries.map((entry) => entry.body),
    ).toContain("allowed revision zero");

    const deniedFinal = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId: "!exact-authorization:example.org",
      accountId: "beta",
      event: protocolEdit(finalMarker, "$denied-final", "denied final body"),
    });
    expect(deniedFinal.kind).toBe("promote");
    // Interception precedes the handler's normal Matrix access check. Leaving
    // this prepared terminal unauthorized models that check denying it.
    const afterDeniedFinal = coordinator
      .readFreshness({
        view: { includesContext: () => true },
        roomId: "!exact-authorization:example.org",
        afterSequence: 0,
      })
      .entries.map((entry) => entry.body);
    expect(afterDeniedFinal).toContain("allowed revision zero");
    expect(afterDeniedFinal).not.toContain("denied final body");
    await coordinator.decideParticipation({
      cfg: {} as never,
      roomId: "!exact-authorization:example.org",
      eventId: "$after-denied-final",
      senderId: "@human:example.org",
      body: "what remains visible?",
      accountId: "beta",
    });
    const postFinalClassifierCall = completionMocks.complete.mock.calls.at(-1)?.[0] as {
      context: { messages: Array<{ content: string }> };
    };
    const postFinalClassifierData = JSON.parse(
      postFinalClassifierCall.context.messages[0]?.content ?? "{}",
    ) as {
      untrustedRoomData?: {
        activeSiblingPreviews?: Array<{ body?: string }>;
        recentHistory?: Array<{ body?: string }>;
      };
    };
    expect(postFinalClassifierData.untrustedRoomData?.activeSiblingPreviews).toEqual([
      expect.objectContaining({ body: "allowed revision zero" }),
    ]);
    expect(
      postFinalClassifierData.untrustedRoomData?.recentHistory?.map((entry) => entry.body),
    ).not.toContain("denied final body");

    if (deniedFinal.kind !== "promote") {
      throw new Error("expected receiver-authorizable final");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId: "!exact-authorization:example.org",
        accountId: "beta",
        observationId: deniedFinal.observationId,
      }),
    ).resolves.toBe(true);
    const afterAllowedFinal = coordinator.readFreshness({
      view: { includesContext: () => true },
      roomId: "!exact-authorization:example.org",
      afterSequence: 0,
    }).entries;
    expect(afterAllowedFinal).not.toContainEqual(
      expect.objectContaining({ body: "allowed revision zero", state: "in-progress" }),
    );
    expect(afterAllowedFinal).toContainEqual(
      expect.objectContaining({ body: "denied final body", state: "final" }),
    );

    if (deniedUpdate.kind !== "authorize") {
      throw new Error("expected receiver-authorizable update");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId: "!exact-authorization:example.org",
        accountId: "beta",
        observationId: deniedUpdate.observationId,
      }),
    ).resolves.toBe(false);
    expect(
      coordinator
        .readFreshness({
          view: { includesContext: () => true },
          roomId: "!exact-authorization:example.org",
          afterSequence: 0,
        })
        .entries.map((entry) => entry.body),
    ).not.toContain("denied revision one");
  });

  it("retains the last authorized preview until the exact abandoned frame passes receiver access", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
    register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers: joined,
    });
    register(coordinator, {
      accountId: "beta",
      userId: "@beta:example.org",
      getJoinedRoomMembers: joined,
      getEvent: vi.fn(async () => protocolRoot()),
    });
    const roomId = "!abandoned-authorization:example.org";
    const marker = { ...baseMarker, responseId: "abandoned-authorization" };
    const root = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolRoot(marker, "$root", "authorized work in progress"),
    });
    expect(root.kind).toBe("authorize");
    if (root.kind !== "authorize") {
      throw new Error("expected receiver-authorizable root");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: root.observationId,
      }),
    ).resolves.toBe(true);

    const abandonedMarker = { ...marker, state: "abandoned" as const, revision: 1 };
    const deniedAbandoned = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolEdit(abandonedMarker, "$abandoned", "authorized work in progress"),
    });
    expect(deniedAbandoned.kind).toBe("authorize");
    // Do not authorize yet: this is the state after normal Matrix access has
    // rejected the terminal frame.
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toContainEqual(
      expect.objectContaining({ body: "authorized work in progress", state: "in-progress" }),
    );
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).not.toContainEqual(expect.objectContaining({ state: "abandoned" }));

    if (deniedAbandoned.kind !== "authorize") {
      throw new Error("expected receiver-authorizable abandoned frame");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: deniedAbandoned.observationId,
      }),
    ).resolves.toBe(true);
    const afterAllowedAbandoned = coordinator.readFreshness({
      view: { includesContext: () => true },
      roomId,
      afterSequence: 0,
    }).entries;
    expect(afterAllowedAbandoned).not.toContainEqual(
      expect.objectContaining({ body: "authorized work in progress", state: "in-progress" }),
    );
    expect(afterAllowedAbandoned).toContainEqual(
      expect.objectContaining({
        body: "[Sibling agent preview was withdrawn]",
        state: "abandoned",
      }),
    );
  });

  it("retires an authorized preview on Matrix redaction without allowing late access to resurrect it", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
    register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers: joined,
    });
    register(coordinator, {
      accountId: "beta",
      userId: "@beta:example.org",
      getJoinedRoomMembers: joined,
      getEvent: vi.fn(async () => protocolRoot()),
    });
    const roomId = "!redacted-authorization:example.org";
    const marker = { ...baseMarker, responseId: "redacted-authorization" };
    const root = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolRoot(marker, "$redacted-root", "authorized before redaction"),
    });
    expect(root.kind).toBe("authorize");
    if (root.kind !== "authorize") {
      throw new Error("expected receiver-authorizable root");
    }
    await coordinator.authorizePreviewObservation({
      roomId,
      accountId: "beta",
      observationId: root.observationId,
    });

    const lateUpdate = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolEdit(
        { ...marker, revision: 1 },
        "$redacted-update",
        "unauthorized update before redaction",
        "$redacted-root",
      ),
    });
    expect(lateUpdate.kind).toBe("authorize");

    await expect(
      coordinator.observePreviewRedaction({ roomId, targetEventId: "$redacted-root" }),
    ).resolves.toBe(true);
    const afterRedaction = coordinator.readFreshness({
      view: { includesContext: () => true },
      roomId,
      afterSequence: 0,
    }).entries;
    expect(afterRedaction).not.toContainEqual(
      expect.objectContaining({ body: "authorized before redaction", state: "in-progress" }),
    );
    expect(afterRedaction).toContainEqual(
      expect.objectContaining({ body: "[Sibling agent preview was redacted]", state: "redacted" }),
    );

    if (lateUpdate.kind !== "authorize") {
      throw new Error("expected receiver-authorizable update");
    }
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: lateUpdate.observationId,
      }),
    ).resolves.toBe(false);
    expect(
      coordinator
        .readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries.map((entry) => entry.body),
    ).not.toContain("unauthorized update before redaction");
  });
});
