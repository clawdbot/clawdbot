/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOBSTER_PET_ACT_DURATION_MS,
  LOBSTER_PET_MODE_ACTS,
  createLobsterPetLook,
  lobsterPetSeed,
  resolveLobsterPetMode,
  type LobsterPet,
  type LobsterPetMode,
} from "./lobster-pet.ts";

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("lobster pet look", () => {
  it("is deterministic per seed", () => {
    expect(createLobsterPetLook(1234)).toEqual(createLobsterPetLook(1234));
  });

  it("stays within the variant catalog for many seeds", () => {
    const palettes = new Set<string>();
    const personalities = new Set<string>();
    for (let seed = 0; seed < 300; seed++) {
      const look = createLobsterPetLook(seed);
      palettes.add(look.palette.id);
      personalities.add(look.personality);
      expect(["crimson", "coral", "teal", "violet", "ink", "gold"]).toContain(look.palette.id);
      expect([1.7, 2, 2.5]).toContain(look.scale);
      expect(["none", "crown", "sprout", "patch"]).toContain(look.accessory);
      expect(["perky", "droopy"]).toContain(look.antennae);
      const zone = SPOT_ZONES[look.side];
      expect(look.spotPct).toBeGreaterThanOrEqual(zone[0]);
      expect(look.spotPct).toBeLessThanOrEqual(zone[1]);
    }
    // Sessions should feel different: many seeds must not collapse onto one look.
    expect(palettes.size).toBeGreaterThan(2);
    expect(personalities.size).toBeGreaterThan(2);
  });

  it("derives distinct salted seeds per session key, stable within a load", () => {
    expect(lobsterPetSeed("agent:a:main")).toBe(lobsterPetSeed("agent:a:main"));
    expect(lobsterPetSeed("agent:a:main")).not.toBe(lobsterPetSeed("agent:b:other"));
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
  it("renders the sprite and schedules acts", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await element.updateComplete;

    expect(element.querySelector(".lobster-pet__svg")).not.toBeNull();
    expect(spriteClasses(element)).toContain("lobster-pet--idle");

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
    const element = createPet(42);
    await element.updateComplete;

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

  it("paces from the offline pool while disconnected", async () => {
    vi.useFakeTimers();
    const element = createPet(7, "offline");
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--offline");

    const offlineActs = LOBSTER_PET_MODE_ACTS.offline.acts.map(([act]) => act);
    const act = await advanceUntilAct(element, 10_000);
    expect(offlineActs).toContain(act);
  });

  it("startles when poked", async () => {
    vi.useFakeTimers();
    const element = createPet(7);
    await element.updateComplete;

    element.querySelector(".lobster-pet")?.dispatchEvent(new Event("pointerdown"));
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("lobster-pet--act-startle");
  });

  it("stops timers on disconnect", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await element.updateComplete;

    element.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays static when reduced motion is preferred, including visibility resumes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const element = createPet(42);
    await element.updateComplete;

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
