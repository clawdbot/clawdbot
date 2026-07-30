// Lobster-day art is deterministic per calendar day; tests pin dates probed
// against the day hash (2026-01-05 and 2026-02-26 hit, 2026-01-01 misses).
import { describe, expect, it } from "vitest";
import { pickCliLobsterArt } from "./lobster-art.ts";

const cleanEnv = {} as NodeJS.ProcessEnv;

describe("pickCliLobsterArt", () => {
  it("is deterministic for a given day", () => {
    const day = new Date(2026, 0, 5);
    const art = pickCliLobsterArt(day, cleanEnv);
    expect(art).toBeTruthy();
    expect(pickCliLobsterArt(new Date(2026, 0, 5), cleanEnv)).toBe(art);
  });

  it("returns null on non-lobster days", () => {
    expect(pickCliLobsterArt(new Date(2026, 0, 1), cleanEnv)).toBeNull();
  });

  it("stays rare across a year of days", () => {
    let hits = 0;
    for (let offset = 0; offset < 400; offset++) {
      if (pickCliLobsterArt(new Date(2026, 0, 1 + offset), cleanEnv)) {
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(60);
  });

  it("stays out of CI and test environments", () => {
    const day = new Date(2026, 0, 5);
    expect(pickCliLobsterArt(day, { CI: "1" } as NodeJS.ProcessEnv)).toBeNull();
    expect(pickCliLobsterArt(day, { VITEST: "true" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
