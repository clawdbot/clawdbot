/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOBSTER_FAMILIARITY_TUNING,
  getLobsterFamiliarity,
  getLobsterdex,
  getLobsterdexEntries,
  recordLobsterArrivalStats,
  recordLobsterShoo,
  recordLobsterVisit,
} from "./lobster-dex.ts";

beforeEach(() => {
  // getSafeLocalStorage only accepts an own value property under Vitest, so
  // tests opt in by stubbing jsdom's storage onto globalThis.
  vi.stubGlobal("localStorage", window.localStorage);
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("lobsterdex", () => {
  it("records palettes once and round-trips through storage", () => {
    expect(getLobsterdex().size).toBe(0);
    recordLobsterVisit("crimson");
    recordLobsterVisit("gold");
    recordLobsterVisit("crimson");
    expect([...getLobsterdex()].toSorted()).toEqual(["crimson", "gold"]);
  });

  it("remembers the first visitor's name and date, immutably", () => {
    const before = Date.now();
    recordLobsterVisit("gold", { name: "Goldie" });
    const entry = getLobsterdexEntries().get("gold");
    expect(entry?.name).toBe("Goldie");
    expect(entry?.firstSeenAt).toBeGreaterThanOrEqual(before);

    recordLobsterVisit("gold", { name: "Impostor" });
    expect(getLobsterdexEntries().get("gold")?.name).toBe("Goldie");
  });

  it("migrates v1 array entries and backfills memories on the next visit", () => {
    localStorage.setItem("openclaw.control.lobsterdex.v1", JSON.stringify(["crimson"]));
    const migrated = getLobsterdexEntries().get("crimson");
    expect(migrated).toEqual({ firstSeenAt: null, name: null });
    expect(getLobsterdex().has("crimson")).toBe(true);

    recordLobsterVisit("crimson", { name: "Pinchy" });
    const backfilled = getLobsterdexEntries().get("crimson");
    expect(backfilled?.name).toBe("Pinchy");
    expect(backfilled?.firstSeenAt).not.toBeNull();
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem("openclaw.control.lobsterdex.v1", "{not json");
    expect(getLobsterdex().size).toBe(0);
    recordLobsterVisit("teal");
    expect(getLobsterdex().has("teal")).toBe(true);
  });
});

describe("lobster familiarity", () => {
  it("tiers by visit count and grows wary of frequent shooing", () => {
    expect(getLobsterFamiliarity()).toMatchObject({ tier: "shy", wary: false });
    for (let i = 0; i < 3; i++) {
      recordLobsterArrivalStats();
    }
    expect(getLobsterFamiliarity().tier).toBe("regular");
    for (let i = 0; i < 12; i++) {
      recordLobsterArrivalStats();
    }
    expect(getLobsterFamiliarity().tier).toBe("friend");

    for (let i = 0; i < 3; i++) {
      recordLobsterShoo();
    }
    // 3 shoos over 15 visits is not wary yet (<= 30%); a few more are.
    expect(getLobsterFamiliarity().wary).toBe(false);
    for (let i = 0; i < 3; i++) {
      recordLobsterShoo();
    }
    expect(getLobsterFamiliarity().wary).toBe(true);
  });

  it("keeps the tuning table sane", () => {
    expect(LOBSTER_FAMILIARITY_TUNING.shy.stayMul).toBeLessThan(1);
    expect(LOBSTER_FAMILIARITY_TUNING.friend.stayMul).toBeGreaterThan(1);
    expect(LOBSTER_FAMILIARITY_TUNING.waryGapMul).toBeGreaterThan(1);
  });
});
