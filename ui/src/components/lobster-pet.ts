// Decorative lobster pet that perches on the sidebar footer and mirrors
// gateway status: it idles (naps, waves, wanders) when nothing is running,
// scurries while runs are active, and paces worriedly while disconnected.
// Drawn in the smooth OpenClaw lobster style (see the dreams scene and
// icons.lobster). Look and personality are seeded per session + page load so
// every new session hatches a slightly different lobster.
import { html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

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
  | "molt";

export type LobsterPetMode = "idle" | "busy" | "offline";

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
  | "ghost"
  | "split"
  | "retro";

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
  | "party";

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
};

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
export const LOBSTER_PET_MODE_ACTS: Record<Exclude<LobsterPetMode, "idle">, ActProfile> = {
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

// Keep the perch off the footer center so tooltips and the theme toggle
// never sit under the sprite.
const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;
const ENTER_MS = 450;
const LEAVE_MS = 350;

export type LobsterPetAnchor = "ledge" | "bar";

// The bar anchor stands the pet inside the footer bar's free stretch between
// the status dot (left) and the settings icons (right).
const BAR_ZONE = [18, 50] as const;
// Inside the ~30px bar the sprite must stay small regardless of rolled size.
const BAR_MAX_SCALE = 1.7;

// Visit cadence: seeded per load, the pet is a guest, not a fixture. A share
// of loads gets no visit at all; the rest get a first arrival within minutes,
// stays of a few minutes, and long gaps between returns. Disconnects summon
// the pet regardless of schedule (unless dismissed or disabled).
const VISIT_SHY_CHANCE = 0.25;
const VISIT_FIRST_DELAY_MS = [15_000, 180_000] as const;
const VISIT_STAY_MS = [90_000, 300_000] as const;
const VISIT_GAP_MS = [360_000, 1_080_000] as const;

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
  return RARE_NAMES[look.palette.id] ?? PET_NAMES[(seed >>> 3) % PET_NAMES.length];
}

// Rare-event loads, planned per seed so tests can probe them purely: a molt
// load sheds its shell during the first idle act and sizes up one tier; a
// twin load brings a mini copycat along on every visit.
export function isLobsterMoltLoad(seed: number): boolean {
  return mulberry32((seed ^ 0x301d) >>> 0)() < 0.12;
}

export function isLobsterTwinLoad(seed: number): boolean {
  return mulberry32((seed ^ 0x7715) >>> 0)() < 0.04;
}

// Late-night visitors are always sleepy, whatever their daytime personality.
export function isLobsterNightTime(now: Date = new Date()): boolean {
  const hour = now.getHours();
  return hour >= 22 || hour < 6;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(rng: () => number, entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) {
      return value;
    }
  }
  return entries[entries.length - 1][0];
}

function randomBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

// One salt per page load: revisiting the UI re-rolls every session's lobster,
// while re-renders within a load stay stable for a given session key.
const LOAD_SALT = Math.trunc(Math.random() * 0xffffffff);

export function lobsterPetSeed(sessionKey: string): number {
  return (fnv1a(sessionKey) ^ LOAD_SALT) >>> 0;
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

export function resolveLobsterPetMode(
  connected: boolean,
  sessions: ReadonlyArray<{ hasActiveRun?: boolean | null }> | null | undefined,
): LobsterPetMode {
  if (!connected) {
    return "offline";
  }
  return sessions?.some((row) => row.hasActiveRun === true) ? "busy" : "idle";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
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

// Same species as icons.lobster / the dreams-scene sleeper: smooth dome body
// with stubby legs, side claws, antennae, and teal-glint eyes.
function renderLobsterSvg(
  look: LobsterPetLook,
  options: { grumpy?: boolean; shell?: boolean } = {},
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
      <g class="lob-eye-open" style=${options.shell ? "display:none" : ""}>
        <circle cx="45" cy="32" r="5.5" fill="#0a1014" />
        <circle cx="75" cy="32" r="5.5" fill="#0a1014" />
        <circle cx="46.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
        <circle cx="76.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
      </g>
      <g
        class="lob-eye-closed"
        stroke="#0a1014"
        stroke-width="3"
        stroke-linecap="round"
        fill="none"
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
    </svg>
  `;
}

export class LobsterPet extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) seed = 0;
  @property({ attribute: false }) mode: LobsterPetMode = "idle";

  @property({ attribute: false }) visitsEnabled = true;

  @state() private act: LobsterPetAct | null = null;
  @state() private spotPct = 80;
  @state() private facing: 1 | -1 = 1;
  @state() private entering = false;
  @state() private presence: "out" | "in" | "leaving" = "out";
  @state() private anchor: LobsterPetAnchor = "ledge";
  @state() private scheduledVisiting = false;
  @state() private dismissed = false;
  @state() private grumpy = false;
  @state() private shellVisible = false;
  private shellSpotPct = 50;
  private shellScale = 2;
  private molted = false;
  private moltPlanned = false;
  private twinPlanned = false;
  private shellTimer: number | null = null;

  private look: LobsterPetLook | null = null;
  private rng: () => number = mulberry32(0);
  private visitRng: () => number = mulberry32(0);
  private idleTimer: number | null = null;
  private actEndTimer: number | null = null;
  private enterTimer: number | null = null;
  private visitTimer: number | null = null;
  private leaveTimer: number | null = null;
  private grumpyTimer: number | null = null;
  private pokeTimes: number[] = [];
  private restartPending = false;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearActTimers();
    this.clearVisitTimers();
    if (this.grumpyTimer !== null) {
      window.clearTimeout(this.grumpyTimer);
      this.grumpyTimer = null;
    }
    if (this.shellTimer !== null) {
      window.clearTimeout(this.shellTimer);
      this.shellTimer = null;
    }
    super.disconnectedCallback();
  }

  private wantsVisible(): boolean {
    return (
      this.visitsEnabled && !this.dismissed && (this.mode === "offline" || this.scheduledVisiting)
    );
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    const seedChanged = this.look === null || changed.has("seed");
    if (seedChanged) {
      this.look = createLobsterPetLook(this.seed);
      this.rng = mulberry32(this.seed ^ 0x9e3779b9);
      this.visitRng = mulberry32(this.seed ^ 0x5eaf00d);
      this.spotPct = this.look.spotPct;
      this.facing = this.look.facing;
      // Reset the act loop inside the update pass; deferring state flips to
      // updated() would chain a second update and trip lit's change-in-update
      // warning.
      this.clearActTimers();
      this.act = null;
      this.dismissed = false;
      this.presence = "out";
      this.molted = false;
      this.shellVisible = false;
      if (this.shellTimer !== null) {
        window.clearTimeout(this.shellTimer);
        this.shellTimer = null;
      }
      this.moltPlanned = isLobsterMoltLoad(this.seed);
      this.twinPlanned = isLobsterTwinLoad(this.seed);
      this.scheduleVisits();
    } else if (changed.has("mode") && this.presence === "in" && !prefersReducedMotion()) {
      // Status flips get an immediate reaction; a finished run (busy -> idle)
      // earns a celebration, everything else a startle. The act-end timer
      // then reschedules from the new mode's pool.
      const previousMode = changed.get("mode") as LobsterPetMode | undefined;
      this.performAct(previousMode === "busy" && this.mode === "idle" ? "cheer" : "startle");
    }
    this.reconcilePresence();
  }

  // Presence follows the visit schedule, offline summons, the setting, and
  // dismissals. Runs inside the update pass so arrivals/departures never
  // chain a post-update state change.
  private reconcilePresence() {
    const visible = this.wantsVisible();
    if (visible && this.presence !== "in") {
      if (this.leaveTimer !== null) {
        window.clearTimeout(this.leaveTimer);
        this.leaveTimer = null;
      }
      if (this.presence === "out") {
        this.rollPerch();
      }
      this.presence = "in";
      this.entering = !prefersReducedMotion();
      this.restartPending = true;
      return;
    }
    if (!visible && this.presence === "in") {
      this.clearActTimers();
      this.act = null;
      this.entering = false;
      this.presence = "leaving";
      this.leaveTimer = window.setTimeout(() => {
        this.leaveTimer = null;
        this.presence = "out";
      }, LEAVE_MS);
    }
  }

  override updated() {
    if (!this.restartPending) {
      return;
    }
    this.restartPending = false;
    this.enterTimer = window.setTimeout(() => {
      this.enterTimer = null;
      this.entering = false;
    }, ENTER_MS);
    this.scheduleNextAct();
  }

  private readonly handleVisibilityChange = () => {
    if (document.hidden) {
      this.clearActTimers();
      this.act = null;
    } else {
      this.scheduleNextAct();
    }
  };

  // Pokes are fun until they are not: 3 fast pokes turn it grumpy for a
  // minute, 10 send it off in a huff until a later visit. Offline pets are
  // on duty and never huff.
  private readonly handlePoke = () => {
    if (prefersReducedMotion()) {
      return;
    }
    const now = Date.now();
    this.pokeTimes = [...this.pokeTimes.filter((at) => now - at < 6000), now];
    if (this.pokeTimes.length >= 10 && this.mode !== "offline") {
      this.huffOff();
      return;
    }
    if (this.pokeTimes.length >= 3) {
      this.enterGrumpy();
    }
    this.performAct("startle");
  };

  private enterGrumpy() {
    this.grumpy = true;
    if (this.grumpyTimer !== null) {
      window.clearTimeout(this.grumpyTimer);
    }
    this.grumpyTimer = window.setTimeout(() => {
      this.grumpyTimer = null;
      this.grumpy = false;
    }, 60_000);
  }

  private huffOff() {
    this.pokeTimes = [];
    this.grumpy = false;
    // Ends the current visit only; unlike a right-click dismissal the pet
    // still returns on a later scheduled visit.
    this.clearVisitTimers();
    this.scheduledVisiting = false;
    this.armArrival(randomBetween(this.visitRng, VISIT_GAP_MS[0], VISIT_GAP_MS[1]));
  }

  // Right-click shoos the pet away for the rest of this page load.
  private readonly handleShoo = (event: Event) => {
    event.preventDefault();
    this.dismissed = true;
  };

  private clearActTimers() {
    for (const timer of [this.idleTimer, this.actEndTimer, this.enterTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.idleTimer = null;
    this.actEndTimer = null;
    this.enterTimer = null;
  }

  private clearVisitTimers() {
    for (const timer of [this.visitTimer, this.leaveTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.visitTimer = null;
    this.leaveTimer = null;
  }

  // ---- Visit schedule ----

  private scheduleVisits() {
    this.clearVisitTimers();
    this.scheduledVisiting = false;
    // A shy share of loads never visits on their own; offline still summons.
    if (this.visitRng() < VISIT_SHY_CHANCE) {
      return;
    }
    this.armArrival(randomBetween(this.visitRng, VISIT_FIRST_DELAY_MS[0], VISIT_FIRST_DELAY_MS[1]));
  }

  private armArrival(delayMs: number) {
    this.visitTimer = window.setTimeout(() => {
      this.visitTimer = null;
      this.rollPerch();
      this.scheduledVisiting = true;
      this.armDeparture(randomBetween(this.visitRng, VISIT_STAY_MS[0], VISIT_STAY_MS[1]));
    }, delayMs);
  }

  private armDeparture(stayMs: number) {
    this.visitTimer = window.setTimeout(() => {
      this.visitTimer = null;
      this.scheduledVisiting = false;
      this.armArrival(randomBetween(this.visitRng, VISIT_GAP_MS[0], VISIT_GAP_MS[1]));
    }, stayMs);
  }

  // Each arrival re-rolls where the pet shows up: the ledge above the footer
  // divider or the free stretch inside the footer bar.
  private rollPerch() {
    this.anchor = this.visitRng() < 0.6 ? "ledge" : "bar";
    this.setAttribute("data-spot", this.anchor);
    const zone = this.currentZone();
    this.spotPct = Math.round(randomBetween(this.visitRng, zone[0], zone[1]));
    this.facing = this.visitRng() < 0.5 ? 1 : -1;
  }

  private currentZone(): readonly [number, number] {
    if (this.anchor === "bar") {
      return BAR_ZONE;
    }
    const side = this.look?.side ?? "right";
    return SPOT_ZONES[side];
  }

  private actProfile(): ActProfile | null {
    if (this.mode === "busy" || this.mode === "offline") {
      return LOBSTER_PET_MODE_ACTS[this.mode];
    }
    if (isLobsterNightTime()) {
      return PERSONALITIES.sleepy;
    }
    return this.look ? PERSONALITIES[this.look.personality] : null;
  }

  private scheduleNextAct() {
    // Guard here, not just at activation: the visibilitychange resume path
    // must also stay inert for reduced-motion users and departed pets.
    if (
      !this.look ||
      this.presence !== "in" ||
      this.idleTimer !== null ||
      this.actEndTimer !== null ||
      prefersReducedMotion()
    ) {
      return;
    }
    const profile = this.actProfile();
    if (!profile) {
      return;
    }
    const delay = randomBetween(this.rng, profile.delayMs[0], profile.delayMs[1]);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      const nextProfile = this.actProfile();
      if (!nextProfile || document.hidden || this.presence !== "in") {
        return;
      }
      if (this.moltPlanned && !this.molted && this.mode === "idle") {
        this.performAct("molt");
        return;
      }
      this.performAct(pickWeighted(this.rng, nextProfile.acts));
    }, delay);
  }

  private performAct(act: LobsterPetAct) {
    this.clearActTimers();
    this.entering = false;
    if (act === "scuttle") {
      this.startScuttle();
    }
    this.act = act;
    this.actEndTimer = window.setTimeout(() => {
      this.actEndTimer = null;
      this.act = null;
      if (act === "molt") {
        this.completeMolt();
      }
      this.scheduleNextAct();
    }, LOBSTER_PET_ACT_DURATION_MS[act]);
  }

  // Shedding: the old shell stays behind and slowly fades while the pet
  // steps aside one size bigger. Once per load.
  private completeMolt() {
    this.molted = true;
    if (this.look) {
      const tiers = [1.7, 2, 2.5];
      const index = tiers.indexOf(this.look.scale);
      // The shed shell keeps the true pre-molt size; a max-tier pet sheds a
      // max-tier shell.
      this.shellScale = this.look.scale;
      this.look = { ...this.look, scale: tiers[Math.min(index + 1, tiers.length - 1)] };
    }
    this.shellSpotPct = this.spotPct;
    this.shellVisible = true;
    const zone = this.currentZone();
    this.spotPct = Math.min(
      zone[1],
      Math.max(zone[0], this.spotPct + (this.facing === 1 ? 9 : -9)),
    );
    if (this.shellTimer !== null) {
      window.clearTimeout(this.shellTimer);
    }
    this.shellTimer = window.setTimeout(() => {
      this.shellTimer = null;
      this.shellVisible = false;
    }, 60_000);
  }

  private startScuttle() {
    if (!this.look) {
      return;
    }
    const zone = this.currentZone();
    let target = Math.round(randomBetween(this.rng, zone[0], zone[1]));
    // A same-spot walk reads as a glitch; nudge to the other zone edge.
    if (Math.abs(target - this.spotPct) < 4) {
      target =
        Math.abs(zone[0] - this.spotPct) > Math.abs(zone[1] - this.spotPct) ? zone[0] : zone[1];
    }
    this.facing = target < this.spotPct ? -1 : 1;
    this.spotPct = target;
  }

  private spriteStyle(look: LobsterPetLook, scale: number, spotPct: number, facing: 1 | -1) {
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

  // The bar anchor stands inside the ~30px footer bar, so cap the sprite.
  private anchoredScale(scale: number): number {
    return this.anchor === "bar" ? Math.min(scale, BAR_MAX_SCALE) : scale;
  }

  private renderSprite(look: LobsterPetLook, twin: boolean) {
    const classes = [
      "lobster-pet",
      `lobster-pet--${this.mode}`,
      `lobster-pet--palette-${look.palette.id}`,
      twin ? "lobster-pet--twin" : "",
      look.accessory === "party" ? "lobster-pet--party" : "",
      this.presence === "leaving" ? "lobster-pet--away" : "",
      this.entering ? "lobster-pet--entering" : "",
      this.grumpy ? "lobster-pet--grumpy" : "",
      this.act ? `lobster-pet--act-${this.act}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const zone = this.currentZone();
    // The twin tags along on the parent's trailing side and copies every act
    // a beat later (--lob-act-delay feeds each act's animation-delay).
    const spotPct = twin
      ? Math.min(zone[1], Math.max(zone[0], this.spotPct + (this.facing === 1 ? -12 : 12)))
      : this.spotPct;
    const scale = this.anchoredScale(twin ? look.scale * 0.55 : look.scale);
    const style = twin
      ? `${this.spriteStyle(look, scale, spotPct, this.facing === 1 ? -1 : 1)};--lob-act-delay:0.18s`
      : this.spriteStyle(look, scale, spotPct, this.facing);
    const name = lobsterPetName(look, this.seed);
    return html`
      <div
        class=${classes}
        style=${style}
        aria-hidden="true"
        title=${twin ? `${name} Jr.` : name}
        @pointerdown=${this.handlePoke}
        @contextmenu=${this.handleShoo}
      >
        <div class="lobster-pet__body">
          ${renderLobsterSvg(look, { grumpy: this.grumpy })}
          <span class="lobster-pet__z" style="--i:0">z</span>
          <span class="lobster-pet__z" style="--i:1">z</span>
          <span class="lobster-pet__z" style="--i:2">Z</span>
          <span class="lobster-pet__bubble" style="--i:0"></span>
          <span class="lobster-pet__bubble" style="--i:1"></span>
          <span class="lobster-pet__bubble" style="--i:2"></span>
        </div>
      </div>
    `;
  }

  // The abandoned shell: the pre-molt silhouette, frozen and slowly fading.
  private renderShell(look: LobsterPetLook) {
    const style = this.spriteStyle(
      look,
      this.anchoredScale(this.shellScale),
      this.shellSpotPct,
      this.facing,
    );
    return html`
      <div class="lobster-pet lobster-pet--shell" style=${style} aria-hidden="true">
        <div class="lobster-pet__body">${renderLobsterSvg(look, { shell: true })}</div>
      </div>
    `;
  }

  override render() {
    const look = this.look;
    if (!look) {
      return nothing;
    }
    const showSprites = this.presence !== "out";
    // The shell may outlive the visit while it fades, but dismissal and the
    // visits setting silence it like everything else.
    const showShell = this.shellVisible && this.visitsEnabled && !this.dismissed;
    if (!showSprites && !showShell) {
      return nothing;
    }
    return html`
      ${showShell ? this.renderShell(look) : nothing}
      ${showSprites ? this.renderSprite(look, false) : nothing}
      ${showSprites && this.twinPlanned ? this.renderSprite(look, true) : nothing}
    `;
  }
}

if (!customElements.get("openclaw-lobster-pet")) {
  customElements.define("openclaw-lobster-pet", LobsterPet);
}
