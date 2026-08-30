import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseMarker,
  createMatrixTurnTakingCoordinator,
  getTurnTakingCoordinatorCompletionMocks,
  MATRIX_ACTIVE_PREVIEW_TTL_MS,
  MATRIX_TERMINAL_REPLAY_TTL_MS,
  protocolRoot,
  register,
  resetTurnTakingCoordinatorTestMocks,
  type MatrixOpenClawPreviewMarker,
} from "./turn-taking-coordinator.test-fixtures.js";

const completionMocks = getTurnTakingCoordinatorCompletionMocks();

beforeEach(resetTurnTakingCoordinatorTestMocks);

describe("Matrix turn-taking coordinator: preview security", () => {
  it("expires a retained authorized snapshot when an unauthorized terminal remains unresolved", async () => {
    let timestamp = 1_000;
    const coordinator = createMatrixTurnTakingCoordinator({ now: () => timestamp });
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
    const roomId = "!terminal-timeout:example.org";
    const marker = { ...baseMarker, responseId: "terminal-timeout" };
    const root = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolRoot(marker, "$timeout-root", "authorized until timeout"),
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
    await coordinator.observeOutboundPreview({
      roomId,
      originalEventId: "$timeout-root",
      sourceEventId: "$timeout-final",
      senderId: "@alpha:example.org",
      marker: { ...marker, state: "final", revision: 1 },
      body: "terminal awaiting access",
    });
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toContainEqual(
      expect.objectContaining({ body: "authorized until timeout", state: "in-progress" }),
    );

    timestamp += MATRIX_ACTIVE_PREVIEW_TTL_MS + 1;
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toEqual([]);
  });

  it("rejects an in-progress authorization that completes after its absolute source deadline", async () => {
    let timestamp = 10_000;
    const coordinator = createMatrixTurnTakingCoordinator({ now: () => timestamp });
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
    const roomId = "!late-active-authorization:example.org";
    const event = {
      ...protocolRoot(baseMarker, "$late-active", "must never become visible"),
      origin_server_ts: timestamp,
    };
    const prepared = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event,
    });
    expect(prepared.kind).toBe("authorize");
    if (prepared.kind !== "authorize") {
      throw new Error("expected receiver-authorizable preview");
    }

    timestamp += MATRIX_ACTIVE_PREVIEW_TTL_MS + 1;
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: prepared.observationId,
      }),
    ).resolves.toBe(false);
    await expect(
      coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: prepared.observationId,
      }),
    ).resolves.toBe(false);
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toEqual([]);
  });

  it("rejects terminal authorization after the source replay deadline or prepared-cache deadline", async () => {
    const joined = vi.fn(async () => ["@alpha:example.org", "@beta:example.org"]);
    const marker: MatrixOpenClawPreviewMarker = {
      ...baseMarker,
      responseId: "late-terminal",
      state: "final",
      partIndex: 0,
      partCount: 1,
    };

    for (const scenario of [
      {
        roomId: "!late-terminal-source:example.org",
        sourceAge: MATRIX_TERMINAL_REPLAY_TTL_MS - 500,
        advanceMs: 501,
      },
      {
        roomId: "!late-terminal-cache:example.org",
        sourceAge: 0,
        advanceMs: 10 * 60_000 + 1,
      },
    ]) {
      let timestamp = 50_000_000;
      const coordinator = createMatrixTurnTakingCoordinator({ now: () => timestamp });
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
      const event = {
        ...protocolRoot(marker, `$terminal-${scenario.sourceAge}`, "expired terminal body"),
        origin_server_ts: timestamp - scenario.sourceAge,
      };
      const prepared = await coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: scenario.roomId,
        accountId: "beta",
        event,
      });
      expect(prepared.kind).toBe("promote");
      if (prepared.kind !== "promote") {
        throw new Error("expected receiver-authorizable terminal");
      }

      timestamp += scenario.advanceMs;
      await expect(
        coordinator.authorizePreviewObservation({
          roomId: scenario.roomId,
          accountId: "beta",
          observationId: prepared.observationId,
        }),
      ).resolves.toBe(false);
      expect(
        coordinator.readFreshness({
          view: { includesContext: () => true },
          roomId: scenario.roomId,
          afterSequence: 0,
        }).entries,
      ).toEqual([]);
    }
  });

  it("remembers a redaction observed before its preview lineage exists", async () => {
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
    const roomId = "!redaction-first:example.org";

    await expect(
      coordinator.observePreviewRedaction({ roomId, targetEventId: "$redacted-before-root" }),
    ).resolves.toBe(false);
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId,
        accountId: "beta",
        event: protocolRoot(baseMarker, "$redacted-before-root", "must stay redacted"),
      }),
    ).resolves.toEqual({ kind: "consume", reason: "preview source was already redacted" });
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toEqual([]);
  });

  it("keeps an overtaking redaction authoritative while membership resolution is pending", async () => {
    let releaseMembership: ((members: string[]) => void) | undefined;
    const joined = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          releaseMembership = resolve;
        }),
    );
    const coordinator = createMatrixTurnTakingCoordinator();
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
    const roomId = "!redaction-overtake:example.org";
    const pending = coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId,
      accountId: "beta",
      event: protocolRoot(baseMarker, "$overtaken-root", "must stay redacted"),
    });
    await vi.waitFor(() => expect(joined).toHaveBeenCalled());
    await expect(
      coordinator.observePreviewRedaction({ roomId, targetEventId: "$overtaken-root" }),
    ).resolves.toBe(false);
    releaseMembership?.(["@alpha:example.org", "@beta:example.org"]);

    await expect(pending).resolves.toEqual({
      kind: "consume",
      reason: "preview source was already redacted",
    });
    expect(
      coordinator.readFreshness({ view: { includesContext: () => true }, roomId, afterSequence: 0 })
        .entries,
    ).toEqual([]);
  });

  it("fails redaction overflow closed only in the room whose record was evicted", async () => {
    const coordinator = createMatrixTurnTakingCoordinator({ maxEarlyPreviewRedactions: 2 });
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
    await coordinator.observePreviewRedaction({
      roomId: "!evicted-redaction:example.org",
      targetEventId: "$evicted-redaction",
    });
    await coordinator.observePreviewRedaction({
      roomId: "!other-redaction:example.org",
      targetEventId: "$other-redaction",
    });
    await coordinator.observePreviewRedaction({
      roomId: "!third-redaction:example.org",
      targetEventId: "$third-redaction",
    });

    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!evicted-redaction:example.org",
        accountId: "beta",
        event: protocolRoot(baseMarker, "$unrelated-in-closed-room", "must stay closed"),
      }),
    ).resolves.toEqual({ kind: "consume", reason: "preview source was already redacted" });
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!unaffected-room:example.org",
        accountId: "beta",
        event: protocolRoot(baseMarker, "$unaffected", "still eligible"),
      }),
    ).resolves.toMatchObject({ kind: "authorize" });
  });

  it("fails globally closed only when the bounded room-overflow index saturates, then expires", async () => {
    let timestamp = 1_000;
    const coordinator = createMatrixTurnTakingCoordinator({
      now: () => timestamp,
      maxEarlyPreviewRedactions: 2,
    });
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

    for (const [roomId, targetEventId] of [
      ["!overflow-one:example.org", "$overflow-one"],
      ["!overflow-two:example.org", "$overflow-two"],
      ["!overflow-three:example.org", "$overflow-three"],
      ["!overflow-four:example.org", "$overflow-four"],
      ["!overflow-five:example.org", "$overflow-five"],
    ] as const) {
      await coordinator.observePreviewRedaction({ roomId, targetEventId });
    }

    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!global-overflow-bystander:example.org",
        accountId: "beta",
        event: protocolRoot(baseMarker, "$global-overflow-bystander", "must stay closed"),
      }),
    ).resolves.toEqual({ kind: "consume", reason: "preview source was already redacted" });

    timestamp += MATRIX_TERMINAL_REPLAY_TTL_MS + 1;
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!global-overflow-bystander:example.org",
        accountId: "beta",
        event: protocolRoot(baseMarker, "$global-overflow-expired", "eligible after expiry"),
      }),
    ).resolves.toMatchObject({ kind: "authorize" });
  });

  it("consumes a spoofed protocol marker from a non-roster sender", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => [
      "@alpha:example.org",
      "@beta:example.org",
      "@mallory:example.org",
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
    const spoofed = {
      ...protocolRoot(baseMarker, "$spoofed", "pretend bot output"),
      sender: "@mallory:example.org",
    };

    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "beta",
        event: spoofed,
      }),
    ).resolves.toEqual({ kind: "consume", reason: "untrusted enhanced preview sender" });
  });

  it("assembles out-of-order standalone parts once into the complete logical final", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => [
      "@alpha:example.org",
      "@beta:example.org",
      "@gamma:example.org",
    ]);
    for (const accountId of ["alpha", "beta", "gamma"]) {
      register(coordinator, {
        accountId,
        userId: `@${accountId}:example.org`,
        getJoinedRoomMembers: joined,
      });
    }
    const markerForPart = (partIndex: number): MatrixOpenClawPreviewMarker => ({
      ...baseMarker,
      responseId: "multipart",
      state: "final",
      revision: 0,
      partIndex,
      partCount: 2,
    });
    const part1 = protocolRoot(markerForPart(1), "$part-1", "second");
    const part0 = protocolRoot(markerForPart(0), "$part-0", "first");

    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "beta",
        event: part1,
      }),
    ).resolves.toMatchObject({ kind: "consume" });
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "beta",
        event: part0,
      }),
    ).resolves.toMatchObject({
      kind: "promote",
      event: { event_id: "$part-0", content: { body: "first\nsecond" } },
    });
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "gamma",
        event: part1,
      }),
    ).resolves.toMatchObject({
      kind: "promote",
      event: { event_id: "$part-0", content: { body: "first\nsecond" } },
    });
  });

  it("poisons final replay after redaction and removes the withdrawn final body", async () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = vi.fn(async () => [
      "@alpha:example.org",
      "@beta:example.org",
      "@gamma:example.org",
    ]);
    for (const accountId of ["alpha", "beta", "gamma"]) {
      register(coordinator, {
        accountId,
        userId: `@${accountId}:example.org`,
        getJoinedRoomMembers: joined,
      });
    }
    const standaloneMarker: MatrixOpenClawPreviewMarker = {
      ...baseMarker,
      responseId: "redacted-final",
      state: "final",
      revision: 0,
      partIndex: 0,
      partCount: 1,
    };
    const final = protocolRoot(standaloneMarker, "$standalone", "withdraw me");
    const acceptedFinal = await coordinator.interceptPreviewEvent({
      cfg: {} as never,
      roomId: "!room:example.org",
      accountId: "beta",
      event: final,
    });
    expect(acceptedFinal.kind).toBe("promote");
    if (acceptedFinal.kind !== "promote") {
      throw new Error("expected promoted standalone final");
    }
    await coordinator.authorizePreviewObservation({
      roomId: "!room:example.org",
      accountId: "beta",
      observationId: acceptedFinal.observationId,
    });
    await expect(
      coordinator.observePreviewRedaction({
        roomId: "!room:example.org",
        targetEventId: "$standalone",
      }),
    ).resolves.toBe(true);
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "gamma",
        event: final,
      }),
    ).resolves.toMatchObject({ kind: "consume" });
    const freshness = coordinator.readFreshness({
      view: { includesContext: () => true },
      roomId: "!room:example.org",
      afterSequence: 0,
    });
    expect(freshness.entries.map((entry) => entry.body)).not.toContain("withdraw me");
    expect(freshness.entries).toContainEqual(
      expect.objectContaining({ state: "redacted", body: "[Sibling agent preview was redacted]" }),
    );
  });

  it("retains compact redaction metadata after more than 64 completed finals", async () => {
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

    for (let index = 0; index < 65; index += 1) {
      const roomId = `!completed-${index}:example.org`;
      const eventId = `$completed-${index}`;
      const body = `answer ${index}`;
      const event = protocolRoot(
        {
          ...baseMarker,
          responseId: `completed-${index}`,
          state: "final",
          revision: 0,
          partIndex: 0,
          partCount: 1,
        },
        eventId,
        body,
      );
      const accepted = await coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId,
        accountId: "beta",
        event,
      });
      expect(accepted.kind).toBe("promote");
      if (accepted.kind !== "promote") {
        throw new Error("expected promoted standalone final");
      }
      await coordinator.authorizePreviewObservation({
        roomId,
        accountId: "beta",
        observationId: accepted.observationId,
      });
    }

    await expect(
      coordinator.observePreviewRedaction({
        roomId: "!completed-0:example.org",
        targetEventId: "$completed-0",
      }),
    ).resolves.toBe(true);
    const freshness = coordinator.readFreshness({
      view: { includesContext: () => true },
      roomId: "!completed-0:example.org",
      afterSequence: 0,
    });
    expect(freshness.entries.map((entry) => entry.body)).not.toContain("answer 0");
    expect(freshness.entries).toContainEqual(expect.objectContaining({ state: "redacted" }));
  });

  it("keeps sibling progress that arrives while live membership is resolving", async () => {
    vi.useFakeTimers();
    try {
      let releaseMembership: ((members: string[]) => void) | undefined;
      const joined = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            releaseMembership = resolve;
          }),
      );
      const coordinator = createMatrixTurnTakingCoordinator();
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
      const pendingDecision = coordinator.decideParticipation({
        cfg: {} as never,
        roomId: "!race:example.org",
        eventId: "$trigger",
        senderId: "@human:example.org",
        body: "question",
        accountId: "alpha",
      });
      await vi.waitFor(() => expect(joined).toHaveBeenCalled());
      await coordinator.observeOutboundPreview({
        roomId: "!race:example.org",
        originalEventId: "$sibling-preview",
        sourceEventId: "$sibling-preview",
        senderId: "@beta:example.org",
        marker: { ...baseMarker, responseId: "sibling-progress", kind: "progress" },
        body: "I am already checking this",
      });
      const siblingPreview = {
        ...protocolRoot(
          { ...baseMarker, responseId: "sibling-progress", kind: "progress" },
          "$sibling-preview",
          "I am already checking this",
        ),
        sender: "@beta:example.org",
      };
      const pendingPreviewIngress = coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!race:example.org",
        accountId: "alpha",
        event: siblingPreview,
      });
      releaseMembership?.(["@alpha:example.org", "@beta:example.org"]);
      const decision = await pendingDecision;
      const previewIngress = await pendingPreviewIngress;
      expect(previewIngress.kind).toBe("authorize");
      if (previewIngress.kind !== "authorize") {
        throw new Error("expected receiver-authorizable sibling preview");
      }
      await coordinator.authorizePreviewObservation({
        roomId: "!race:example.org",
        accountId: "alpha",
        observationId: previewIngress.observationId,
      });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!race:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence: decision.baselineSequence!,
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      const gateResult = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "My draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);
      await expect(gateResult).resolves.toMatchObject({
        action: "revise",
        disableTools: true,
        instruction: expect.stringContaining("I am already checking this"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
