export type LobsterPetMode = "idle" | "busy" | "offline";

export type LobsterRunOutcome = "ok" | "error" | "aborted";

export type LobsterPetPersonalityId = "sleepy" | "zoomy" | "friendly" | "showoff";

export type LobsterPetPaletteId =
  | "crimson"
  | "coral"
  | "teal"
  | "violet"
  | "ink"
  | "blue"
  | "gold"
  | "calico"
  | "abyss"
  | "lumen"
  | "ghost"
  | "split"
  | "cottoncandy"
  | "retro";

// Pass-through ledge visitors. Strangers are other lobsters; everyone else
// is, at best, lobster-adjacent. None of them count for the Lobsterdex.
export type LobsterPasserKind = "stranger" | "crab" | "snail" | "duck" | "jellyfish";

// How an arriving pet gets onto the ledge. Rolled per arrival from its own
// seeded stream; "walk" is the classic pop-up from behind the ledge.
export type LobsterPetEntrance = "walk" | "balloon" | "bubble";

export type LobsterPetPalette = {
  id: LobsterPetPaletteId;
  shell: string;
  claw: string;
};

export type LobsterPetAccessory =
  | "none"
  | "crown"
  | "sprout"
  | "patch"
  | "santa"
  | "pumpkin"
  | "party"
  | "barnacle"
  | "monocle";

export type LobsterPetAntennae = "perky" | "droopy";

export type LobsterPetBuild = "round" | "squat" | "slender";

export type LobsterPetClawSize = "dainty" | "regular" | "mighty";

export type LobsterPetLook = {
  palette: LobsterPetPalette;
  scale: number;
  accessory: LobsterPetAccessory;
  antennae: LobsterPetAntennae;
  side: "left" | "right";
  spotPct: number;
  facing: 1 | -1;
  personality: LobsterPetPersonalityId;
  blinkDelayS: number;
  build: LobsterPetBuild;
  clawSize: LobsterPetClawSize;
  tailFan: boolean;
  // Pokemon-style shiny roll (~1 in 512): sparkles plus a saturated sheen,
  // logged separately in the Lobsterdex.
  shiny: boolean;
  // Real lobsters carry a crusher and a pincer; when set, that side's claw
  // grows mighty while the other stays dainty (overrides clawSize).
  crusherSide: "left" | "right" | null;
  freckles: boolean;
  // Seeded eye-glint tint for common palettes; rare palettes keep their
  // signature glints via CSS, and null keeps the default teal.
  glint: string | null;
};

export type LobsterLogoVisitPhase = "in" | "leaving" | "out";

export type LobsterLogoVisitDetail = {
  phase: LobsterLogoVisitPhase;
  // A null look on a non-"out" phase means "hide the logo, render no
  // stand-in": a ledge visit scared the brand mark away.
  look: LobsterPetLook | null;
  name: string | null;
};

// Fired on the pet host whenever the logo stand-in phase changes; the
// sidebar owns the brand slot, so the swap renders there, not here.
export const LOBSTER_LOGO_VISIT_EVENT = "openclaw-lobster-logo-visit";

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// One salt per page load: revisiting the UI re-rolls every session's lobster,
// while re-renders within a load stay stable for a given session key.
const LOAD_SALT = Math.trunc(Math.random() * 0xffffffff);

export function lobsterPetSeed(sessionKey: string): number {
  return (fnv1a(sessionKey) ^ LOAD_SALT) >>> 0;
}

// The most recently active session with a terminal status decides how the
// pet reacts when the busy state clears: failures earn sympathy, not cheers.
export function resolveLobsterRunOutcome(
  sessions:
    | ReadonlyArray<{
        status?: "running" | "done" | "failed" | "killed" | "timeout";
        endedAt?: number | null;
        lastActivityAt?: number | null;
        updatedAt?: number | null;
      }>
    | null
    | undefined,
): LobsterRunOutcome {
  let latest: { at: number; outcome: LobsterRunOutcome } | null = null;
  for (const row of sessions ?? []) {
    if (!row.status || row.status === "running") {
      continue;
    }
    // endedAt is the run-completion timestamp; activity/updated stamps also
    // move on unrelated events (reads, renames) and only serve as fallbacks.
    const at = row.endedAt ?? row.lastActivityAt ?? row.updatedAt ?? 0;
    if (!latest || at > latest.at) {
      const outcome: LobsterRunOutcome =
        row.status === "failed" || row.status === "timeout"
          ? "error"
          : row.status === "killed"
            ? "aborted"
            : "ok";
      latest = { at, outcome };
    }
  }
  return latest?.outcome ?? "ok";
}

export function resolveLobsterPetMode(
  connected: boolean,
  sessions: ReadonlyArray<{ hasActiveRun?: boolean | null }> | null | undefined,
): LobsterPetMode {
  if (!connected) {
    return "offline";
  }
  return sessions?.some((row) => row.hasActiveRun === true) ? "busy" : "idle";
}
