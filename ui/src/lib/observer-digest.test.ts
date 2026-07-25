import { describe, expect, it } from "vitest";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { ObserverDigestHistory } from "./observer-digest.ts";

const HISTORY_LIMIT = 50;

function digest(
  revision: number,
  overrides: Partial<SessionObserverDigest> = {},
): SessionObserverDigest {
  return {
    sessionKey: "agent:main:observer-history",
    runId: "run-current",
    revision,
    updatedAt: revision * 1_000,
    headline: `Digest ${revision}`,
    health: "on-track",
    ...overrides,
  };
}

describe("observer digest history", () => {
  it("hydrates the first projection, reconciles later ones, and keeps entries newest-last", () => {
    const history = new ObserverDigestHistory();
    const sessionKey = "agent:main:observer-history";

    expect(history.hydrate(sessionKey, digest(2))).toBe(true);
    expect(history.hydrate(sessionKey, digest(3))).toBe(true);
    expect(history.record(digest(1))).toBe(true);
    expect(history.record(digest(4))).toBe(true);

    expect(history.get(sessionKey).map((entry) => entry.revision)).toEqual([1, 2, 3, 4]);
  });

  it("uses revision then timestamp freshness and lets a live tie enrich its projection", () => {
    const history = new ObserverDigestHistory();
    const sessionKey = "agent:main:observer-history";
    history.hydrate(sessionKey, digest(3));

    expect(
      history.record(
        digest(3, { assessment: "Live detail", planProgress: { completed: 1, total: 2 } }),
      ),
    ).toBe(true);
    expect(history.record(digest(3))).toBe(false);
    expect(history.record(digest(3, { updatedAt: 2_999, headline: "Older correction" }))).toBe(
      false,
    );

    expect(history.get(sessionKey)).toEqual([
      expect.objectContaining({
        revision: 3,
        assessment: "Live detail",
        planProgress: { completed: 1, total: 2 },
      }),
    ]);
  });

  it("retains the newest fifty entries across run changes", () => {
    const history = new ObserverDigestHistory();
    for (let revision = 1; revision <= HISTORY_LIMIT + 5; revision += 1) {
      history.record(digest(revision, { runId: revision < 20 ? "run-previous" : "run-current" }));
    }

    const entries = history.get("agent:main:observer-history");
    expect(entries).toHaveLength(HISTORY_LIMIT);
    expect(entries[0]?.revision).toBe(6);
    expect(entries.at(-1)?.revision).toBe(55);
    expect(new Set(entries.map((entry) => entry.runId))).toEqual(
      new Set(["run-previous", "run-current"]),
    );
  });
});

describe("observer digest history hydration reconciliation", () => {
  it("adopts a later projection after history exists and rejects stale ones", () => {
    const history = new ObserverDigestHistory();
    const base = {
      sessionKey: "agent:main:s1",
      runId: "r1",
      revision: 2,
      updatedAt: 100,
      headline: "live",
      health: "on-track" as const,
    };
    expect(history.record(base)).toBe(true);
    expect(
      history.hydrate("agent:main:s1", {
        runId: "r1",
        revision: 3,
        updatedAt: 200,
        headline: "projection advanced",
        health: "grinding" as const,
      }),
    ).toBe(true);
    expect(history.get("agent:main:s1").at(-1)?.headline).toBe("projection advanced");
    // An unseen older revision backfills the timeline but must never
    // displace the newest entry that renders as current status.
    expect(
      history.hydrate("agent:main:s1", {
        runId: "r1",
        revision: 1,
        updatedAt: 50,
        headline: "stale projection",
        health: "on-track" as const,
      }),
    ).toBe(true);
    expect(history.get("agent:main:s1").map((entry) => entry.revision)).toEqual([1, 2, 3]);
    expect(history.get("agent:main:s1").at(-1)?.headline).toBe("projection advanced");
  });
});

describe("observer digest history session identity", () => {
  const entry = (revision: number, headline: string) => ({
    sessionKey: "agent:main:identity",
    runId: "r1",
    revision,
    updatedAt: revision * 100,
    headline,
    health: "on-track" as const,
  });

  it("clears history when the authoritative row reports a new sessionId", () => {
    const history = new ObserverDigestHistory();
    history.record(entry(1, "old conversation"));
    expect(history.sync("agent:main:identity", "session-a")).toBe(false);
    expect(history.sync("agent:main:identity", "session-a")).toBe(false);
    expect(history.sync("agent:main:identity", "session-b")).toBe(true);
    expect(history.get("agent:main:identity")).toEqual([]);
  });

  it("preserves replacement-conversation state when reset lands after the new row", () => {
    const history = new ObserverDigestHistory();
    history.hydrate("agent:main:identity", entry(1, "pre-reset"), "session-a");
    history.sync("agent:main:identity", "session-b");
    history.hydrate("agent:main:identity", entry(2, "fresh conversation"), "session-b");
    history.markReset("agent:main:identity", "session-a");
    expect(history.get("agent:main:identity").at(-1)?.headline).toBe("fresh conversation");
    expect(history.hydrate("agent:main:identity", entry(3, "still fresh"), "session-b")).toBe(true);
  });

  it("sweeps late pre-reset live events when the replacement row arrives", () => {
    const history = new ObserverDigestHistory();
    history.hydrate("agent:main:identity", entry(3, "pre-reset"), "session-a");
    history.markReset("agent:main:identity", "session-a");
    history.record(entry(3, "late pre-reset event"));
    expect(history.get("agent:main:identity").at(-1)?.headline).toBe("late pre-reset event");
    expect(history.sync("agent:main:identity", "session-b")).toBe(true);
    expect(history.get("agent:main:identity")).toEqual([]);
  });

  it("detects a remote reset even when the id was learned before any digest", () => {
    const history = new ObserverDigestHistory();
    expect(history.sync("agent:main:identity", "session-a")).toBe(false);
    history.record(entry(1, "first digest"));
    expect(history.sync("agent:main:identity", "session-b")).toBe(true);
    expect(history.get("agent:main:identity")).toEqual([]);
  });

  it("refuses stale-row echoes after a local reset until a new sessionId arrives", () => {
    const history = new ObserverDigestHistory();
    history.hydrate("agent:main:identity", entry(4, "pre-reset"), "session-a");
    history.markReset("agent:main:identity", "session-a");
    expect(history.get("agent:main:identity")).toEqual([]);
    expect(history.hydrate("agent:main:identity", entry(4, "echo"), "session-a")).toBe(false);
    expect(history.get("agent:main:identity")).toEqual([]);
    expect(history.hydrate("agent:main:identity", entry(5, "fresh"), "session-b")).toBe(true);
    expect(history.get("agent:main:identity").at(-1)?.headline).toBe("fresh");
  });
});
