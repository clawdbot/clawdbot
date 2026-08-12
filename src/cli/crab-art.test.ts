// Crab-day art is deterministic per calendar day; tests pin dates probed
// against the day hash (2026-01-05 and 2026-02-26 hit, 2026-01-01 misses).
import { describe, expect, it } from "vitest";
import { pickCliCrabArt } from "./crab-art.ts";

const cleanEnv = {} as NodeJS.ProcessEnv;

describe("pickCliCrabArt", () => {
  it("is deterministic for a given day", () => {
    const day = new Date(2026, 0, 5);
    const art = pickCliCrabArt(day, cleanEnv);
    expect(art).toBeTruthy();
    expect(pickCliCrabArt(new Date(2026, 0, 5), cleanEnv)).toBe(art);
  });

  it("returns null on non-crab days", () => {
    expect(pickCliCrabArt(new Date(2026, 0, 1), cleanEnv)).toBeNull();
  });

  it("stays rare across a year of days", () => {
    let hits = 0;
    for (let offset = 0; offset < 400; offset++) {
      if (pickCliCrabArt(new Date(2026, 0, 1 + offset), cleanEnv)) {
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(60);
  });

  it("stays out of CI and test environments", () => {
    const day = new Date(2026, 0, 5);
    expect(pickCliCrabArt(day, { CI: "1" } as NodeJS.ProcessEnv)).toBeNull();
    expect(pickCliCrabArt(day, { VITEST: "true" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
