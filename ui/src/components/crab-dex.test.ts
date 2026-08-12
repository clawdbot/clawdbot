/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRAB_FAMILIARITY_TUNING,
  getCrabFamiliarity,
  getCrabdex,
  getCrabdexEntries,
  isCrabFirstVisitAnniversary,
  crabHonorific,
  recordCrabArrivalStats,
  recordCrabShoo,
  recordCrabVisit,
} from "./crab-dex.ts";

beforeEach(() => {
  // getSafeLocalStorage only accepts an own value property under Vitest, so
  // tests opt in by stubbing jsdom's storage onto globalThis.
  vi.stubGlobal("localStorage", window.localStorage);
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("crabdex", () => {
  it("records palettes once and round-trips through storage", () => {
    expect(getCrabdex().size).toBe(0);
    recordCrabVisit("emerald");
    recordCrabVisit("gold");
    recordCrabVisit("emerald");
    expect([...getCrabdex()].toSorted()).toEqual(["emerald", "gold"]);
  });

  it("remembers the first visitor's name and date, immutably", () => {
    const before = Date.now();
    recordCrabVisit("gold", { name: "Goldie" });
    const entry = getCrabdexEntries().get("gold");
    expect(entry?.name).toBe("Goldie");
    expect(entry?.firstSeenAt).toBeGreaterThanOrEqual(before);

    recordCrabVisit("gold", { name: "Impostor" });
    expect(getCrabdexEntries().get("gold")?.name).toBe("Goldie");
  });

  it("migrates v1 array entries and backfills memories on the next visit", () => {
    localStorage.setItem("openclaw.control.crabdex.v1", JSON.stringify(["crimson"]));
    // The legacy crimson id migrates to the emerald shell.
    const migrated = getCrabdexEntries().get("emerald");
    expect(migrated).toEqual({ firstSeenAt: null, name: null, shinySeenAt: null });
    expect(getCrabdex().has("emerald")).toBe(true);

    recordCrabVisit("emerald", { name: "Pinchy" });
    const backfilled = getCrabdexEntries().get("emerald");
    expect(backfilled?.name).toBe("Pinchy");
    expect(backfilled?.firstSeenAt).not.toBeNull();
  });

  it("logs the first shiny sighting once, even on settled entries", () => {
    recordCrabVisit("gold", { name: "Goldie" });
    expect(getCrabdexEntries().get("gold")?.shinySeenAt).toBeNull();

    const before = Date.now();
    recordCrabVisit("gold", { name: "Impostor", shiny: true });
    const shinySeenAt = getCrabdexEntries().get("gold")?.shinySeenAt;
    expect(shinySeenAt).toBeGreaterThanOrEqual(before);
    // The shiny backfill leaves the first-visitor memory untouched...
    expect(getCrabdexEntries().get("gold")?.name).toBe("Goldie");

    // ...and the sighting timestamp itself is immutable afterwards.
    recordCrabVisit("gold", { shiny: true });
    expect(getCrabdexEntries().get("gold")?.shinySeenAt).toBe(shinySeenAt);
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem("openclaw.control.crabdex.v1", "{not json");
    expect(getCrabdex().size).toBe(0);
    recordCrabVisit("blue");
    expect(getCrabdex().has("blue")).toBe(true);
  });
});

describe("crab familiarity", () => {
  it("tiers by visit count and grows wary of frequent shooing", () => {
    expect(getCrabFamiliarity()).toMatchObject({ tier: "shy", wary: false });
    for (let i = 0; i < 3; i++) {
      recordCrabArrivalStats();
    }
    expect(getCrabFamiliarity().tier).toBe("regular");
    for (let i = 0; i < 12; i++) {
      recordCrabArrivalStats();
    }
    expect(getCrabFamiliarity().tier).toBe("friend");

    for (let i = 0; i < 3; i++) {
      recordCrabShoo();
    }
    // 3 shoos over 15 visits is not wary yet (<= 30%); a few more are.
    expect(getCrabFamiliarity().wary).toBe(false);
    for (let i = 0; i < 3; i++) {
      recordCrabShoo();
    }
    expect(getCrabFamiliarity().wary).toBe(true);
  });

  it("keeps the tuning table sane", () => {
    expect(CRAB_FAMILIARITY_TUNING.shy.stayMul).toBeLessThan(1);
    expect(CRAB_FAMILIARITY_TUNING.friend.stayMul).toBeGreaterThan(1);
    expect(CRAB_FAMILIARITY_TUNING.waryGapMul).toBeGreaterThan(1);
  });
});

describe("long memory", () => {
  it("awards honorifics at visit milestones", () => {
    expect(crabHonorific(0)).toBeNull();
    expect(crabHonorific(49)).toBeNull();
    expect(crabHonorific(50)).toBe("Sir");
    expect(crabHonorific(99)).toBe("Sir");
    expect(crabHonorific(100)).toBe("Captain");
    expect(crabHonorific(250)).toBe("Elder");
    expect(crabHonorific(9001)).toBe("Elder");
  });

  it("recognizes first-visit anniversaries by month and day", () => {
    const first = new Date("2025-07-09T15:30:00").getTime();
    expect(isCrabFirstVisitAnniversary(first, new Date("2026-07-09T09:00:00"))).toBe(true);
    expect(isCrabFirstVisitAnniversary(first, new Date("2027-07-09T21:00:00"))).toBe(true);
    expect(isCrabFirstVisitAnniversary(first, new Date("2026-07-10T09:00:00"))).toBe(false);
    expect(isCrabFirstVisitAnniversary(first, new Date("2026-06-09T09:00:00"))).toBe(false);
    expect(isCrabFirstVisitAnniversary(null, new Date("2026-07-09T09:00:00"))).toBe(false);
  });

  it("does not celebrate fresh memories", () => {
    // Same month/day but same moment (a first visit today) and short gaps
    // stay quiet; the celebration needs a real year behind it.
    const now = new Date("2026-07-09T12:00:00");
    expect(isCrabFirstVisitAnniversary(now.getTime(), now)).toBe(false);
    const lastMonth = new Date("2026-06-09T12:00:00").getTime();
    expect(isCrabFirstVisitAnniversary(lastMonth, new Date("2026-07-09T12:00:00"))).toBe(false);
  });

  it("celebrates leap-day firsts only on leap years", () => {
    const leapFirst = new Date("2024-02-29T12:00:00").getTime();
    expect(isCrabFirstVisitAnniversary(leapFirst, new Date("2028-02-29T12:00:00"))).toBe(true);
    expect(isCrabFirstVisitAnniversary(leapFirst, new Date("2026-02-28T12:00:00"))).toBe(false);
    expect(isCrabFirstVisitAnniversary(leapFirst, new Date("2026-03-01T12:00:00"))).toBe(false);
  });
});
