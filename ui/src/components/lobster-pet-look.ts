import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, svg, type TemplateResult } from "lit";
import { lobsterHonorific } from "./lobster-dex.ts";
import type {
  LobsterPetAccessory,
  LobsterPetAntennae,
  LobsterPetBuild,
  LobsterPetClawSize,
  LobsterPetLook,
  LobsterPetMode,
  LobsterPetPalette,
  LobsterPetPaletteId,
  LobsterPetPersonalityId,
} from "./lobster-pet-contract.ts";

// Rarity ladder loosely mirrors real lobster genetics: blue ~1 in 2 million,
// yellow ~1 in 30 million, calico ~1 in 30 million, split two-tone ~1 in
// 50 million, albino/ghost ~1 in 100 million. Abyss is our deep-sea fantasy.
// Split/calico extra geometry and ghost/abyss styling key off the palette id
// (see lobster-pet.css and renderLobsterSvg).
const PALETTES: Array<[LobsterPetPalette, number]> = [
  [{ id: "crimson", shell: "#ff4f40", claw: "#ff775f" }, 26],
  [{ id: "coral", shell: "#d0836a", claw: "#de9b80" }, 26],
  [{ id: "teal", shell: "#2fbfa7", claw: "#5cd9c4" }, 10],
  [{ id: "violet", shell: "#9f7dfa", claw: "#bba4fd" }, 10],
  [{ id: "ink", shell: "#5e6b7a", claw: "#7b8996" }, 9],
  [{ id: "blue", shell: "#4a7dfc", claw: "#7fa4ff" }, 7],
  [{ id: "gold", shell: "#f4b840", claw: "#f9d47a" }, 5],
  [{ id: "calico", shell: "#d97a3d", claw: "#e89a63" }, 3],
  [{ id: "abyss", shell: "#2c3b68", claw: "#465b96" }, 2],
  [{ id: "ghost", shell: "#dce8f2", claw: "#ecf3fa" }, 1],
  [{ id: "split", shell: "#ff4f40", claw: "#ff775f" }, 1],
  // The grail: homage to the classic OpenClaw logo (big raised claw, smirk,
  // angry brows, white sticker outline). ~0.5% of sessions.
  [{ id: "retro", shell: "#e8262c", claw: "#f04a3e" }, 0.5],
];

// Catalog order for collection UIs (Lobsterdex): common to grail.
export const LOBSTER_PET_PALETTES: readonly LobsterPetPalette[] = PALETTES.map(
  ([palette]) => palette,
);

// A neutral look used to render catalog minis outside the pet lifecycle.
export function canonicalLobsterLook(palette: LobsterPetPalette): LobsterPetLook {
  return {
    palette,
    scale: 2,
    accessory: "none",
    antennae: "perky",
    side: "left",
    spotPct: 0,
    facing: 1,
    personality: "friendly",
    blinkDelayS: 0,
    build: "round",
    clawSize: "regular",
    tailFan: false,
  };
}

const ACCESSORIES: Array<[LobsterPetAccessory, number]> = [
  ["none", 62],
  ["sprout", 14],
  ["patch", 14],
  ["crown", 10],
];

// OpenClaw's repository was born 2025-11-24 (GitHub created_at); on the
// anniversary every visitor dresses as the classic logo and parties.
const ANNIVERSARY = { month: 10, day: 24 } as const;

function isLobsterAnniversary(now: Date): boolean {
  return now.getMonth() === ANNIVERSARY.month && now.getDate() === ANNIVERSARY.day;
}

// Seasonal wardrobe: extra accessory entries join the pool on the right
// dates. One weighted roll either way, so the rest of the look sequence is
// unchanged on any given seed.
function seasonalAccessories(now: Date): Array<[LobsterPetAccessory, number]> {
  const month = now.getMonth();
  const day = now.getDate();
  if (month === 11) {
    return [["santa", 18]];
  }
  if (month === 9 && day >= 20) {
    return [["pumpkin", 18]];
  }
  return [];
}

const PERSONALITY_IDS: Array<[LobsterPetPersonalityId, number]> = [
  ["sleepy", 25],
  ["zoomy", 25],
  ["friendly", 25],
  ["showoff", 25],
];

const SCALES: Array<[number, number]> = [
  [1.7, 25],
  [2, 55],
  [2.5, 20],
];

const BUILDS: Array<[LobsterPetBuild, number]> = [
  ["round", 40],
  ["squat", 30],
  ["slender", 30],
];

const CLAW_SIZES: Array<[LobsterPetClawSize, number]> = [
  ["regular", 55],
  ["dainty", 25],
  ["mighty", 20],
];

// Builds reshape the whole sprite by stretching its aspect ratio (the svg
// renders with preserveAspectRatio="none"), so eyes, claws, accessories, and
// rare-variant geometry stay aligned for every silhouette.
export const LOBSTER_PET_BUILD_MULS: Record<LobsterPetBuild, { w: number; h: number }> = {
  round: { w: 1, h: 1 },
  squat: { w: 1.14, h: 0.9 },
  slender: { w: 0.88, h: 1.1 },
};

export const LOBSTER_PET_CLAW_MULS: Record<LobsterPetClawSize, number> = {
  dainty: 0.85,
  regular: 1,
  mighty: 1.18,
};

// Seeded pet names; rare palettes carry signature names. Shown via the
// sprite's native title tooltip, so no i18n surface.
const PET_NAMES = [
  "Pinchy",
  "Barnaby",
  "Thermidor",
  "Clawdette",
  "Sheldon",
  "Scuttles",
  "Bisque",
  "Crusty",
  "Snips",
  "Bubbles",
  "Clawdia",
  "Ferdinand",
  "Maple",
  "Pearl",
  "Biscuit",
  "Captain",
  "Ziggy",
  "Noodle",
  "Waffles",
  "Pippin",
  "Squirt",
  "Chip",
  "Clementine",
  "Moss",
] as const;

const RARE_NAMES: Partial<Record<LobsterPetPaletteId, string>> = {
  blue: "Blueberry",
  gold: "Goldie",
  calico: "Patches",
  abyss: "Lantern",
  ghost: "Boo",
  split: "Picasso",
  retro: "OG",
};

export function lobsterPetName(look: LobsterPetLook, seed: number): string {
  return (
    RARE_NAMES[look.palette.id] ??
    expectDefined(PET_NAMES[(seed >>> 3) % PET_NAMES.length], "lobster pet name catalog entry")
  );
}

// A stranger wears a different palette than the resident pet.
function strangerLookFor(seed: number, own: LobsterPetPaletteId): LobsterPetLook {
  for (let offset = 1; offset <= 24; offset++) {
    const look = createLobsterPetLook((seed + offset * 7919) >>> 0);
    if (look.palette.id !== own) {
      return look;
    }
  }
  return createLobsterPetLook((seed + 1) >>> 0);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted<T>(rng: () => number, entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) {
      return value;
    }
  }
  return expectDefined(entries.at(-1), "weighted lobster choice fallback")[0];
}

export function randomBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function createLobsterPetLook(seed: number, now: Date = new Date()): LobsterPetLook {
  const rng = mulberry32(seed);
  const palette = pickWeighted(rng, PALETTES);
  const scale = pickWeighted(rng, SCALES);
  const accessory = pickWeighted(rng, [...ACCESSORIES, ...seasonalAccessories(now)]);
  const antennae: LobsterPetAntennae = rng() < 0.6 ? "perky" : "droopy";
  const side = rng() < 0.5 ? "left" : "right";
  const zone = SPOT_ZONES[side];
  const spotPct = Math.round(randomBetween(rng, zone[0], zone[1]));
  const facing = rng() < 0.5 ? 1 : -1;
  const personality = pickWeighted(rng, PERSONALITY_IDS);
  const blinkDelayS = Math.round(randomBetween(rng, 0, 4) * 10) / 10;
  // Shape traits roll after the original ones so pre-existing seeds keep
  // their palette/personality and only gain a silhouette.
  const build = pickWeighted(rng, BUILDS);
  const clawSize = pickWeighted(rng, CLAW_SIZES);
  const tailFan = rng() < 0.3;
  if (isLobsterAnniversary(now)) {
    // Birthday dress code: everyone is the classic logo, party hats on.
    const retro = PALETTES.find(([entry]) => entry.id === "retro")?.[0];
    return {
      palette: retro ?? palette,
      scale,
      accessory: "party",
      antennae,
      side,
      spotPct,
      facing,
      personality,
      blinkDelayS,
      build,
      clawSize,
      tailFan,
    };
  }
  return {
    palette,
    scale,
    accessory,
    antennae,
    side,
    spotPct,
    facing,
    personality,
    blinkDelayS,
    build,
    clawSize,
    tailFan,
  };
}

const ACCESSORY_SPRITES: Record<Exclude<LobsterPetAccessory, "none">, TemplateResult> = {
  crown: svg`
    <path
      d="M46 12 L46 2 L53 8 L60 0 L67 8 L74 2 L74 12 Q60 8 46 12 Z"
      fill="#f6c945"
    />
  `,
  sprout: svg`
    <g>
      <path d="M60 12 Q58 4 63 1" stroke="#3f9d63" stroke-width="3" stroke-linecap="round" fill="none" />
      <ellipse cx="67" cy="3" rx="5" ry="3" fill="#57c785" transform="rotate(-24 67 3)" />
    </g>
  `,
  patch: svg`
    <g>
      <path d="M28 27 Q60 14 92 22" stroke="#101820" stroke-width="4" stroke-linecap="round" fill="none" />
      <circle cx="75" cy="32" r="9" fill="#101820" />
    </g>
  `,
  santa: svg`
    <g>
      <path d="M47 10 Q54 1 68 3 L72 9 Z" fill="#e0312f" />
      <circle cx="71" cy="3.5" r="3.5" fill="#f5f7fa" />
      <ellipse cx="59" cy="10.5" rx="15" ry="3.5" fill="#f5f7fa" />
    </g>
  `,
  pumpkin: svg`
    <g>
      <ellipse cx="60" cy="6.5" rx="8.5" ry="5.5" fill="#e8871e" />
      <path d="M56 2.5 Q56 6.5 56 10.5 M64 2.5 Q64 6.5 64 10.5" stroke="#c96a10" stroke-width="1.5" fill="none" />
      <path d="M60 1.5 Q60.5 0 63 0.5" stroke="#4c9a4c" stroke-width="2.5" stroke-linecap="round" fill="none" />
    </g>
  `,
  party: svg`
    <g>
      <path d="M52 11 L60 0.5 L68 11 Z" fill="#7c5cff" />
      <path d="M55.5 6.5 L64.5 6.5" stroke="#ffd166" stroke-width="2" />
      <circle cx="60" cy="1" r="2.4" fill="#ff5c8a" />
    </g>
  `,
};

// Calico mottling: dark blotches scattered clear of the eye line.
const CALICO_SPOTS = svg`
  <g class="lob-spots" fill="#2a1f16" opacity="0.8">
    <ellipse cx="40" cy="50" rx="6" ry="4" transform="rotate(-15 40 50)" />
    <ellipse cx="72" cy="62" rx="7" ry="4.5" transform="rotate(18 72 62)" />
    <ellipse cx="55" cy="76" rx="5" ry="3.5" transform="rotate(-8 55 76)" />
    <ellipse cx="84" cy="42" rx="4" ry="3" transform="rotate(25 84 42)" />
    <ellipse cx="47" cy="18" rx="4.5" ry="3" transform="rotate(-20 47 18)" />
    <ellipse cx="30" cy="64" rx="4" ry="3" transform="rotate(12 30 64)" />
  </g>
`;

// Split two-tone: the right half of the body (down to the belly midline)
// repainted in the second shell color; the right claw and antenna follow via
// CSS. Mirrors the famous bilateral half-and-half lobsters.
const SPLIT_HALF = svg`
  <path
    class="lob-split-half"
    d="M60 8 C88 8 104 32 104 52 C104 72 90 90 76 95 L76 104 L66 104 L66 96 C64 96.8 62 97.1 60 97.1 L60 8 Z"
    fill="var(--lob-shell2, #46536b)"
  />
`;

// Retro homage parts (classic OpenClaw logo): one oversized raised claw with
// a pincer notch, tall V antennae, angry brows, and a smirk. The mega claw
// lives inside the .lob-claw--r group so wave/snip acts swing it.
const RETRO_MEGA_CLAW = svg`
  <path
    d="M95 55 C112 53 119 39 116 25 C113 11 99 5 91 12 C88 15 87 19 88 23 C83 27 83 36 88 43 C91 49 93 52 95 55 Z"
    fill="var(--lob-claw)"
  />
  <path
    d="M92 14 C97 22 99 31 95 41"
    stroke="#b8151b"
    stroke-width="3"
    stroke-linecap="round"
    fill="none"
  />
`;

const RETRO_ANTENNAE = svg`
  <g class="lob-antennae" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round" fill="none">
    <path d="M50 16 Q45 4 37 1" />
    <path d="M70 16 Q75 4 83 1" />
  </g>
`;

const RETRO_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M49 45 Q59 51 69 45 L72 42" stroke-width="3" />
  </g>
`;

// Tail-fan lobes peek out diagonally behind the lower body (drawn before the
// body path so they read as "behind"). Fill color lives in lobster-pet.css.
const TAIL_FAN = svg`
  <g class="lob-tail">
    <ellipse cx="16" cy="84" rx="11" ry="7" transform="rotate(-32 16 84)" />
    <ellipse cx="104" cy="84" rx="11" ry="7" transform="rotate(32 104 84)" />
  </g>
`;

// Moving-day bindle: a stick over the shoulder with a polka-dot bundle,
// carried for the whole first load after a gateway upgrade.
const BINDLE = svg`
  <g class="lob-bindle">
    <path d="M70 62 L99 30" stroke="#8a5a2b" stroke-width="3.5" stroke-linecap="round" />
    <circle cx="101" cy="27" r="9.5" fill="#e8b04b" />
    <circle cx="98" cy="24" r="1.6" fill="#b6791f" />
    <circle cx="104" cy="29" r="1.6" fill="#b6791f" />
    <circle cx="100" cy="32" r="1.3" fill="#b6791f" />
  </g>
`;

// On lobster days (see src/shared/lobster-day.ts, shared with the CLI
// banner cousin) the pet wears a little sailor cap - unless the seed already
// rolled headwear, which keeps its place.
const HEADWEAR: ReadonlySet<LobsterPetAccessory> = new Set([
  "crown",
  "sprout",
  "santa",
  "pumpkin",
  "party",
]);

const SAILOR_CAP = svg`
  <g class="lob-cap">
    <path d="M46 10 Q60 -3 74 10 L74 13 Q60 7 46 13 Z" fill="#f5f7fa" />
    <path d="M45 12 Q60 6 75 12 L75 16 Q60 10.5 45 16 Z" fill="#dfe7ee" />
    <circle cx="60" cy="2.5" r="1.8" fill="#3b6ea5" />
  </g>
`;

// Shown while grumpy (poked too much): angry brows and a frown.
const GRUMPY_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M50 48 Q60 42 70 48" stroke-width="3" />
  </g>
`;

const ANTENNAE_SPRITES: Record<LobsterPetAntennae, TemplateResult> = {
  perky: svg`
    <g class="lob-antennae" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round" fill="none">
      <path d="M46 14 Q38 4 31 7" />
      <path d="M74 14 Q82 4 89 7" />
    </g>
  `,
  droopy: svg`
    <g class="lob-antennae" stroke="var(--lob-shell)" stroke-width="4" stroke-linecap="round" fill="none">
      <path d="M46 14 Q36 8 34 18" />
      <path d="M74 14 Q84 8 86 18" />
    </g>
  `,
};

// Not a lobster. Wide shell, eye stalks, walks sideways across the ledge,
// and the Lobsterdex refuses to acknowledge it.
function renderCrabSvg() {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g stroke="#a63a2e" stroke-width="4" stroke-linecap="round" fill="none">
        <path d="M22 78 L8 88" />
        <path d="M28 88 L16 99" />
        <path d="M98 78 L112 88" />
        <path d="M92 88 L104 99" />
      </g>
      <g stroke="#c44536" stroke-width="3.5" stroke-linecap="round" fill="none">
        <path d="M44 38 L40 24" />
        <path d="M76 38 L80 24" />
      </g>
      <circle cx="40" cy="22" r="4.5" fill="#0a1014" />
      <circle cx="80" cy="22" r="4.5" fill="#0a1014" />
      <circle cx="41.5" cy="20.5" r="1.8" fill="#ffd166" />
      <circle cx="81.5" cy="20.5" r="1.8" fill="#ffd166" />
      <ellipse cx="60" cy="70" rx="46" ry="30" fill="#c44536" />
      <ellipse cx="48" cy="60" rx="16" ry="9" fill="#ffffff" opacity="0.1" />
      <path
        d="M16 58 C2 52 -2 62 4 72 C10 82 20 76 24 66 C26 60 22 58 16 58 Z"
        fill="#d95f4b"
      />
      <path
        d="M104 58 C118 52 122 62 116 72 C110 82 100 76 96 66 C94 60 98 58 104 58 Z"
        fill="#d95f4b"
      />
      <path d="M48 82 Q60 90 72 82" stroke="#7e2a20" stroke-width="3" stroke-linecap="round" fill="none" />
    </svg>
  `;
}

// Same species as icons.lobster / the dreams-scene sleeper: smooth dome body
// with stubby legs, side claws, antennae, and teal-glint eyes.
export function renderLobsterSvg(
  look: LobsterPetLook,
  options: {
    grumpy?: boolean;
    shell?: boolean;
    sleeping?: boolean;
    standalone?: boolean;
    bindle?: boolean;
    sailorCap?: boolean;
  } = {},
) {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      ${look.palette.id === "retro" ? RETRO_ANTENNAE : ANTENNAE_SPRITES[look.antennae]}
      ${look.tailFan ? TAIL_FAN : nothing}
      <g class="lob-claw lob-claw--l">
        <path
          d="M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z"
          fill="var(--lob-claw)"
        />
      </g>
      ${
        look.palette.id === "retro"
          ? nothing
          : svg`
            <g class="lob-claw lob-claw--r">
              <path
                d="M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z"
                fill="var(--lob-claw)"
              />
            </g>
          `
      }
      <path
        d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z"
        fill="var(--lob-shell)"
      />
      ${look.palette.id === "split" ? SPLIT_HALF : nothing}
      ${look.palette.id === "calico" ? CALICO_SPOTS : nothing}
      <ellipse cx="48" cy="28" rx="20" ry="11" fill="#ffffff" opacity="0.1" />
      <g class="lob-eye-open" style=${options.shell || options.sleeping ? "display:none" : ""}>
        <circle cx="45" cy="32" r="5.5" fill="#0a1014" />
        <circle cx="75" cy="32" r="5.5" fill="#0a1014" />
        <circle cx="46.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
        <circle cx="76.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
      </g>
      ${
        options.sleeping
          ? svg`
            <g class="lob-eye-peek">
              <circle cx="45" cy="32" r="4" fill="#0a1014" />
              <circle cx="46" cy="30.8" r="1.6" fill="var(--lob-glint, #00e5cc)" />
            </g>
          `
          : nothing
      }
      <g
        class="lob-eye-closed"
        stroke="#0a1014"
        stroke-width="3"
        stroke-linecap="round"
        fill="none"
        style=${
          options.shell || options.sleeping ? "opacity:1" : options.standalone ? "display:none" : ""
        }
      >
        <path d="M39 33 Q45 28 51 33" />
        <path d="M69 33 Q75 28 81 33" />
      </g>
      ${
        look.palette.id === "retro"
          ? svg`
            ${RETRO_FACE}
            <g class="lob-claw lob-claw--r">${RETRO_MEGA_CLAW}</g>
          `
          : nothing
      }
      ${options.grumpy && look.palette.id !== "retro" ? GRUMPY_FACE : nothing}
      ${look.accessory === "none" || options.shell ? nothing : ACCESSORY_SPRITES[look.accessory]}
      ${
        // The retro grail's mega claw owns the same shoulder; it moves light.
        options.bindle && look.palette.id !== "retro" ? BINDLE : nothing
      }
      ${options.sailorCap && !options.shell && !HEADWEAR.has(look.accessory) ? SAILOR_CAP : nothing}
    </svg>
  `;
}

export const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;

function lobsterPetSpriteStyle(
  look: LobsterPetLook,
  scale: number,
  spotPct: number,
  facing: 1 | -1,
) {
  // Glint color stays class-driven (see lobster-pet.css): an inline
  // --lob-glint would out-cascade the offline grey override.
  return [
    `--lob-shell:${look.palette.shell}`,
    `--lob-claw:${look.palette.claw}`,
    `--lob-scale:${scale}`,
    `--lob-x:${spotPct}%`,
    `--lob-face:${facing}`,
    `--lob-blink-delay:${look.blinkDelayS}s`,
    `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
    `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
    `--lob-claw-scale:${LOBSTER_PET_CLAW_MULS[look.clawSize]}`,
  ].join(";");
}

export function renderLobsterPetScene(args: {
  look: LobsterPetLook;
  mode: LobsterPetMode;
  presence: "out" | "in" | "leaving";
  logoPerched: boolean;
  shellVisible: boolean;
  visitsEnabled: boolean;
  dismissed: boolean;
  passer: { kind: "stranger" | "crab"; direction: 1 | -1 } | null;
  twinPlanned: boolean;
  anniversary: boolean;
  entering: boolean;
  grumpy: boolean;
  vigil: boolean;
  act: string | null;
  zone: readonly [number, number];
  spotPct: number;
  facing: 1 | -1;
  anchor: "ledge" | "bar";
  barMaxScale: number;
  shellScale: number;
  shellSpotPct: number;
  familiarityVisits: number;
  seed: number;
  movingDay: boolean;
  sailorDay: boolean;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: Event) => void;
}) {
  const anchoredScale = (scale: number) =>
    args.anchor === "bar" ? Math.min(scale, args.barMaxScale) : scale;
  const renderSprite = (twin: boolean) => {
    // On the month/day anniversary of this palette's first Lobsterdex visit,
    // the party hat overrides whatever accessory the seed rolled.
    const dressed =
      args.anniversary && args.look.accessory !== "party"
        ? { ...args.look, accessory: "party" as const }
        : args.look;
    const classes = [
      "lobster-pet",
      `lobster-pet--${args.mode}`,
      `lobster-pet--palette-${args.look.palette.id}`,
      twin ? "lobster-pet--twin" : "",
      dressed.accessory === "party" ? "lobster-pet--party" : "",
      args.presence === "leaving" ? "lobster-pet--away" : "",
      args.entering ? "lobster-pet--entering" : "",
      args.grumpy ? "lobster-pet--grumpy" : "",
      args.vigil ? "lobster-pet--vigil" : "",
      args.act ? `lobster-pet--act-${args.act}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    // The twin tags along on the parent's trailing side and copies every act
    // a beat later (--lob-act-delay feeds each act's animation-delay).
    const spotPct = twin
      ? Math.min(
          args.zone[1],
          Math.max(args.zone[0], args.spotPct + (args.facing === 1 ? -12 : 12)),
        )
      : args.spotPct;
    const scale = anchoredScale(twin ? args.look.scale * 0.55 : args.look.scale);
    const style = twin
      ? `${lobsterPetSpriteStyle(args.look, scale, spotPct, args.facing === 1 ? -1 : 1)};--lob-act-delay:0.18s`
      : lobsterPetSpriteStyle(args.look, scale, spotPct, args.facing);
    // Milestone honorifics come from the load-start familiarity snapshot, so
    // a title never pops mid-visit; it is simply there next time.
    const honorific = lobsterHonorific(args.familiarityVisits);
    const baseName = lobsterPetName(args.look, args.seed);
    const name = honorific ? `${honorific} ${baseName}` : baseName;
    // The twin travels light; only the resident pet hauls the moving bindle.
    const bindle = args.movingDay && !twin;
    const title = twin ? `${name} Jr.` : bindle ? `${name} · just moved in` : name;
    return html`
      <div
        class=${classes}
        style=${style}
        aria-hidden="true"
        title=${title}
        @pointerdown=${args.onPointerDown}
        @pointerup=${args.onPointerUp}
        @pointercancel=${args.onPointerCancel}
        @pointerleave=${args.onPointerCancel}
        @contextmenu=${args.onContextMenu}
      >
        <div class="lobster-pet__body">
          ${renderLobsterSvg(dressed, {
            grumpy: args.grumpy,
            bindle,
            sailorCap: args.sailorDay,
          })}
          <span class="lobster-pet__z" style="--i:0">z</span>
          <span class="lobster-pet__z" style="--i:1">z</span>
          <span class="lobster-pet__z" style="--i:2">Z</span>
          <span class="lobster-pet__bubble" style="--i:0"></span>
          <span class="lobster-pet__bubble" style="--i:1"></span>
          <span class="lobster-pet__bubble" style="--i:2"></span>
          <span class="lobster-pet__heart">♥</span>
          <svg class="lobster-pet__broom" viewBox="0 0 24 40" aria-hidden="true">
            <path d="M12 2 L12 24" stroke="#8a5a2b" stroke-width="3" stroke-linecap="round" />
            <path d="M6 24 L18 24 L21 38 L3 38 Z" fill="#e8b04b" />
            <path
              d="M7.5 28 L6.5 36 M12 28 L12 36 M16.5 28 L17.5 36"
              stroke="#b6791f"
              stroke-width="1.5"
            />
          </svg>
        </div>
      </div>
    `;
  };
  // While the pet is upstairs playing logo, the ledge stays empty - one
  // crab, two homes, never both at once.
  const showSprites = args.presence !== "out" && !args.logoPerched;
  // The shell may outlive the visit while it fades, but dismissal and the
  // visits setting silence it like everything else.
  const showShell = args.shellVisible && args.visitsEnabled && !args.dismissed;
  const showPasser = args.passer !== null && args.visitsEnabled;
  if (!showSprites && !showShell && !showPasser) {
    return nothing;
  }
  // The abandoned shell: the pre-molt silhouette, frozen and slowly fading.
  const shellStyle = lobsterPetSpriteStyle(
    args.look,
    anchoredScale(args.shellScale),
    args.shellSpotPct,
    args.facing,
  );
  // A pass-through visitor: crosses the ledge once and is gone. Strangers
  // are other lobsters (never your palette); the crab is, allegedly, also a
  // lobster. Neither perches, neither counts for the Lobsterdex.
  const passerLook =
    args.passer?.kind === "stranger" ? strangerLookFor(args.seed, args.look.palette.id) : args.look;
  const passerClasses = args.passer
    ? [
        "lobster-pet",
        "lobster-pet--passer",
        args.passer.kind === "crab"
          ? "lobster-pet--crab"
          : `lobster-pet--palette-${passerLook.palette.id}`,
        args.passer.direction === 1 ? "lobster-pet--passer-ltr" : "lobster-pet--passer-rtl",
      ].join(" ")
    : "";
  const passerStyle =
    args.passer?.kind === "crab"
      ? `--lob-scale:2;--lob-w:1;--lob-h:0.82;--lob-face:1`
      : args.passer
        ? lobsterPetSpriteStyle(passerLook, Math.min(passerLook.scale, 2), 0, args.passer.direction)
        : "";
  return html`
    ${showShell
      ? html`
          <div class="lobster-pet lobster-pet--shell" style=${shellStyle} aria-hidden="true">
            <div class="lobster-pet__body">${renderLobsterSvg(args.look, { shell: true })}</div>
          </div>
        `
      : nothing}
    ${showSprites ? renderSprite(false) : nothing}
    ${showSprites && args.twinPlanned ? renderSprite(true) : nothing}
    ${showPasser && args.passer
      ? html`
          <div
            class=${passerClasses}
            style=${passerStyle}
            aria-hidden="true"
            title=${args.passer.kind === "crab" ? "definitely a lobster" : "a stranger"}
          >
            <div class="lobster-pet__body">
              ${args.passer.kind === "crab"
                ? renderCrabSvg()
                : renderLobsterSvg(passerLook, { standalone: true })}
            </div>
          </div>
        `
      : nothing}
  `;
}
