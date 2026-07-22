import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { resolveChatPaneObserverRunId } from "../../lib/observer-digest.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatObserverHudState, type ObserverHudInput } from "./components/chat-observer-hud.ts";

function digest(health: SessionObserverDigest["health"] = "on-track"): SessionObserverDigest {
  return {
    sessionKey: "agent:main:run",
    runId: "run-1",
    revision: 1,
    updatedAt: 2_000,
    headline: "Reviewing the implementation",
    health,
  };
}

function input(overrides: Partial<ObserverHudInput> = {}): ObserverHudInput {
  return {
    running: true,
    activeRunId: "run-1",
    digest: digest(),
    sideChatOpen: false,
    ...overrides,
  };
}

describe("ChatObserverHudState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves between hidden, pill, and user-expanded card states", () => {
    const state = new ChatObserverHudState(false);
    expect(state.mode(input({ running: false, digest: null }))).toBe("hidden");
    expect(state.mode(input({ digest: null }))).toBe("hidden");
    expect(state.mode(input())).toBe("pill");
    state.expand();
    expect(state.mode(input())).toBe("card");
    state.collapse();
    expect(state.mode(input())).toBe("pill");
  });

  it("suppresses missing and stale digests while a run is active", () => {
    const state = new ChatObserverHudState(true);
    expect(state.mode(input({ digest: null }))).toBe("hidden");
    expect(state.mode(input({ digest: { ...digest(), runId: undefined } }))).toBe("hidden");
    expect(state.mode(input({ digest: { ...digest(), runId: "previous-run" } }))).toBe("hidden");
    expect(state.mode(input())).toBe("card");
  });

  it("auto-expands a critical run at most once", () => {
    const state = new ChatObserverHudState(false);
    expect(state.mode(input({ digest: digest("stuck") }))).toBe("card");
    state.collapse();
    expect(state.mode(input({ digest: digest("waiting-on-user") }))).toBe("pill");
  });

  it("yields expanded space to side chat without changing the preference", () => {
    const state = new ChatObserverHudState(true);
    expect(state.mode(input({ sideChatOpen: true }))).toBe("pill");
    expect(state.mode(input({ sideChatOpen: false }))).toBe("card");
  });

  it("keeps a final digest until read, then hides it", () => {
    const state = new ChatObserverHudState(false);
    const finalDigest = digest("done");
    expect(
      state.mode(
        input({ running: false, activeRunId: null, digest: finalDigest, lastReadAt: 1_999 }),
      ),
    ).toBe("pill");
    expect(
      state.mode(
        input({ running: false, activeRunId: null, digest: finalDigest, lastReadAt: 2_000 }),
      ),
    ).toBe("hidden");
  });
});

describe("observer hud run identity from row data", () => {
  it("shows a projected digest when attaching to an already-running session", () => {
    const projectedDigest = {
      sessionKey: "agent:main:current",
      runId: "server-run",
      revision: 1,
      updatedAt: 2_000,
      headline: "Already running",
      health: "on-track" as const,
    };
    const activeRunId = resolveChatPaneObserverRunId({
      localRunId: null,
      session: { hasActiveRun: true, activeRunIds: ["server-run"] },
      digest: projectedDigest,
    });

    expect(activeRunId).toBe("server-run");
    expect(
      new ChatObserverHudState(false).mode({
        running: activeRunId !== null,
        activeRunId,
        digest: projectedDigest,
        sideChatOpen: false,
      }),
    ).toBe("pill");
  });
});

describe("observer hud auto-expand latch", () => {
  it("clears the critical-expansion latch when the hud hides", () => {
    const state = new ChatObserverHudState(false);
    const stuck = {
      sessionKey: "agent:main:s1",
      runId: "r1",
      revision: 1,
      updatedAt: 10,
      headline: "Stuck on tests",
      health: "stuck",
    } as SessionObserverDigest;
    expect(
      state.mode({ running: true, activeRunId: "r1", digest: stuck, sideChatOpen: false }),
    ).toBe("card");
    expect(
      state.mode({ running: true, activeRunId: "r1", digest: null, sideChatOpen: false }),
    ).toBe("hidden");
    const benign = { ...stuck, revision: 2, health: "on-track" } as SessionObserverDigest;
    expect(
      state.mode({ running: true, activeRunId: "r1", digest: benign, sideChatOpen: false }),
    ).toBe("pill");
  });
});
