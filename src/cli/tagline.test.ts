// Tagline tests cover CLI tagline selection and display formatting.
import { describe, expect, it } from "vitest";
import { pickTagline } from "./tagline.js";

const EXPECTED_DEFAULT_TAGLINE = "All your chats, one OpenClaw.";

describe("pickTagline", () => {
  it("returns empty string when mode is off", () => {
    expect(pickTagline({ mode: "off" })).toBe("");
  });

  it("returns default tagline when mode is default", () => {
    expect(pickTagline({ mode: "default" })).toBe(EXPECTED_DEFAULT_TAGLINE);
  });

  it("keeps OPENCLAW_TAGLINE_INDEX behavior in random mode", () => {
    const value = pickTagline({
      mode: "random",
      env: { OPENCLAW_TAGLINE_INDEX: "0" } as NodeJS.ProcessEnv,
    });
    expect(value).toBe(
      "Your terminal just grew claws\u2014type something and let the bot pinch the busywork.",
    );
    expect(value).not.toBe(EXPECTED_DEFAULT_TAGLINE);
  });

  it("ignores partial OPENCLAW_TAGLINE_INDEX values", () => {
    expect(
      pickTagline({
        mode: "random",
        env: { OPENCLAW_TAGLINE_INDEX: "1abc" } as NodeJS.ProcessEnv,
        random: () => 0,
      }),
    ).toBe("Your terminal just grew claws\u2014type something and let the bot pinch the busywork.");
  });
});

describe("future holiday tagline windows (2028-2030)", () => {
  // Regression coverage for the 2028-2030 floating-holiday rows. Before those
  // rows existed, the holiday rule returned false for these dates and the
  // tagline was silently filtered out of the active pool. activeTaglines is no
  // longer exported, so we sample the public pickTagline() across every pool
  // index (by sweeping the injected random()) to recover the full active pool
  // for a given date, then assert the matching holiday tagline is present.
  // UTC dates are used because the holiday rules compare in UTC.
  const activePoolOn = (year: number, monthIndex: number, day: number): string[] => {
    const now = () => new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = i / 200;
      seen.add(pickTagline({ mode: "random", now, random: () => r }));
    }
    return [...seen];
  };
  const poolHas = (pool: string[], term: string) =>
    pool.some((t) => t.toLowerCase().includes(term));

  it("activates the Lunar New Year tagline on 2028-01-26", () => {
    expect(poolHas(activePoolOn(2028, 0, 26), "lunar new year")).toBe(true);
  });

  it("activates the Diwali tagline on 2029-11-05", () => {
    expect(poolHas(activePoolOn(2029, 10, 5), "diwali")).toBe(true);
  });

  it("activates the Diwali tagline on 2030-10-25", () => {
    expect(poolHas(activePoolOn(2030, 9, 25), "diwali")).toBe(true);
  });

  it("activates the Easter tagline on 2030-04-21", () => {
    expect(poolHas(activePoolOn(2030, 3, 21), "easter")).toBe(true);
  });

  it("activates the Hanukkah tagline across its full 2028 window (Dec 13 and Dec 20)", () => {
    expect(poolHas(activePoolOn(2028, 11, 13), "hanukkah")).toBe(true);
    expect(poolHas(activePoolOn(2028, 11, 20), "hanukkah")).toBe(true);
  });

  it("does not activate floating holiday taglines on a plain date (2028-07-15)", () => {
    const pool = activePoolOn(2028, 6, 15);
    for (const term of ["lunar new year", "diwali", "easter", "hanukkah", "eid al-fitr"]) {
      expect(poolHas(pool, term)).toBe(false);
    }
  });
});
