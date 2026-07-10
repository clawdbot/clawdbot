/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getLobsterdex } from "./lobster-dex.ts";
import {
  LOBSTER_PET_ACT_DURATION_MS,
  LOBSTER_PET_MODE_ACTS,
  createLobsterPetLook,
  isLobsterMoltLoad,
  isLobsterNightTime,
  isLobsterTwinLoad,
  lobsterPetName,
  lobsterPetSeed,
  resolveLobsterPetMode,
  type LobsterPet,
  type LobsterPetMode,
  type LobsterPetPaletteId,
} from "./lobster-pet.ts";

const LOBSTER_PET_PALETTE_IDS: LobsterPetPaletteId[] = [
  "crimson",
  "coral",
  "teal",
  "violet",
  "ink",
  "blue",
  "gold",
  "calico",
  "abyss",
  "ghost",
  "split",
  "retro",
];

const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;

type LobsterPetElement = LobsterPet & HTMLElement;

function createPet(seed: number, mode: LobsterPetMode = "idle"): LobsterPetElement {
  const element = document.createElement("openclaw-lobster-pet") as LobsterPetElement;
  element.seed = seed;
  element.mode = mode;
  document.body.append(element);
  return element;
}

function spriteClasses(element: LobsterPetElement): string {
  return element.querySelector(".lobster-pet")?.className ?? "";
}

function spritePresent(element: LobsterPetElement): boolean {
  return element.querySelector(".lobster-pet") !== null;
}

async function advanceUntilAct(element: LobsterPetElement, maxMs: number): Promise<string | null> {
  let elapsed = 0;
  while (elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(200);
    elapsed += 200;
    await element.updateComplete;
    const match = /lobster-pet--act-([a-z]+)/.exec(spriteClasses(element));
    if (match) {
      return match[1];
    }
  }
  return null;
}

async function advanceUntil(
  element: LobsterPetElement,
  predicate: () => boolean,
  maxMs: number,
): Promise<boolean> {
  let elapsed = 0;
  while (elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(1000);
    elapsed += 1000;
    await element.updateComplete;
    if (predicate()) {
      return true;
    }
  }
  return predicate();
}

// Seed 42's visit schedule is not shy and first arrives at ~89s; jump past
// the maximum first-arrival delay so tests start with a perched pet.
async function arrive(element: LobsterPetElement): Promise<void> {
  await advanceUntil(element, () => spritePresent(element), 200_000);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("lobster pet look", () => {
  it("is deterministic per seed", () => {
    expect(createLobsterPetLook(1234)).toEqual(createLobsterPetLook(1234));
  });

  it("stays within the variant catalog for many seeds", () => {
    const palettes = new Set<string>();
    const personalities = new Set<string>();
    const builds = new Set<string>();
    const clawSizes = new Set<string>();
    const tailFans = new Set<boolean>();
    const neutralDate = new Date("2026-07-15T12:00:00");
    for (let seed = 0; seed < 300; seed++) {
      const look = createLobsterPetLook(seed, neutralDate);
      palettes.add(look.palette.id);
      personalities.add(look.personality);
      builds.add(look.build);
      clawSizes.add(look.clawSize);
      tailFans.add(look.tailFan);
      expect(LOBSTER_PET_PALETTE_IDS).toContain(look.palette.id);
      expect([1.7, 2, 2.5]).toContain(look.scale);
      expect(["none", "crown", "sprout", "patch"]).toContain(look.accessory);
      expect(["perky", "droopy"]).toContain(look.antennae);
      expect(["round", "squat", "slender"]).toContain(look.build);
      expect(["dainty", "regular", "mighty"]).toContain(look.clawSize);
      const zone = SPOT_ZONES[look.side];
      expect(look.spotPct).toBeGreaterThanOrEqual(zone[0]);
      expect(look.spotPct).toBeLessThanOrEqual(zone[1]);
    }
    // Sessions should feel different: many seeds must not collapse onto one look.
    expect(palettes.size).toBeGreaterThan(2);
    expect(personalities.size).toBeGreaterThan(2);
    expect(builds.size).toBe(3);
    expect(clawSizes.size).toBe(3);
    expect(tailFans.size).toBe(2);
  });

  it("hatches every rarity tier, with rares staying rare", () => {
    const counts = new Map<string, number>();
    const total = 20_000;
    const neutralDate = new Date("2026-07-15T12:00:00");
    for (let seed = 0; seed < total; seed++) {
      const id = createLobsterPetLook(seed, neutralDate).palette.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // Every palette, including the 1% grails, must be reachable.
    for (const id of LOBSTER_PET_PALETTE_IDS) {
      expect(counts.get(id) ?? 0).toBeGreaterThan(0);
    }
    // Grails stay grails: ghost/split roll ~1%, retro ~0.5%; commons dominate.
    for (const grail of ["ghost", "split", "retro"]) {
      expect(counts.get(grail) ?? 0).toBeLessThan(total * 0.03);
    }
    expect((counts.get("crimson") ?? 0) + (counts.get("coral") ?? 0)).toBeGreaterThan(total * 0.4);
  });

  it("derives distinct salted seeds per session key, stable within a load", () => {
    expect(lobsterPetSeed("agent:a:main")).toBe(lobsterPetSeed("agent:a:main"));
    expect(lobsterPetSeed("agent:a:main")).not.toBe(lobsterPetSeed("agent:b:other"));
  });
});

describe("lobsterPetName", () => {
  it("is deterministic and rare palettes carry signature names", () => {
    for (let seed = 0; seed < 50; seed++) {
      const look = createLobsterPetLook(seed);
      const name = lobsterPetName(look, seed);
      expect(name).toBe(lobsterPetName(look, seed));
      expect(name.length).toBeGreaterThan(1);
    }
    const retroLook = {
      ...createLobsterPetLook(1),
      palette: { id: "retro" as const, shell: "#e8262c", claw: "#f04a3e" },
    };
    expect(lobsterPetName(retroLook, 1)).toBe("OG");
    const goldLook = {
      ...createLobsterPetLook(1),
      palette: { id: "gold" as const, shell: "#f4b840", claw: "#f9d47a" },
    };
    expect(lobsterPetName(goldLook, 1)).toBe("Goldie");
  });
});

describe("seasonal wardrobe", () => {
  it("adds santa hats in December and pumpkins in late October", () => {
    const december = new Date("2026-12-10T12:00:00");
    const october = new Date("2026-10-25T12:00:00");
    const july = new Date("2026-07-15T12:00:00");
    const accessoriesOn = (date: Date) =>
      new Set(Array.from({ length: 400 }, (_, seed) => createLobsterPetLook(seed, date).accessory));
    const decemberSet = accessoriesOn(december);
    expect(decemberSet.has("santa")).toBe(true);
    expect(decemberSet.has("pumpkin")).toBe(false);
    const octoberSet = accessoriesOn(october);
    expect(octoberSet.has("pumpkin")).toBe(true);
    expect(octoberSet.has("santa")).toBe(false);
    const julySet = accessoriesOn(july);
    expect(julySet.has("santa")).toBe(false);
    expect(julySet.has("pumpkin")).toBe(false);
    expect(julySet.has("party")).toBe(false);
  });

  it("dresses everyone as the classic logo on the repo anniversary", () => {
    const anniversary = new Date("2026-11-24T12:00:00");
    for (let seed = 0; seed < 50; seed++) {
      const look = createLobsterPetLook(seed, anniversary);
      expect(look.palette.id).toBe("retro");
      expect(look.accessory).toBe("party");
    }
    // The day after is business as usual.
    const after = createLobsterPetLook(7, new Date("2026-11-25T12:00:00"));
    expect(after.accessory).not.toBe("party");
  });
});

describe("resolveLobsterPetMode", () => {
  it("maps connection and run state to modes", () => {
    expect(resolveLobsterPetMode(false, [{ hasActiveRun: true }])).toBe("offline");
    expect(resolveLobsterPetMode(true, null)).toBe("idle");
    expect(resolveLobsterPetMode(true, [{ hasActiveRun: false }, {}])).toBe("idle");
    expect(resolveLobsterPetMode(true, [{ hasActiveRun: false }, { hasActiveRun: true }])).toBe(
      "busy",
    );
  });
});

describe("lobster pet element", () => {
  it("starts hidden and arrives on its seeded visit schedule", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await element.updateComplete;

    expect(spritePresent(element)).toBe(false);
    await arrive(element);
    expect(element.querySelector(".lobster-pet__svg")).not.toBeNull();
    expect(spriteClasses(element)).toContain("lobster-pet--idle");
    expect(["ledge", "bar"]).toContain(element.getAttribute("data-spot"));
  });

  it("shy seeds never visit on their own", async () => {
    vi.useFakeTimers();
    const element = createPet(7);
    await element.updateComplete;

    const arrived = await advanceUntil(element, () => spritePresent(element), 600_000);
    expect(arrived).toBe(false);
  });

  it("departs after its stay and returns for a later visit", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await arrive(element);

    const departed = await advanceUntil(element, () => !spritePresent(element), 400_000);
    expect(departed).toBe(true);

    const returned = await advanceUntil(element, () => spritePresent(element), 1_300_000);
    expect(returned).toBe(true);
  });

  it("schedules acts while perched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    const act = await advanceUntilAct(element, 20_000);
    expect(act).not.toBeNull();
    expect(Object.keys(LOBSTER_PET_ACT_DURATION_MS)).toContain(act);

    // The act window closes and the pet returns to idle.
    await vi.advanceTimersByTimeAsync(
      LOBSTER_PET_ACT_DURATION_MS[act as keyof typeof LOBSTER_PET_ACT_DURATION_MS],
    );
    await element.updateComplete;
    expect(spriteClasses(element)).not.toContain("lobster-pet--act-");
  });

  it("startles on mode changes and then draws from the new mode's pool", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    element.mode = "busy";
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
    expect(spriteClasses(element)).toContain("lobster-pet--busy");

    await vi.advanceTimersByTimeAsync(LOBSTER_PET_ACT_DURATION_MS.startle);
    const busyActs = LOBSTER_PET_MODE_ACTS.busy.acts.map(([act]) => act);
    for (let i = 0; i < 3; i++) {
      const act = await advanceUntilAct(element, 10_000);
      expect(busyActs).toContain(act);
      await vi.advanceTimersByTimeAsync(
        LOBSTER_PET_ACT_DURATION_MS[act as keyof typeof LOBSTER_PET_ACT_DURATION_MS],
      );
    }
  });

  it("offline summons even shy pets immediately and paces from the offline pool", async () => {
    vi.useFakeTimers();
    const element = createPet(7, "offline");
    await element.updateComplete;

    expect(spritePresent(element)).toBe(true);
    expect(spriteClasses(element)).toContain("lobster-pet--offline");

    const offlineActs = LOBSTER_PET_MODE_ACTS.offline.acts.map(([act]) => act);
    const act = await advanceUntilAct(element, 10_000);
    expect(offlineActs).toContain(act);
  });

  it("startles when poked", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await arrive(element);

    element.querySelector(".lobster-pet")?.dispatchEvent(new Event("pointerdown"));
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
  });

  it("right-click shoos it away for the rest of the load", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await arrive(element);

    const shoo = new Event("contextmenu", { cancelable: true });
    element.querySelector(".lobster-pet")?.dispatchEvent(shoo);
    await element.updateComplete;
    expect(shoo.defaultPrevented).toBe(true);

    const gone = await advanceUntil(element, () => !spritePresent(element), 5_000);
    expect(gone).toBe(true);

    // Dismissal outlasts later scheduled visits and even offline summons.
    const revisited = await advanceUntil(element, () => spritePresent(element), 2_400_000);
    expect(revisited).toBe(false);
    element.mode = "offline";
    await element.updateComplete;
    expect(spritePresent(element)).toBe(false);
  });

  it("never shows when visits are disabled, offline included", async () => {
    vi.useFakeTimers();
    const element = createPet(42, "offline");
    element.visitsEnabled = false;
    await element.updateComplete;

    expect(spritePresent(element)).toBe(false);
    const appeared = await advanceUntil(element, () => spritePresent(element), 1_200_000);
    expect(appeared).toBe(false);
  });

  it("stops timers on disconnect", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await arrive(element);

    element.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("celebrates when a run finishes and startles on other status flips", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42, "busy");
    await arrive(element);

    element.mode = "idle";
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--act-cheer");

    await vi.advanceTimersByTimeAsync(LOBSTER_PET_ACT_DURATION_MS.cheer);
    element.mode = "offline";
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
  });

  it("gets grumpy after three fast pokes and recovers after a minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    for (let i = 0; i < 3; i++) {
      element.querySelector(".lobster-pet")?.dispatchEvent(new Event("pointerdown"));
      await element.updateComplete;
    }
    expect(spriteClasses(element)).toContain("lobster-pet--grumpy");

    await vi.advanceTimersByTimeAsync(61_000);
    await element.updateComplete;
    expect(spriteClasses(element)).not.toContain("lobster-pet--grumpy");
  });

  it("leaves in a huff after ten pokes but returns for a later visit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    for (let i = 0; i < 10; i++) {
      element.querySelector(".lobster-pet")?.dispatchEvent(new Event("pointerdown"));
      await element.updateComplete;
    }
    const gone = await advanceUntil(element, () => !spritePresent(element), 5_000);
    expect(gone).toBe(true);

    const returned = await advanceUntil(element, () => spritePresent(element), 1_300_000);
    expect(returned).toBe(true);
  });

  it("night visits act sleepy regardless of personality", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T23:30:00"));
    expect(isLobsterNightTime()).toBe(true);
    const element = createPet(42);
    await arrive(element);

    // Sleepy-pool exclusives (nap/bubble) never appear in zoomy/showoff pools;
    // observing one proves the override. Seeded, so the sequence is stable.
    const seen = new Set<string>();
    for (let i = 0; i < 6 && !(seen.has("nap") || seen.has("bubble")); i++) {
      const act = await advanceUntilAct(element, 30_000);
      if (act) {
        seen.add(act);
        await vi.advanceTimersByTimeAsync(
          LOBSTER_PET_ACT_DURATION_MS[act as keyof typeof LOBSTER_PET_ACT_DURATION_MS],
        );
      }
    }
    expect(seen.has("nap") || seen.has("bubble")).toBe(true);
  });

  it("molt loads shed a fading shell and size up one tier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    // Seed 2 plans a molt (and no twin); probed via the pure planners.
    expect(isLobsterMoltLoad(2)).toBe(true);
    expect(isLobsterTwinLoad(2)).toBe(false);
    const preScale = createLobsterPetLook(2).scale;
    const element = createPet(2);
    await arrive(element);

    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBe("molt");
    await vi.advanceTimersByTimeAsync(LOBSTER_PET_ACT_DURATION_MS.molt + 100);
    await element.updateComplete;

    expect(element.querySelector(".lobster-pet--shell")).not.toBeNull();
    const mainStyle =
      element.querySelector(".lobster-pet:not(.lobster-pet--shell)")?.getAttribute("style") ?? "";
    const tiers = [1.7, 2, 2.5];
    const expected = tiers[Math.min(tiers.indexOf(preScale) + 1, tiers.length - 1)];
    expect(mainStyle).toContain(`--lob-scale:${expected}`);

    // The shell fades out after a minute; only one molt per load.
    await vi.advanceTimersByTimeAsync(61_000);
    await element.updateComplete;
    expect(element.querySelector(".lobster-pet--shell")).toBeNull();
    const nextAct = await advanceUntilAct(element, 30_000);
    expect(nextAct).not.toBe("molt");
  });

  it("shooing the pet also clears a fading molt shell", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(2);
    await arrive(element);
    await advanceUntilAct(element, 30_000);
    await vi.advanceTimersByTimeAsync(LOBSTER_PET_ACT_DURATION_MS.molt + 100);
    await element.updateComplete;
    expect(element.querySelector(".lobster-pet--shell")).not.toBeNull();

    element
      .querySelector(".lobster-pet:not(.lobster-pet--shell)")
      ?.dispatchEvent(new Event("contextmenu", { cancelable: true }));
    await element.updateComplete;
    expect(element.querySelector(".lobster-pet--shell")).toBeNull();
  });

  it("twin loads bring a mini copycat that leaves with the visit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    expect(isLobsterTwinLoad(21)).toBe(true);
    const element = createPet(21);
    await arrive(element);

    const sprites = element.querySelectorAll(".lobster-pet:not(.lobster-pet--shell)");
    expect(sprites.length).toBe(2);
    const twin = element.querySelector(".lobster-pet--twin");
    expect(twin).not.toBeNull();
    expect(twin?.getAttribute("title")).toMatch(/ Jr\.$/);

    const departed = await advanceUntil(
      element,
      () => element.querySelectorAll(".lobster-pet").length === 0,
      400_000,
    );
    expect(departed).toBe(true);
  });

  it("plain loads stay solo and never molt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    expect(isLobsterMoltLoad(4)).toBe(false);
    expect(isLobsterTwinLoad(4)).toBe(false);
    const element = createPet(4);
    await arrive(element);

    expect(element.querySelectorAll(".lobster-pet").length).toBe(1);
    for (let i = 0; i < 3; i++) {
      const act = await advanceUntilAct(element, 30_000);
      expect(act).not.toBe("molt");
      if (act) {
        await vi.advanceTimersByTimeAsync(
          LOBSTER_PET_ACT_DURATION_MS[act as keyof typeof LOBSTER_PET_ACT_DURATION_MS],
        );
      }
    }
  });

  it("logs arrivals in the lobsterdex", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    const element = createPet(42);
    await element.updateComplete;
    expect(getLobsterdex().size).toBe(0);

    await arrive(element);
    const paletteId = createLobsterPetLook(42, new Date("2026-07-09T12:00:00")).palette.id;
    expect(getLobsterdex().has(paletteId)).toBe(true);
  });

  it("stays static when reduced motion is preferred, including visibility resumes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const element = createPet(42);
    await arrive(element);

    expect(element.querySelector(".lobster-pet__svg")).not.toBeNull();
    // Tab switches re-enter through the visibilitychange resume path, which
    // must stay inert under reduced motion too. Mode flips must not startle.
    document.dispatchEvent(new Event("visibilitychange"));
    element.mode = "busy";
    await element.updateComplete;
    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBeNull();
  });
});
