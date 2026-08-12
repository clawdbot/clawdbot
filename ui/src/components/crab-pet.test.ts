/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCrabdex, getCrabdexEntries } from "./crab-dex.ts";
import {
  CRAB_BOTTLE_FORTUNES,
  pickCrabEntrance,
  planCrabBottle,
  planCrabPasser,
  resolveCrabLoadIdentity,
} from "./crab-pet-plans.ts";
import {
  CRAB_PET_PALETTES,
  canonicalCrabLook,
  createCrabPetLook,
  renderCrabSvg,
  resolveCrabPetMode,
  resolveCrabRunOutcome,
} from "./crab-pet.ts";

type CrabPetMode = ReturnType<typeof resolveCrabPetMode>;

type CrabPetElement = HTMLElement & {
  gatewayVersion: string | null;
  mode: CrabPetMode;
  runOutcome: "ok" | "error" | "aborted";
  seed: number;
  soundsEnabled: boolean;
  updateComplete: Promise<boolean>;
  visitsEnabled: boolean;
};

function createPet(seed: number, mode: CrabPetMode = "idle"): CrabPetElement {
  const element = document.createElement("openclaw-crab-pet") as CrabPetElement;
  element.seed = seed;
  element.mode = mode;
  document.body.append(element);
  return element;
}

function poke(element: CrabPetElement): void {
  const sprite = element.querySelector(".crab-pet");
  sprite?.dispatchEvent(new Event("pointerdown"));
  sprite?.dispatchEvent(new Event("pointerup"));
}

function spriteClasses(element: CrabPetElement): string {
  return element.querySelector(".crab-pet")?.className ?? "";
}

function spritePresent(element: CrabPetElement): boolean {
  return element.querySelector(".crab-pet") !== null;
}

async function advanceUntilAct(element: CrabPetElement, maxMs: number): Promise<string | null> {
  let elapsed = 0;
  while (elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(200);
    elapsed += 200;
    await element.updateComplete;
    const match = /crab-pet--act-([a-z]+)/.exec(spriteClasses(element));
    if (match) {
      return expectDefined(match[1], "crab act name");
    }
  }
  return null;
}

async function advanceUntil(
  element: CrabPetElement,
  predicate: () => boolean,
  maxMs: number,
  stepMs = 1000,
): Promise<boolean> {
  let elapsed = 0;
  while (elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    elapsed += stepMs;
    await element.updateComplete;
    if (predicate()) {
      return true;
    }
  }
  return predicate();
}

// Seed 42's visit schedule is not shy and first arrives at ~89s; jump past
// the maximum first-arrival delay so tests start with a perched pet.
async function arrive(element: CrabPetElement): Promise<void> {
  await advanceUntil(element, () => spritePresent(element), 200_000);
}

async function startVigilOnlyRun(outcome: CrabPetElement["runOutcome"]): Promise<CrabPetElement> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-09T12:00:00"));
  // Seed 0 opts out of scheduled visits and passers, so vigil is the only
  // presence owner when the run finishes.
  const element = createPet(0, "busy");
  element.runOutcome = outcome;
  await element.updateComplete;
  expect(spritePresent(element)).toBe(false);
  await vi.advanceTimersByTimeAsync(600_500);
  await element.updateComplete;
  expect(spriteClasses(element)).toContain("crab-pet--vigil");
  return element;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("seasonal wardrobe", () => {
  it("adds santa hats in December and pumpkins in late October", () => {
    const december = new Date("2026-12-10T12:00:00");
    const october = new Date("2026-10-25T12:00:00");
    const july = new Date("2026-07-15T12:00:00");
    const accessoriesOn = (date: Date) =>
      new Set(Array.from({ length: 400 }, (_, seed) => createCrabPetLook(seed, date).accessory));
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
    expect(julySet.has("monocle")).toBe(false);
  });

  it("dresses fancy on National Crab Day", () => {
    const crabDaySet = new Set(
      Array.from(
        { length: 400 },
        (_, seed) => createCrabPetLook(seed, new Date("2026-09-25T12:00:00")).accessory,
      ),
    );
    expect(crabDaySet.has("monocle")).toBe(true);
    expect(crabDaySet.has("pumpkin")).toBe(false);
  });

  it("dresses everyone as the classic logo on the repo anniversary", () => {
    const anniversary = new Date("2026-11-24T12:00:00");
    for (let seed = 0; seed < 50; seed++) {
      const look = createCrabPetLook(seed, anniversary);
      expect(look.palette.id).toBe("retro");
      expect(look.accessory).toBe("party");
    }
    // The day after is business as usual.
    const after = createCrabPetLook(7, new Date("2026-11-25T12:00:00"));
    expect(after.accessory).not.toBe("party");
  });
});

describe("resolveCrabPetMode", () => {
  it("maps connection and run state to modes", () => {
    expect(resolveCrabPetMode(false, [{ hasActiveRun: true }])).toBe("offline");
    expect(resolveCrabPetMode(true, null)).toBe("idle");
    expect(resolveCrabPetMode(true, [{ hasActiveRun: false }, {}])).toBe("idle");
    expect(resolveCrabPetMode(true, [{ hasActiveRun: false }, { hasActiveRun: true }])).toBe(
      "busy",
    );
  });
});

describe("resolveCrabRunOutcome", () => {
  it("uses the most recently active terminal session", () => {
    expect(resolveCrabRunOutcome(null)).toBe("ok");
    expect(
      resolveCrabRunOutcome([
        { status: "done", lastActivityAt: 10 },
        { status: "failed", lastActivityAt: 20 },
      ]),
    ).toBe("error");
    expect(
      resolveCrabRunOutcome([
        { status: "failed", lastActivityAt: 10 },
        { status: "done", lastActivityAt: 20 },
      ]),
    ).toBe("ok");
    expect(resolveCrabRunOutcome([{ status: "running", lastActivityAt: 99 }])).toBe("ok");
    expect(resolveCrabRunOutcome([{ status: "timeout", updatedAt: 5 }])).toBe("error");
    // A user abort is neither success nor failure.
    expect(resolveCrabRunOutcome([{ status: "killed", endedAt: 50 }])).toBe("aborted");
    // endedAt outranks activity stamps that unrelated events keep touching.
    expect(
      resolveCrabRunOutcome([
        { status: "failed", endedAt: 30, lastActivityAt: 10 },
        { status: "done", endedAt: 20, lastActivityAt: 40 },
      ]),
    ).toBe("error");
  });
});

describe("crab pet element", () => {
  it("starts hidden and arrives on its seeded visit schedule", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await element.updateComplete;

    expect(spritePresent(element)).toBe(false);
    await arrive(element);
    expect(element.querySelector(".crab-pet__svg")).not.toBeNull();
    expect(spriteClasses(element)).toContain("crab-pet--idle");
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

  it("startles when poked", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await arrive(element);

    poke(element);
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("crab-pet--act-startle");
  });

  it("schedules acts while perched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    const act = await advanceUntilAct(element, 20_000);

    expect(act).not.toBeNull();
    expect(spriteClasses(element)).toContain(`crab-pet--act-${act}`);
  });

  it("reacts to busy, idle, and offline mode changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    element.mode = "busy";
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("crab-pet--act-startle");
    expect(spriteClasses(element)).toContain("crab-pet--busy");

    element.runOutcome = "ok";
    element.mode = "idle";
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("crab-pet--act-cheer");

    const offline = createPet(7, "offline");
    await offline.updateComplete;
    expect(spritePresent(offline)).toBe(true);
    expect(spriteClasses(offline)).toContain("crab-pet--offline");
  });

  it("renders deterministic molt and twin load variants", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const molting = createPet(2);
    await arrive(molting);
    expect(await advanceUntilAct(molting, 30_000)).toBe("molt");
    expect(
      await advanceUntil(molting, () => molting.querySelector(".crab-pet--shell") !== null, 30_000),
    ).toBe(true);

    const twins = createPet(21);
    await arrive(twins);
    expect(twins.querySelectorAll(".crab-pet:not(.crab-pet--shell)")).toHaveLength(2);
    expect(twins.querySelector(".crab-pet--twin")?.getAttribute("title")).toMatch(/ Jr\.$/);
  });

  it("records arrivals in the crabdex", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    const element = createPet(42);

    await arrive(element);

    const look = createCrabPetLook(42, new Date("2026-07-09T12:00:00"));
    expect(getCrabdex().has(look.palette.id)).toBe(true);
    expect(getCrabdexEntries().get(look.palette.id)?.name).toBeTruthy();
  });

  it("right-click shoos it away for the rest of the load", async () => {
    vi.useFakeTimers();
    const element = createPet(42);
    await arrive(element);

    const shoo = new Event("contextmenu", { cancelable: true });
    element.querySelector(".crab-pet")?.dispatchEvent(shoo);
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

  it("gets grumpy after three fast pokes and recovers after a minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    for (let i = 0; i < 3; i++) {
      poke(element);
      await element.updateComplete;
    }
    expect(spriteClasses(element)).toContain("crab-pet--grumpy");

    await vi.advanceTimersByTimeAsync(61_000);
    await element.updateComplete;
    expect(spriteClasses(element)).not.toContain("crab-pet--grumpy");
  });

  it("leaves in a huff after ten pokes but returns for a later visit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    for (let i = 0; i < 10; i++) {
      poke(element);
      await element.updateComplete;
    }
    const gone = await advanceUntil(element, () => !spritePresent(element), 5_000);
    expect(gone).toBe(true);

    const returned = await advanceUntil(element, () => spritePresent(element), 1_300_000);
    expect(returned).toBe(true);
  });

  it("old friends wave hello on their first arrival of the load", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.crabpet.familiarity.v1",
      JSON.stringify({ visits: 30, shoos: 0 }),
    );
    const element = createPet(42);
    await arrive(element);

    // The greeting fires right after the entrance settles.
    await vi.advanceTimersByTimeAsync(600);
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("crab-pet--act-wave");
  });

  it("shooing is remembered in the familiarity counters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    const element = createPet(42);
    await arrive(element);

    element
      .querySelector(".crab-pet:not(.crab-pet--shell)")
      ?.dispatchEvent(new Event("contextmenu", { cancelable: true }));
    await element.updateComplete;
    const raw = JSON.parse(localStorage.getItem("openclaw.control.crabpet.familiarity.v1") ?? "{}");
    expect(raw.shoos).toBe(1);
  });

  it("cancels a pending pet when the pointer interaction is cancelled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42, "offline");
    await element.updateComplete;

    const sprite = element.querySelector(".crab-pet");
    sprite?.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(300);
    sprite?.dispatchEvent(new Event("pointercancel"));
    await vi.advanceTimersByTimeAsync(400);
    await element.updateComplete;

    expect(spriteClasses(element)).not.toContain("crab-pet--act-pet");
  });

  it("droops instead of cheering when the finished run failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42, "busy");
    element.runOutcome = "error";
    await arrive(element);

    element.mode = "idle";
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("crab-pet--act-droop");
    expect(spriteClasses(element)).not.toContain("crab-pet--act-cheer");
  });

  it("keeps vigil during long runs and settles until the run ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42, "busy");
    await arrive(element);

    await vi.advanceTimersByTimeAsync(600_500);
    await element.updateComplete;
    expect(spriteClasses(element)).toContain("crab-pet--vigil");

    // No fidgeting while keeping vigil.
    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBeNull();

    element.mode = "idle";
    await element.updateComplete;
    expect(spriteClasses(element)).not.toContain("crab-pet--vigil");
  });

  it.each([
    ["ok", "cheer"],
    ["error", "droop"],
    ["aborted", "startle"],
  ] as const)(
    "finishes a vigil-only %s run with a visible %s before leaving",
    async (outcome, act) => {
      const element = await startVigilOnlyRun(outcome);
      element.mode = "idle";
      await element.updateComplete;
      expect(spriteClasses(element)).toContain(`crab-pet--act-${act}`);
      expect(spriteClasses(element)).not.toContain("crab-pet--away");

      const reachedNextPhase = await advanceUntil(
        element,
        () =>
          spriteClasses(element).includes("crab-pet--away") ||
          spriteClasses(element).includes("crab-pet--act-sweep"),
        10_000,
        100,
      );
      expect(reachedNextPhase).toBe(true);
      if (outcome === "error") {
        expect(spriteClasses(element)).toContain("crab-pet--act-sweep");
        expect(spriteClasses(element)).not.toContain("crab-pet--away");
        expect(
          await advanceUntil(
            element,
            () => spriteClasses(element).includes("crab-pet--away"),
            10_000,
            100,
          ),
        ).toBe(true);
      }
      expect(spriteClasses(element)).toContain("crab-pet--away");

      await vi.advanceTimersByTimeAsync(400);
      await element.updateComplete;
      expect(spritePresent(element)).toBe(false);
    },
  );

  it.each(["seed reset", "page hide"] as const)(
    "releases vigil outcome presence on %s",
    async (cleanup) => {
      const element = await startVigilOnlyRun("ok");
      element.mode = "idle";
      await element.updateComplete;

      if (cleanup === "seed reset") {
        element.seed = 7;
      } else {
        const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
        hidden.mockRestore();
      }
      await element.updateComplete;
      expect(spriteClasses(element)).not.toContain("crab-pet--act-cheer");

      await vi.advanceTimersByTimeAsync(400);
      await element.updateComplete;
      expect(spritePresent(element)).toBe(false);
    },
  );

  it("watches the pointer between acts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(42);
    await arrive(element);

    // jsdom rects are zero, so any positive clientX is to the sprite's right
    // and any negative clientX is to its left.
    await vi.advanceTimersByTimeAsync(200);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
    await element.updateComplete;
    expect(element.querySelector(".crab-pet")?.getAttribute("style")).toContain("--crab-face:1");

    await vi.advanceTimersByTimeAsync(200);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: -400 }));
    await element.updateComplete;
    expect(element.querySelector(".crab-pet")?.getAttribute("style")).toContain("--crab-face:-1");
  });

  it("carries a bindle on the first load after a gateway upgrade", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem("openclaw.control.crabpet.gatewayVersion.v1", "2026.6.1");
    const element = createPet(42);
    element.gatewayVersion = "2026.7.1";
    await arrive(element);

    expect(element.querySelector(".crab-bindle")).not.toBeNull();
    expect(element.querySelector(".crab-pet")?.getAttribute("title")).toContain("just moved in");
    expect(localStorage.getItem("openclaw.control.crabpet.gatewayVersion.v1")).toBe("2026.7.1");
  });

  it("travels light on first sighting and on same-version reloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    // First version ever seen: record a baseline, no bindle.
    const first = createPet(42);
    first.gatewayVersion = "2026.7.1";
    await arrive(first);
    expect(first.querySelector(".crab-bindle")).toBeNull();
    expect(localStorage.getItem("openclaw.control.crabpet.gatewayVersion.v1")).toBe("2026.7.1");
    first.remove();

    // Same version on the next load: still no bindle.
    const second = createPet(42);
    second.gatewayVersion = "2026.7.1";
    await arrive(second);
    expect(second.querySelector(".crab-bindle")).toBeNull();
  });

  it("stays silent by default and chirps only when sounds are enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const audioContextCtor = vi.fn(() => {
      const param = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
      return {
        state: "running",
        currentTime: 0,
        destination: {},
        resume: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
        createOscillator: vi.fn(() => ({
          type: "sine",
          frequency: param(),
          connect: (node: unknown) => node,
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
      };
    });
    vi.stubGlobal("AudioContext", audioContextCtor);
    const element = createPet(42);
    await arrive(element);

    poke(element);
    expect(audioContextCtor).not.toHaveBeenCalled();

    element.soundsEnabled = true;
    await element.updateComplete;
    poke(element);
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  it("wears the party hat on its first-visit anniversary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    const look = createCrabPetLook(42, new Date("2026-07-09T12:00:00"));
    localStorage.setItem(
      "openclaw.control.crabdex.v1",
      JSON.stringify({
        [look.palette.id]: {
          firstSeenAt: new Date("2025-07-09T12:00:00").getTime(),
          name: "Original",
        },
      }),
    );
    const element = createPet(42);
    await arrive(element);

    expect(spriteClasses(element)).toContain("crab-pet--party");
    // The memory itself stays immutable through the celebratory visit.
    expect(getCrabdexEntries().get(look.palette.id)?.name).toBe("Original");
  });

  it("wears the sailor cap on crab days, deferring to rolled headwear", async () => {
    vi.useFakeTimers();
    // 2026-01-05 is a probed crab day; seed 42 rolls the (face-worn)
    // eyepatch that day, so the cap fits.
    vi.setSystemTime(new Date("2026-01-05T12:00:00"));
    const element = createPet(42);
    await arrive(element);
    expect(element.querySelector(".crab-cap")).not.toBeNull();
    element.remove();

    // Ordinary days stay capless.
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const plain = createPet(42);
    await arrive(plain);
    expect(plain.querySelector(".crab-cap")).toBeNull();
  });

  it("ships a hidden peek eye only in sleeping renders", () => {
    const container = document.createElement("div");
    const look = createCrabPetLook(42, new Date("2026-07-09T12:00:00"));
    render(renderCrabSvg(look, { sleeping: true }), container);
    expect(container.querySelector(".crab-eye-peek")).not.toBeNull();
    render(renderCrabSvg(look, { standalone: true }), container);
    expect(container.querySelector(".crab-eye-peek")).toBeNull();
  });

  it("props an open book against the claws while keeping both eyes open", () => {
    const palette = expectDefined(
      CRAB_PET_PALETTES.find((entry) => entry.id === "emerald"),
      "emerald palette",
    );
    const container = document.createElement("div");
    render(
      renderCrabSvg(canonicalCrabLook(palette), { reading: true, standalone: true }),
      container,
    );

    expect(container.querySelector(".crab-reading-book")).not.toBeNull();
    expect(container.querySelectorAll(".crab-eye-open circle")).toHaveLength(4);
    expect(container.querySelector(".crab-eye-closed")?.getAttribute("style")).toContain(
      "display:none",
    );
  });

  it("renders full replacement geometry without the standard dome", () => {
    const flatpackPalette = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "flatpack"),
      "flatpack palette",
    );
    const flatpackContainer = document.createElement("div");
    render(
      renderCrabSvg(
        { ...canonicalCrabLook(flatpackPalette), accessory: "crown" },
        { standalone: true },
      ),
      flatpackContainer,
    );
    expect(flatpackContainer.querySelector(".crab-flatpack")).not.toBeNull();
    expect(flatpackContainer.querySelector(".crab-flatpack__allen-key")).not.toBeNull();
    expect(flatpackContainer.querySelector('[fill="#f6c945"]')).toBeNull();

    const loadingPalette = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "loading"),
      "loading palette",
    );
    const loadingContainer = document.createElement("div");
    render(
      renderCrabSvg(canonicalCrabLook(loadingPalette), { standalone: true }),
      loadingContainer,
    );
    expect(loadingContainer.querySelector(".crab-skeleton")).not.toBeNull();
    expect(loadingContainer.querySelectorAll(".crab-eye-open circle")).toHaveLength(2);

    const actualPalette = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "actual"),
      "actual palette",
    );
    const actualContainer = document.createElement("div");
    render(renderCrabSvg(canonicalCrabLook(actualPalette), { standalone: true }), actualContainer);
    expect(actualContainer.querySelector(".crab-actual")).not.toBeNull();
    expect(actualContainer.querySelector(".crab-standard-dome")).toBeNull();

    const balloonPalette = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "balloon"),
      "balloon palette",
    );
    const balloonContainer = document.createElement("div");
    render(
      renderCrabSvg(canonicalCrabLook(balloonPalette), { standalone: true }),
      balloonContainer,
    );
    expect(balloonContainer.querySelector(".crab-balloon-frame")).not.toBeNull();
    expect(balloonContainer.querySelector(".crab-standard-dome")).toBeNull();

    const asciiPalette = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "ascii"),
      "ascii palette",
    );
    const asciiContainer = document.createElement("div");
    render(renderCrabSvg(canonicalCrabLook(asciiPalette), { standalone: true }), asciiContainer);
    expect(asciiContainer.querySelector(".crab-ascii")).not.toBeNull();
    expect(asciiContainer.querySelector(".crab-eye-open")?.textContent).toContain("(o)");
    expect(asciiContainer.querySelector(".crab-eye-closed")?.textContent).toContain("(-)");
    expect(asciiContainer.querySelector(".crab-standard-dome")).toBeNull();

    const portalPalette = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "portal"),
      "portal palette",
    );
    const portalContainer = document.createElement("div");
    render(renderCrabSvg(canonicalCrabLook(portalPalette), { standalone: true }), portalContainer);
    expect(portalContainer.querySelectorAll(".crab-portal-ring")).toHaveLength(2);
    expect(portalContainer.querySelector(".crab-standard-dome")).toBeNull();
  });

  it("never stacks the sailor cap on the tinfoil hat", () => {
    const tinfoilPalette = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "tinfoil"),
      "tinfoil palette",
    );
    const container = document.createElement("div");
    render(
      renderCrabSvg(canonicalCrabLook(tinfoilPalette), { standalone: true, sailorCap: true }),
      container,
    );
    expect(container.querySelector(".crab-tinfoil-hat")).not.toBeNull();
    expect(container.querySelector(".crab-cap")).toBeNull();
  });

  it("stays static when reduced motion is preferred, including visibility resumes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const element = createPet(42);
    await arrive(element);

    expect(element.querySelector(".crab-pet__svg")).not.toBeNull();
    // Tab switches re-enter through the visibilitychange resume path, which
    // must stay inert under reduced motion too. Mode flips must not startle.
    document.dispatchEvent(new Event("visibilitychange"));
    element.mode = "busy";
    await element.updateComplete;
    const act = await advanceUntilAct(element, 30_000);
    expect(act).toBeNull();
  });
});

describe("crab plans", () => {
  it("keeps the passer gate near 9.5% while widening the traffic", () => {
    const counts = new Map<string, number>();
    const total = 20_000;
    for (let seed = 0; seed < total; seed++) {
      const plan = planCrabPasser(seed);
      if (!plan) {
        continue;
      }
      counts.set(plan.kind, (counts.get(plan.kind) ?? 0) + 1);
      expect(plan.atMs).toBeGreaterThanOrEqual(60_000);
      expect(plan.atMs).toBeLessThanOrEqual(900_000);
    }
    for (const kind of ["stranger", "crab", "snail", "duck", "jellyfish"]) {
      expect(counts.get(kind) ?? 0).toBeGreaterThan(0);
    }
    const passers = [...counts.values()].reduce((sum, count) => sum + count, 0);
    expect(passers).toBeGreaterThan(total * 0.07);
    expect(passers).toBeLessThan(total * 0.12);
    // Strangers stay the most common traffic.
    for (const kind of ["crab", "snail", "duck", "jellyfish"]) {
      expect(counts.get("stranger") ?? 0).toBeGreaterThan(counts.get(kind) ?? 0);
    }
  });

  it("maps entrance rolls to their rarity bands", () => {
    expect(pickCrabEntrance(0.01)).toBe("balloon");
    expect(pickCrabEntrance(0.06)).toBe("bubble");
    expect(pickCrabEntrance(0.129)).toBe("bubble");
    expect(pickCrabEntrance(0.13)).toBe("walk");
    expect(pickCrabEntrance(0.9)).toBe("walk");
  });

  it("resolves rare elder identities deterministically", () => {
    const neutralDate = new Date("2026-07-15T12:00:00");
    const identityOf = (seed: number) =>
      resolveCrabLoadIdentity(seed, createCrabPetLook(seed, neutralDate));
    const elder = identityOf(644);
    expect(elder.elder).toBe(true);
    expect(elder.look.scale).toBe(3);
    expect(elder.look.accessory).toBe("barnacle");
    let elders = 0;
    for (let seed = 0; seed < 3_000; seed++) {
      if (identityOf(seed).elder) {
        elders++;
      }
    }
    expect(elders).toBeGreaterThan(0);
    expect(elders).toBeLessThan(3_000 * 0.035);
  });

  it("returns old friends only from palettes the dex knows", () => {
    vi.stubGlobal("localStorage", window.localStorage);
    const neutralDate = new Date("2026-07-15T12:00:00");
    const identityOf = (seed: number) =>
      resolveCrabLoadIdentity(seed, createCrabPetLook(seed, neutralDate));
    // An empty dex has no friends to bring back, whatever the roll says.
    expect(identityOf(191).oldFriend).toBe(false);
    localStorage.setItem(
      "openclaw.control.crabdex.v1",
      JSON.stringify({
        gold: { firstSeenAt: 1, name: "Goldenrod" },
        // Sorts after "gold" (as retired tangerine did) so probe seed 191 keeps
        // picking index 0 = gold from the sorted candidate list.
        watermelon: { firstSeenAt: 2, name: "Pips" },
      }),
    );
    const friend = identityOf(191);
    expect(friend.oldFriend).toBe(true);
    expect(friend.look.palette.id).toBe("gold");
    expect(friend.friendName).toBe("Goldenrod");
    const goldenRetro = expectDefined(
      CRAB_PET_PALETTES.find((palette) => palette.id === "goldenretro"),
      "golden retro palette",
    );
    const grail = resolveCrabLoadIdentity(191, {
      ...createCrabPetLook(191, neutralDate),
      palette: goldenRetro,
    });
    expect(grail.oldFriend).toBe(false);
    expect(grail.look.palette.id).toBe("goldenretro");
    // A seed whose friend roll misses stays a fresh stranger.
    expect(identityOf(42).oldFriend).toBe(false);
  });

  it("ignores stale removed palettes in dex counts and old-friend planning", () => {
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.crabdex.v1",
      JSON.stringify({
        coral: { firstSeenAt: 1, name: "Faded" },
        teal: { firstSeenAt: 2, name: "Lagoon" },
        tangerine: { firstSeenAt: 3, name: "Marmalade" },
        calico: { firstSeenAt: 4, name: "Patches" },
        abyss: { firstSeenAt: 5, name: "Lantern" },
      }),
    );
    const seen = getCrabdex();
    expect(CRAB_PET_PALETTES.filter((palette) => seen.has(palette.id))).toHaveLength(0);

    const neutralDate = new Date("2026-07-15T12:00:00");
    const identity = resolveCrabLoadIdentity(191, createCrabPetLook(191, neutralDate));
    expect(identity.oldFriend).toBe(false);
    expect(identity.look.palette.id).not.toBe("coral");
    expect(identity.look.palette.id).not.toBe("teal");
  });

  it("beaches bottles rarely, with fortunes and spots in range", () => {
    let bottles = 0;
    const total = 20_000;
    for (let seed = 0; seed < total; seed++) {
      const plan = planCrabBottle(seed);
      if (!plan) {
        continue;
      }
      bottles++;
      expect(plan.atMs).toBeGreaterThanOrEqual(45_000);
      expect(plan.spotPct).toBeGreaterThanOrEqual(15);
      expect(plan.spotPct).toBeLessThanOrEqual(85);
      expect(CRAB_BOTTLE_FORTUNES[plan.fortuneIndex]).toBeTruthy();
    }
    expect(bottles).toBeGreaterThan(0);
    expect(bottles).toBeLessThan(total * 0.05);
  });
});

describe("rare crab loads", () => {
  // Probe seeds (deterministic per stream): 644 hosts the Elder; 191 rolls
  // an old-friend return plus a balloon entrance; 4689 hatches a shiny variant;
  // 104 is a shy load that beaches a bottle at ~194s; 37 is a shy load with
  // a snail crossing at ~407s.
  it("hosts the Elder: barnacled, renamed, and never molting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(644);
    await arrive(element);

    expect(spriteClasses(element)).toContain("crab-pet--elder");
    expect(element.querySelector(".crab-barnacles")).not.toBeNull();
    expect(element.querySelector(".crab-pet")?.getAttribute("title")).toBe(
      "Methuselah · old as the tides",
    );
  });

  it("brings back an old friend from the Crabdex, balloon and all", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.crabdex.v1",
      JSON.stringify({
        gold: { firstSeenAt: 1, name: "Goldenrod" },
        // Sorts after "gold" (as retired tangerine did) so probe seed 191 keeps
        // picking index 0 = gold from the sorted candidate list.
        watermelon: { firstSeenAt: 2, name: "Pips" },
      }),
    );
    const element = createPet(191);
    await arrive(element);

    // The seeded emerald look is repainted as the remembered gold visitor.
    expect(spriteClasses(element)).toContain("crab-pet--palette-gold");
    expect(element.querySelector(".crab-pet")?.getAttribute("title")).toBe(
      "Goldenrod · an old friend",
    );
    // This seed also floats in under a balloon...
    expect(spriteClasses(element)).toContain("crab-pet--enter-balloon");
    expect(element.querySelector(".crab-pet__balloon")).not.toBeNull();
    // ...and old friends greet even before the familiarity tier does.
    const waved = await advanceUntil(
      element,
      () => spriteClasses(element).includes("crab-pet--act-wave"),
      5_000,
      100,
    );
    expect(waved).toBe(true);
  });

  it("hatches shiny crabs that sparkle and log in the Crabdex", async () => {
    vi.useFakeTimers();
    const neutralDate = new Date("2026-07-09T12:00:00");
    vi.setSystemTime(neutralDate);
    vi.stubGlobal("localStorage", window.localStorage);
    const seed = 4_689;
    const shinyLook = createCrabPetLook(seed, neutralDate);
    expect(shinyLook.shiny).toBe(true);
    const element = createPet(seed);
    await arrive(element);

    expect(spriteClasses(element)).toContain("crab-pet--shiny");
    expect(spriteClasses(element)).toContain(`crab-pet--palette-${shinyLook.palette.id}`);
    expect(element.querySelectorAll(".crab-pet__sparkle").length).toBeGreaterThan(0);
    expect(element.querySelector(".crab-pet")?.getAttribute("title")).toContain("✦");
    expect(getCrabdexEntries().get(shinyLook.palette.id)?.shinySeenAt).not.toBeNull();
  });

  it("beaches a message in a bottle on its own clock, pet or no pet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(104);
    await element.updateComplete;

    // Seed 104 is a shy load: no pet ever, but the tide does not care.
    const washedUp = await advanceUntil(
      element,
      () => element.querySelector(".crab-bottle") !== null,
      300_000,
    );
    expect(washedUp).toBe(true);
    expect(spritePresent(element)).toBe(false);
    expect(element.querySelector(".crab-bottle")?.getAttribute("title")).toBe(
      "a message in a bottle",
    );

    element.querySelector(".crab-bottle")?.dispatchEvent(new Event("pointerdown"));
    await element.updateComplete;
    const opened = element.querySelector(".crab-bottle");
    expect(opened?.className).toContain("crab-bottle--open");
    expect(opened?.getAttribute("title")).toBe("a shell is just armor you outgrew");

    // Read fortunes drift back out with the tide.
    const ebbed = await advanceUntil(
      element,
      () => element.querySelector(".crab-bottle") === null,
      150_000,
    );
    expect(ebbed).toBe(true);
  });

  it("lets the snail take its sweet time crossing the ledge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    const element = createPet(37);
    await element.updateComplete;

    const appeared = await advanceUntil(
      element,
      () => element.querySelector(".crab-pet--snail") !== null,
      500_000,
    );
    expect(appeared).toBe(true);
    // A regular passer's 11s crossing would be long over; the snail abides.
    await vi.advanceTimersByTimeAsync(60_000);
    await element.updateComplete;
    expect(element.querySelector(".crab-pet--snail")).not.toBeNull();
    const gone = await advanceUntil(
      element,
      () => element.querySelector(".crab-pet--snail") === null,
      40_000,
    );
    expect(gone).toBe(true);
  });

  it("earns the golden ledge trim once the Crabdex is complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00"));
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.crabdex.v1",
      JSON.stringify(
        Object.fromEntries(
          CRAB_PET_PALETTES.map((palette) => [palette.id, { firstSeenAt: 1, name: "First" }]),
        ),
      ),
    );
    const element = createPet(42);
    await element.updateComplete;
    expect(element.hasAttribute("data-dex-complete")).toBe(true);

    // The visits setting silences the trim like everything else.
    element.visitsEnabled = false;
    await element.updateComplete;
    expect(element.hasAttribute("data-dex-complete")).toBe(false);
  });
});
