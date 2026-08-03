// Line tests cover group history plugin behavior.
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { describe, expect, it } from "vitest";
import { reserveLineGroupHistory } from "./group-history.js";

const entry = (body: string, timestamp: number): HistoryEntry => ({
  sender: "user:U1",
  body,
  timestamp,
});

describe("reserveLineGroupHistory", () => {
  it("renders the bounded window and commits every entry that was available", () => {
    const first = entry("a", 1);
    const second = entry("b", 2);
    const third = entry("c", 3);
    const map = new Map([["G", [first, second, third]]]);

    const reservation = reserveLineGroupHistory(map, "G", 2);

    expect(reservation.inboundHistory).toEqual([second, third]);
    reservation.commit();
    expect(map.has("G")).toBe(false);
  });

  it("keeps an otherwise identical concurrent entry under its own reservation", () => {
    const before = entry("same", 1);
    const concurrent = entry("same", 1);
    const map = new Map([["G", [before]]]);
    const first = reserveLineGroupHistory(map, "G", 10);
    map.get("G")?.push(concurrent);
    const second = reserveLineGroupHistory(map, "G", 10);

    expect(first.inboundHistory).toEqual([before]);
    expect(second.inboundHistory).toEqual([concurrent]);
    first.commit();
    second.release();

    expect(map.get("G")).toEqual([concurrent]);
  });

  it("hides reserved entries from overlapping turns and exposes them after release", () => {
    const pending = entry("pending", 1);
    const map = new Map([["G", [pending]]]);
    const first = reserveLineGroupHistory(map, "G", 10);
    const overlapping = reserveLineGroupHistory(map, "G", 10);

    expect(first.inboundHistory).toEqual([pending]);
    expect(overlapping.inboundHistory).toEqual([]);
    overlapping.release();
    first.release();

    const retry = reserveLineGroupHistory(map, "G", 10);
    expect(retry.inboundHistory).toEqual([pending]);
    retry.commit();
    expect(map.has("G")).toBe(false);
  });

  it("release preserves history and settlement is idempotent", () => {
    const pending = entry("pending", 1);
    const map = new Map([["G", [pending]]]);
    const reservation = reserveLineGroupHistory(map, "G", 10);

    reservation.release();
    reservation.commit();

    expect(map.get("G")).toEqual([pending]);
  });

  it("returns no-op reservations without a map, key, or positive limit", () => {
    const reservations = [
      reserveLineGroupHistory(undefined, "G", 10),
      reserveLineGroupHistory(new Map(), undefined, 10),
      reserveLineGroupHistory(new Map([["G", [entry("a", 1)]]]), "G", 0),
    ];

    for (const reservation of reservations) {
      expect(reservation.inboundHistory).toBeUndefined();
      reservation.commit();
      reservation.release();
    }
  });
});
