import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseMarker,
  createMatrixTurnTakingCoordinator,
  getTurnTakingCoordinatorCompletionMocks,
  protocolEdit,
  protocolRoot,
  register,
  resetTurnTakingCoordinatorTestMocks,
  type MatrixOpenClawPreviewMarker,
} from "./turn-taking-coordinator.test-fixtures.js";

const completionMocks = getTurnTakingCoordinatorCompletionMocks();

beforeEach(resetTurnTakingCoordinatorTestMocks);

describe("Matrix turn-taking coordinator: finalization", () => {
  it("returns the configured fixed discard action with source-local cleanup", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createMatrixTurnTakingCoordinator();
      register(coordinator, {
        accountId: "alpha",
        userId: "@alpha:example.org",
        getJoinedRoomMembers: vi.fn(async () => ["@alpha:example.org"]),
      });
      coordinator.observeMessage({
        roomId: "!discard:example.org",
        eventId: "$trigger",
        senderId: "@human:example.org",
        body: "question",
      });
      const baselineSequence = coordinator.currentSequence();
      coordinator.observeMessage({
        roomId: "!discard:example.org",
        eventId: "$newer",
        senderId: "@beta:example.org",
        body: "I already answered",
      });
      const onDiscardAccepted = vi.fn();
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!discard:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence,
        triggerEventId: "$trigger",
        onDiscardAccepted,
        config: {
          enabled: true,
          redraftDepth: 1,
          nextStep: { decider: "user", action: "discard" },
        },
        log: vi.fn(),
      })!;
      const pending = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "obsolete draft",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);

      const result = await pending;
      expect(result).toEqual({ action: "discard", onAccepted: onDiscardAccepted });
      coordinator.observeMessage({
        roomId: "!discard:example.org",
        eventId: "$later",
        senderId: "@gamma:example.org",
        body: "even newer activity",
      });
      await expect(
        gate({
          runId: "run",
          sessionId: "session",
          provider: "full",
          model: "full-model",
          lastAssistantMessage: "must stay discarded",
          revisionAttempt: 1,
        }),
      ).resolves.toEqual({ action: "continue" });
      expect(completionMocks.complete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a withdrawn sibling preview across the depth-two redraft cursor", async () => {
    vi.useFakeTimers();
    try {
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
      coordinator.observeMessage({
        roomId: "!withdrawn:example.org",
        eventId: "$trigger",
        senderId: "@human:example.org",
        body: "question",
      });
      const baselineSequence = coordinator.currentSequence();
      const marker = { ...baseMarker, responseId: "withdrawn-progress", kind: "progress" as const };
      await coordinator.observeOutboundPreview({
        roomId: "!withdrawn:example.org",
        originalEventId: "$preview",
        sourceEventId: "$preview",
        senderId: "@beta:example.org",
        marker,
        body: "I am checking",
      });
      const previewIngress = await coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!withdrawn:example.org",
        accountId: "alpha",
        event: {
          ...protocolRoot(marker, "$preview", "I am checking"),
          sender: "@beta:example.org",
        },
      });
      expect(previewIngress.kind).toBe("authorize");
      if (previewIngress.kind !== "authorize") {
        throw new Error("expected receiver-authorizable sibling preview");
      }
      await coordinator.authorizePreviewObservation({
        roomId: "!withdrawn:example.org",
        accountId: "alpha",
        observationId: previewIngress.observationId,
      });
      const gate = coordinator.createFreshnessGate({
        accountId: "alpha",
        triggerSenderId: "@human:example.org",
        cfg: {} as never,
        agentId: "agent-alpha",
        roomId: "!withdrawn:example.org",
        selfUserId: "@alpha:example.org",
        baselineSequence,
        triggerEventId: "$trigger",
        config: {
          enabled: true,
          redraftDepth: 2,
          nextStep: { decider: "user", action: "redraft" },
        },
        log: vi.fn(),
      })!;
      const first = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "Draft one",
        revisionAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(200);
      await expect(first).resolves.toMatchObject({
        action: "revise",
        instruction: expect.stringContaining("I am checking"),
      });

      await coordinator.observeOutboundPreview({
        roomId: "!withdrawn:example.org",
        originalEventId: "$preview",
        sourceEventId: "$abandoned",
        senderId: "@beta:example.org",
        marker: { ...marker, state: "abandoned", revision: 1 },
        body: "I am checking",
      });
      const abandonedIngress = await coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!withdrawn:example.org",
        accountId: "alpha",
        event: (() => {
          const abandoned = protocolEdit(
            { ...marker, state: "abandoned", revision: 1 },
            "$abandoned",
            "I am checking",
          );
          return {
            ...abandoned,
            sender: "@beta:example.org",
            content: {
              ...abandoned.content,
              "m.relates_to": { rel_type: "m.replace", event_id: "$preview" },
            },
          };
        })(),
      });
      expect(abandonedIngress.kind).toBe("authorize");
      if (abandonedIngress.kind !== "authorize") {
        throw new Error("expected receiver-authorizable abandoned preview");
      }
      await coordinator.authorizePreviewObservation({
        roomId: "!withdrawn:example.org",
        accountId: "alpha",
        observationId: abandonedIngress.observationId,
      });
      const second = gate({
        runId: "run",
        sessionId: "session",
        provider: "full",
        model: "full-model",
        lastAssistantMessage: "Draft two",
        revisionAttempt: 1,
      });
      await vi.advanceTimersByTimeAsync(200);
      await expect(second).resolves.toMatchObject({
        action: "revise",
        instruction: expect.stringContaining("Sibling agent preview was withdrawn"),
      });
      await expect(
        gate({
          runId: "run",
          sessionId: "session",
          provider: "full",
          model: "full-model",
          lastAssistantMessage: "Draft three",
          revisionAttempt: 2,
        }),
      ).resolves.toEqual({ action: "continue" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("poisons standalone multipart bodies that exceed the bounded aggregate budget", async () => {
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
    for (let partIndex = 0; partIndex < 5; partIndex += 1) {
      const marker: MatrixOpenClawPreviewMarker = {
        ...baseMarker,
        responseId: "oversized-assembly",
        state: "final",
        revision: 0,
        partIndex,
        partCount: 5,
      };
      const result = await coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "beta",
        event: protocolRoot(marker, `$oversized-${partIndex}`, "x".repeat(60_000)),
      });
      if (partIndex < 4) {
        expect(result).toMatchObject({
          kind: "consume",
          reason: "standalone final awaiting parts",
        });
      } else {
        expect(result).toEqual({
          kind: "consume",
          reason: "standalone final exceeds bounded body budget",
        });
      }
    }
  });

  it("evicts the oldest incomplete standalone assembly at the global assembly cap", async () => {
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
    const markerFor = (responseId: string, partIndex: number): MatrixOpenClawPreviewMarker => ({
      ...baseMarker,
      responseId,
      state: "final",
      revision: 0,
      partIndex,
      partCount: 2,
    });
    for (let index = 0; index < 65; index += 1) {
      await coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!assembly-cap:example.org",
        accountId: "beta",
        event: protocolRoot(markerFor(`assembly-${index}`, 0), `$root-${index}`, "first"),
      });
    }

    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!assembly-cap:example.org",
        accountId: "beta",
        event: protocolRoot(markerFor("assembly-0", 1), "$tail-0", "second"),
      }),
    ).resolves.toEqual({ kind: "consume", reason: "standalone final awaiting parts" });
  });

  it("fails safely when a cold encrypted root cannot prove preview lineage", async () => {
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
      getEvent: vi.fn(async () => ({
        event_id: "$root",
        sender: "@alpha:example.org",
        type: "m.room.encrypted",
        origin_server_ts: 100,
        content: { ciphertext: "opaque" },
      })),
    });
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: {} as never,
        roomId: "!room:example.org",
        accountId: "beta",
        event: protocolEdit({ ...baseMarker, state: "final", revision: 1 }),
      }),
    ).resolves.toMatchObject({ kind: "consume", reason: "invalid or stale preview lineage" });
  });

  it("evicts old journal scopes and clears all transient state with the last monitor", () => {
    const coordinator = createMatrixTurnTakingCoordinator();
    const cleanup = register(coordinator, {
      accountId: "alpha",
      userId: "@alpha:example.org",
      getJoinedRoomMembers: vi.fn(async () => []),
    });
    for (let index = 0; index < 257; index += 1) {
      coordinator.observeMessage({
        roomId: `!room-${index}:example.org`,
        eventId: `$event-${index}`,
        senderId: "@human:example.org",
        body: "x".repeat(4_000),
      });
    }
    expect(
      coordinator.readFreshness({
        view: { includesContext: () => true },
        roomId: "!room-0:example.org",
        afterSequence: 0,
      }).entries,
    ).toEqual([]);
    expect(
      coordinator.readFreshness({
        view: { includesContext: () => true },
        roomId: "!room-256:example.org",
        afterSequence: 0,
      }).entries[0]?.body.length,
    ).toBe(2_000);
    cleanup();
    expect(
      coordinator.readFreshness({
        view: { includesContext: () => true },
        roomId: "!room-256:example.org",
        afterSequence: 0,
      }).entries,
    ).toEqual([]);
  });
});
