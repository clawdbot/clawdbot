import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
import { IDLE_GC_MS } from "./service.js";

const mocks = vi.hoisted(() => ({
  resolveSessionEntryAccessTarget: vi.fn(),
  getMany: vi.fn(),
  listForReconcile: vi.fn(),
  isSessionWorkAdmissionActive: vi.fn(),
  isSessionLifecycleMutationActive: vi.fn(),
}));

vi.mock("../../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: mocks.getMany,
      listForReconcile: mocks.listForReconcile,
    },
  }),
}));
vi.mock("../../sessions/session-lifecycle-admission.js", () => ({
  isSessionWorkAdmissionActive: mocks.isSessionWorkAdmissionActive,
  isSessionLifecycleMutationActive: mocks.isSessionLifecycleMutationActive,
}));

beforeEach(() => {
  mocks.getMany.mockReturnValue(new Map());
  mocks.listForReconcile.mockReturnValue([]);
  mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
  mocks.isSessionLifecycleMutationActive.mockReturnValue(false);
});

vi.mock("../../config/sessions/session-accessor.js", () => ({
  resolveSessionEntryAccessTarget: mocks.resolveSessionEntryAccessTarget,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("createManagedWorktreeOwnerPolicy", () => {
  it("protects only recently active session owners", () => {
    const now = 1_800_000_000_000;
    const entries: Record<
      string,
      { lastInteractionAt?: number; updatedAt?: number; archivedAt?: number }
    > = {
      "agent:main:live": { lastInteractionAt: now - 1_000 },
      "agent:main:stale": { updatedAt: now - IDLE_GC_MS - 1 },
      "agent:main:archived": { updatedAt: now, archivedAt: now },
    };
    mocks.resolveSessionEntryAccessTarget.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => ({
        agentId: "main",
        canonicalKey: sessionKey,
        entry: entries[sessionKey],
      }),
    );
    const { shouldProtectOwner, shouldRemoveOwner } = createManagedWorktreeOwnerPolicy(
      {},
      () => now,
    );

    expect(shouldProtectOwner("session", "agent:main:live")).toBe(true);
    expect(shouldProtectOwner("session", "agent:main:stale")).toBe(false);
    expect(shouldProtectOwner("manual", "agent:main:live")).toBe(false);
    expect(shouldProtectOwner("session", "agent:main:missing")).toBe(false);
    expect(shouldProtectOwner("session", "agent:main:archived")).toBe(false);
    expect(shouldRemoveOwner("session", "agent:main:archived")).toBe(true);
    expect(shouldRemoveOwner("session", "agent:main:missing")).toBe(true);
    expect(shouldRemoveOwner("manual", "agent:main:missing")).toBe(false);
    expect(shouldRemoveOwner("session", "agent:main:live")).toBe(false);
    entries["agent:main:archived"] = { updatedAt: now };
    expect(shouldRemoveOwner("session", "agent:main:archived")).toBe(false);
    expect(shouldProtectOwner("session", "agent:main:archived")).toBe(true);
  });

  it("protects session owners when their state cannot be read", () => {
    mocks.resolveSessionEntryAccessTarget.mockImplementation(() => {
      throw new Error("unreadable session store");
    });
    const { shouldProtectOwner, shouldRemoveOwner } = createManagedWorktreeOwnerPolicy({});

    expect(shouldProtectOwner("session", "agent:main:live")).toBe(true);
    expect(shouldRemoveOwner("session", "agent:main:live")).toBe(false);
  });

  it.each(["admission", "lifecycle", "remote", "claimed", "unknown-placement"])(
    "protects retired session owners with %s work",
    (kind) => {
      const key = "agent:main:archived";
      mocks.resolveSessionEntryAccessTarget.mockReturnValue({
        agentId: "main",
        canonicalKey: key,
        entry: { sessionId: "session-one", archivedAt: 1 },
      });
      if (kind === "admission") {
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
      }
      if (kind === "lifecycle") {
        mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
      }
      if (kind === "unknown-placement") {
        mocks.getMany.mockImplementation(() => {
          throw new Error("unreadable placement");
        });
      }
      if (kind === "remote" || kind === "claimed") {
        mocks.getMany.mockReturnValue(
          new Map([
            [
              "session-one",
              {
                sessionId: "session-one",
                sessionKey: key,
                state: kind === "remote" ? "active" : "local",
                generation: 1,
                ...(kind === "claimed" ? { turnClaim: { id: "active-turn" } } : {}),
              },
            ],
          ]),
        );
      }
      const policy = createManagedWorktreeOwnerPolicy({});
      expect(policy.shouldProtectOwner("session", key)).toBe(true);
      expect(policy.shouldRemoveOwner("session", key)).toBe(false);
    },
  );

  it("protects a missing session row with a durable remote placement", () => {
    const key = "agent:main:missing";
    mocks.resolveSessionEntryAccessTarget.mockReturnValue({ agentId: "main", canonicalKey: key });
    const placement = {
      sessionId: "remote-session",
      sessionKey: key,
      state: "active",
      generation: 1,
    };
    mocks.listForReconcile.mockReturnValue([placement]);
    mocks.getMany.mockReturnValue(new Map([[placement.sessionId, placement]]));
    const policy = createManagedWorktreeOwnerPolicy({});
    expect(policy.shouldProtectOwner("session", key)).toBe(true);
    expect(policy.shouldRemoveOwner("session", key)).toBe(false);
  });

  it("invalidates cleanup when a stopped placement changes generation", () => {
    const key = "agent:main:archived";
    mocks.resolveSessionEntryAccessTarget.mockReturnValue({
      agentId: "main",
      canonicalKey: key,
      entry: { sessionId: "session-one", archivedAt: 1 },
    });
    mocks.getMany.mockReturnValue(
      new Map([
        [
          "session-one",
          { sessionId: "session-one", sessionKey: key, state: "reclaimed", generation: 1 },
        ],
      ]),
    );
    const policy = createManagedWorktreeOwnerPolicy({});
    expect(policy.shouldRemoveOwner("session", key)).toBe(true);
    mocks.getMany.mockReturnValue(
      new Map([
        [
          "session-one",
          { sessionId: "session-one", sessionKey: key, state: "reclaimed", generation: 2 },
        ],
      ]),
    );
    expect(policy.shouldProtectOwner("session", key)).toBe(true);
    expect(policy.shouldRemoveOwner("session", key)).toBe(false);
  });
});
