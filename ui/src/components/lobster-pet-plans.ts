import { getSafeLocalStorage } from "../local-storage.ts";
import type {
  LobsterPetMode,
  LobsterPetPersonalityId,
  LobsterRunOutcome,
} from "./lobster-pet-contract.ts";
import { mulberry32, SPOT_ZONES } from "./lobster-pet-look.ts";

export { SPOT_ZONES };

export type LobsterPetAct =
  | "wave"
  | "snip"
  | "hop"
  | "spin"
  | "peek"
  | "nap"
  | "bubble"
  | "scuttle"
  | "startle"
  | "cheer"
  | "molt"
  | "pet"
  | "droop"
  | "sweep";

type ActProfile = {
  // [min, max] delay before the next act.
  delayMs: [number, number];
  acts: Array<[LobsterPetAct, number]>;
};

// Act windows mirror the CSS animation durations in lobster-pet.css so jsdom
// tests and browsers clear acts on the same clock without animationend.
export const LOBSTER_PET_ACT_DURATION_MS: Record<LobsterPetAct, number> = {
  wave: 1400,
  snip: 1000,
  hop: 750,
  spin: 950,
  peek: 1700,
  nap: 4400,
  bubble: 2600,
  scuttle: 1250,
  startle: 750,
  cheer: 1300,
  molt: 2600,
  pet: 1500,
  droop: 1600,
  sweep: 1800,
};

const PERSONALITIES: Record<LobsterPetPersonalityId, ActProfile> = {
  sleepy: {
    delayMs: [6000, 12000],
    acts: [
      ["nap", 40],
      ["bubble", 20],
      ["wave", 12],
      ["scuttle", 12],
      ["peek", 10],
      ["hop", 6],
    ],
  },
  zoomy: {
    delayMs: [2800, 6000],
    acts: [
      ["scuttle", 42],
      ["hop", 22],
      ["spin", 12],
      ["peek", 12],
      ["wave", 12],
    ],
  },
  friendly: {
    delayMs: [3600, 7500],
    acts: [
      ["wave", 32],
      ["snip", 22],
      ["scuttle", 18],
      ["hop", 14],
      ["bubble", 14],
    ],
  },
  showoff: {
    delayMs: [3600, 7500],
    acts: [
      ["spin", 24],
      ["snip", 22],
      ["peek", 20],
      ["hop", 18],
      ["wave", 16],
    ],
  },
};

// Busy and offline override the personality: the pet is a status indicator
// first. Busy scurries (no naps mid-run); offline paces and peeks.
const LOBSTER_PET_MODE_ACTS: Record<Exclude<LobsterPetMode, "idle">, ActProfile> = {
  busy: {
    delayMs: [2200, 4500],
    acts: [
      ["scuttle", 40],
      ["hop", 20],
      ["snip", 20],
      ["wave", 12],
      ["spin", 8],
    ],
  },
  offline: {
    delayMs: [2800, 5600],
    acts: [
      ["scuttle", 55],
      ["peek", 30],
      ["hop", 15],
    ],
  },
};

export function resolveLobsterActProfile(
  mode: LobsterPetMode,
  personality: LobsterPetPersonalityId | null,
  now: Date = new Date(),
): ActProfile | null {
  if (mode === "busy" || mode === "offline") {
    return LOBSTER_PET_MODE_ACTS[mode];
  }
  if (isLobsterNightTime(now)) {
    return PERSONALITIES.sleepy;
  }
  return personality ? PERSONALITIES[personality] : null;
}

export function resolveLobsterFinishAct(outcome: LobsterRunOutcome): LobsterPetAct {
  return outcome === "error" ? "droop" : outcome === "aborted" ? "startle" : "cheer";
}

export const ENTER_MS = 450;
export const LEAVE_MS = 350;
// One full ledge crossing for pass-through visitors.
export const PASSER_CROSS_MS = 11_000;

export type LobsterPetAnchor = "ledge" | "bar";

// The historical bar visit keeps its compact left-to-center roaming and scale
// cap, while CSS places it on the same ledge as regular visits.
export const BAR_ZONE = [18, 50] as const;
export const BAR_MAX_SCALE = 1.7;

// Visit cadence: seeded per load, the pet is a guest, not a fixture. A share
// of loads gets no visit at all; the rest get a first arrival within minutes,
// stays of a few minutes, and long gaps between returns. Disconnects summon
// the pet regardless of schedule (unless dismissed or disabled).
export const VISIT_SHY_CHANCE = 0.25;
export const VISIT_FIRST_DELAY_MS = [15_000, 180_000] as const;
export const VISIT_STAY_MS = [90_000, 300_000] as const;
export const VISIT_GAP_MS = [360_000, 1_080_000] as const;

// Some ledge visits spook the logo: a beat after the crab settles in, the
// brand mark ducks away, and it pops back once the visit ends. Rolled from a
// dedicated seeded stream so tests can probe arrivals purely.
export const LOGO_SCARE_CHANCE = 0.3;
export const LOGO_SCARE_DELAY_MS = 900;

// Rare-event loads, planned per seed so tests can probe them purely: a molt
// load sheds its shell during the first idle act and sizes up one tier; a
// twin load brings a mini copycat along on every visit.
export function isLobsterMoltLoad(seed: number): boolean {
  return mulberry32((seed ^ 0x301d) >>> 0)() < 0.12;
}

export function isLobsterTwinLoad(seed: number): boolean {
  return mulberry32((seed ^ 0x7715) >>> 0)() < 0.04;
}

// On a logo load the pet's first scheduled visit skips the ledge entirely:
// it climbs up top and fills in for the brand logo until the stay ends.
// Offline summons still report to the ledge - status duty outranks cosplay.
export function isLobsterLogoLoad(seed: number): boolean {
  return mulberry32((seed ^ 0x1063) >>> 0)() < 0.12;
}

type LobsterPasserKind = "stranger" | "crab";

export type LobsterPasserPlan = {
  kind: LobsterPasserKind;
  atMs: number;
  direction: 1 | -1;
};

// Once per load, someone else might just... walk through. Strangers are
// other lobsters that never stop; the crab is not a lobster and refuses to
// discuss it. Neither counts for the Lobsterdex.
export function planLobsterPasser(seed: number): LobsterPasserPlan | null {
  const rng = mulberry32((seed ^ 0xcab) >>> 0);
  const roll = rng();
  if (roll >= 0.095) {
    return null;
  }
  const kind: LobsterPasserKind = roll < 0.015 ? "crab" : "stranger";
  const atMs = Math.round(60_000 + rng() * 840_000);
  const direction: 1 | -1 = rng() < 0.5 ? 1 : -1;
  return { kind, atMs, direction };
}

// The pet notices gateway upgrades: the first page load on a new version, it
// shows up carrying a bindle (moving day). The very first version sighting
// only records a baseline - no bindle without a previous home.
const MOVING_DAY_KEY = "openclaw.control.lobsterpet.gatewayVersion.v1";

export function detectLobsterMovingDay(version: string): boolean {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return false;
    }
    const previous = storage.getItem(MOVING_DAY_KEY);
    if (previous === version) {
      return false;
    }
    storage.setItem(MOVING_DAY_KEY, version);
    return previous !== null;
  } catch {
    return false;
  }
}

// Late-night visitors are always sleepy, whatever their daytime personality.
function isLobsterNightTime(now: Date = new Date()): boolean {
  const hour = now.getHours();
  return hour >= 22 || hour < 6;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
