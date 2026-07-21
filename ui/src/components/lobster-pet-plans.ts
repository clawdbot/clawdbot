import { getSafeLocalStorage } from "../local-storage.ts";
import { getLobsterdex, getLobsterdexEntries } from "./lobster-dex.ts";
import type {
  LobsterPasserKind,
  LobsterPetEntrance,
  LobsterPetLook,
  LobsterPetMode,
  LobsterPetPersonalityId,
  LobsterRunOutcome,
} from "./lobster-pet-contract.ts";
import {
  LOBSTER_PET_PALETTES,
  lobsterPetName,
  mulberry32,
  SPOT_ZONES,
} from "./lobster-pet-look.ts";

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

export const LEAVE_MS = 350;

// Arrival theatrics: most visits walk up from behind the ledge; a few float
// in under a balloon or pop out of a bubble. Rolled per arrival from the
// component's dedicated entrance stream so visit scheduling stays untouched.
export function pickLobsterEntrance(roll: number): LobsterPetEntrance {
  return roll < 0.06 ? "balloon" : roll < 0.13 ? "bubble" : "walk";
}

// How long each entrance owns the `entering` flag; mirrors the entrance
// animation durations in lobster-pet.css.
export const LOBSTER_PET_ENTRANCE_MS: Record<LobsterPetEntrance, number> = {
  walk: 450,
  balloon: 1250,
  bubble: 700,
};

// One full ledge crossing per passer kind. The snail is the point of the
// snail: glance away, glance back, still crossing.
export const LOBSTER_PASSER_CROSS_MS: Record<LobsterPasserKind, number> = {
  stranger: 11_000,
  crab: 11_000,
  snail: 90_000,
  duck: 14_000,
  jellyfish: 16_000,
};

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

export type LobsterPasserPlan = {
  kind: LobsterPasserKind;
  atMs: number;
  direction: 1 | -1;
};

// Once per load, someone else might just... pass through. Strangers are
// other lobsters that never stop; the rest of the traffic is a crab (not a
// lobster, refuses to discuss it), a snail, a rubber duck, or a jellyfish.
// The 9.5% event gate is unchanged from the two-kind era — variety widened,
// frequency did not. None of them count for the Lobsterdex.
export function planLobsterPasser(seed: number): LobsterPasserPlan | null {
  const rng = mulberry32((seed ^ 0xcab) >>> 0);
  const roll = rng();
  if (roll >= 0.095) {
    return null;
  }
  const kind: LobsterPasserKind =
    roll < 0.015
      ? "crab"
      : roll < 0.027
        ? "snail"
        : roll < 0.039
          ? "duck"
          : roll < 0.05
            ? "jellyfish"
            : "stranger";
  const atMs = Math.round(60_000 + rng() * 840_000);
  const direction: 1 | -1 = rng() < 0.5 ? 1 : -1;
  return { kind, atMs, direction };
}

// A very rare load hosts the Elder: a huge, barnacled, unhurried lobster.
// Lobsters famously never really stop growing; this one simply started
// earlier than everyone else.
function isLobsterElderLoad(seed: number): boolean {
  return mulberry32((seed ^ 0xe1d3) >>> 0)() < 0.015;
}

// Sometimes the visitor is not a stranger at all: a palette the Lobsterdex
// already remembers comes back wearing its recorded name. Returns the chosen
// palette id, or null for an ordinary load. Candidates are passed in
// (sorted) so this stays a pure plan.
function planLobsterOldFriend(seed: number, knownPaletteIds: readonly string[]): string | null {
  if (knownPaletteIds.length === 0) {
    return null;
  }
  const rng = mulberry32((seed ^ 0xf21e) >>> 0);
  if (rng() >= 0.08) {
    return null;
  }
  return knownPaletteIds[Math.floor(rng() * knownPaletteIds.length)] ?? null;
}

export type LobsterLoadIdentity = {
  elder: boolean;
  oldFriend: boolean;
  friendName: string | null;
  dexComplete: boolean;
  look: LobsterPetLook;
};

// Rare per-load identities, resolved on top of the seeded look: the Elder
// outranks an old-friend return, and retro looks (grail or anniversary dress
// code) are never repainted. Lobsterdex completion is snapshotted here too,
// so the golden ledge trim appears between loads, never mid-visit.
export function resolveLobsterLoadIdentity(
  seed: number,
  look: LobsterPetLook,
): LobsterLoadIdentity {
  const seen = getLobsterdex();
  const dexComplete = LOBSTER_PET_PALETTES.every((palette) => seen.has(palette.id));
  const base: LobsterLoadIdentity = {
    elder: false,
    oldFriend: false,
    friendName: null,
    dexComplete,
    look,
  };
  if (isLobsterElderLoad(seed)) {
    // The Elder never molts or crushes: it is already every size it needs.
    return {
      ...base,
      elder: true,
      look: {
        ...look,
        scale: 3,
        accessory: "barnacle",
        personality: "sleepy",
        clawSize: "mighty",
        crusherSide: null,
      },
    };
  }
  if (look.palette.id === "retro") {
    return base;
  }
  const known = [...seen]
    .filter((id) => LOBSTER_PET_PALETTES.some((palette) => palette.id === id))
    .toSorted();
  const friendId = planLobsterOldFriend(seed, known);
  const palette = friendId
    ? LOBSTER_PET_PALETTES.find((entry) => entry.id === friendId)
    : undefined;
  if (!palette) {
    return base;
  }
  return {
    ...base,
    oldFriend: true,
    friendName: getLobsterdexEntries().get(palette.id)?.name ?? null,
    look: { ...look, palette },
  };
}

// The displayed base name before honorifics: rare identities override the
// seeded catalog name.
export function lobsterLoadDisplayName(identity: LobsterLoadIdentity, seed: number): string {
  if (identity.elder) {
    return "Methuselah";
  }
  return identity.friendName ?? lobsterPetName(identity.look, seed);
}

// Ledge lore, delivered by sea. Shown through the bottle's title tooltip
// (the pet-name channel), so there is no i18n surface.
export const LOBSTER_BOTTLE_FORTUNES = [
  "the tide returns every branch to shore",
  "molt before you feel ready",
  "a shell is just armor you outgrew",
  "somewhere, a test is green because of you",
  "swim sideways when forward fails",
  "the reef remembers kind commits",
  "even the abyss keeps a night light",
  "barnacles are only patient passengers",
  "no current lasts forever",
  "bury your treasure in version control",
  "the crab was a lobster all along",
  "small claws, firm grip",
  "rest is also progress",
  "what washes away was never pinned",
] as const;

export type LobsterBottlePlan = {
  atMs: number;
  spotPct: number;
  fortuneIndex: number;
};

// A few loads beach a message in a bottle somewhere on the ledge. It is not
// the pet's: it appears on its own clock and outlives visits.
export function planLobsterBottle(seed: number): LobsterBottlePlan | null {
  const rng = mulberry32((seed ^ 0xb077) >>> 0);
  if (rng() >= 0.03) {
    return null;
  }
  const atMs = Math.round(45_000 + rng() * 855_000);
  const spotPct = Math.round(15 + rng() * 70);
  const fortuneIndex = Math.floor(rng() * LOBSTER_BOTTLE_FORTUNES.length);
  return { atMs, spotPct, fortuneIndex };
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
