import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, svg } from "lit";
import { lobsterHonorific } from "./lobster-dex.ts";
import type {
  LobsterPasserKind,
  LobsterPetAccessory,
  LobsterPetAntennae,
  LobsterPetBuild,
  LobsterPetClawSize,
  LobsterPetEntrance,
  LobsterPetLook,
  LobsterPetMode,
  LobsterPetPalette,
  LobsterPetPaletteId,
  LobsterPetPersonalityId,
} from "./lobster-pet-contract.ts";
import {
  ACCESSORY_SPRITES,
  ANTENNAE_SPRITES,
  BALLOON,
  BINDLE,
  CALICO_SPOTS,
  FRECKLE_SPOTS,
  GRUMPY_FACE,
  HEADWEAR,
  LUMEN_SPOTS,
  PASSER_SPRITES,
  PASSER_TITLES,
  PATTERNED_PALETTES,
  RETRO_ANTENNAE,
  RETRO_FACE,
  RETRO_MEGA_CLAW,
  renderBottleSvg,
  SAILOR_CAP,
  SPLIT_HALF,
  TAIL_FAN,
} from "./lobster-pet-sprites.ts";

// Rarity ladder loosely mirrors real lobster genetics: blue ~1 in 2 million,
// yellow ~1 in 30 million, calico ~1 in 30 million, split two-tone ~1 in
// 50 million, albino/ghost ~1 in 100 million, cotton candy ~1 in 100 million.
// Abyss and lumen are our deep-sea fantasies. Split/calico extra geometry and
// ghost/abyss/lumen/cottoncandy styling key off the palette id (see
// lobster-pet.css and renderLobsterSvg).
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
  // Bioluminescent: photophore freckles that only really glow in the dark
  // theme (see .lob-lumen in lobster-pet.css).
  [{ id: "lumen", shell: "#1d2f4e", claw: "#2e4a77" }, 2],
  [{ id: "ghost", shell: "#dce8f2", claw: "#ecf3fa" }, 1],
  [{ id: "split", shell: "#ff4f40", claw: "#ff775f" }, 1],
  // Pastel pink/blue iridescence, after the famous Maine catches.
  [{ id: "cottoncandy", shell: "#f6a8c9", claw: "#a5c6f0" }, 0.8],
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
    shiny: false,
    crusherSide: null,
    freckles: false,
    glint: null,
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
  // National Lobster Day (US, Sept 25): dress fancy. We do not cook friends.
  if (month === 8 && day === 25) {
    return [["monocle", 24]];
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
const LOBSTER_PET_BUILD_MULS: Record<LobsterPetBuild, { w: number; h: number }> = {
  round: { w: 1, h: 1 },
  squat: { w: 1.14, h: 0.9 },
  slender: { w: 0.88, h: 1.1 },
};

const LOBSTER_PET_CLAW_MULS: Record<LobsterPetClawSize, number> = {
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
  lumen: "Glimmer",
  ghost: "Boo",
  split: "Picasso",
  cottoncandy: "Taffy",
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

// Seeded glint tints for common palettes (rare palettes pin their own via
// CSS). Applied through --lob-glint-seed so offline grey still wins.
const GLINT_TINTS = ["#ffd166", "#ff8ac2", "#b79bff"] as const;

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
  // Trait generations append their rolls (shape, then sparkle) so earlier
  // seeds keep their palette/personality and only gain new details.
  const build = pickWeighted(rng, BUILDS);
  const clawSize = pickWeighted(rng, CLAW_SIZES);
  const tailFan = rng() < 0.3;
  const shiny = rng() < 1 / 512;
  // Chance-and-pick pairs always burn both rolls so later traits stay
  // aligned across seeds whichever way the chance lands.
  const crusherRoll = rng();
  const crusherPick: "left" | "right" = rng() < 0.5 ? "left" : "right";
  const crusherSide = crusherRoll < 0.15 ? crusherPick : null;
  const freckles = rng() < 0.12;
  const glintRoll = rng();
  const glintPick = GLINT_TINTS[Math.floor(rng() * GLINT_TINTS.length)] ?? null;
  const glint = glintRoll < 0.3 ? glintPick : null;
  const look: LobsterPetLook = {
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
    shiny,
    crusherSide,
    freckles,
    glint,
  };
  if (isLobsterAnniversary(now)) {
    // Birthday dress code: everyone is the classic logo, party hats on.
    const retro = PALETTES.find(([entry]) => entry.id === "retro")?.[0];
    return { ...look, palette: retro ?? palette, accessory: "party" };
  }
  return look;
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
      ${look.palette.id === "lumen" ? LUMEN_SPOTS : nothing}
      ${look.freckles && !PATTERNED_PALETTES.has(look.palette.id) ? FRECKLE_SPOTS : nothing}
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

// Shared inline vars for every surface that renders a look (ledge sprite,
// twin, stranger passer). The seeded glint rides
// --lob-glint-seed instead of --lob-glint so the class-driven palette and
// offline overrides in lobster-pet.css still out-cascade it.
function lobsterLookStyleVars(look: LobsterPetLook): string[] {
  const crusher = look.crusherSide;
  const clawMul = (side: "left" | "right") =>
    crusher === null
      ? LOBSTER_PET_CLAW_MULS[look.clawSize]
      : crusher === side
        ? LOBSTER_PET_CLAW_MULS.mighty
        : LOBSTER_PET_CLAW_MULS.dainty;
  return [
    `--lob-shell:${look.palette.shell}`,
    `--lob-claw:${look.palette.claw}`,
    `--lob-blink-delay:${look.blinkDelayS}s`,
    `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
    `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
    `--lob-claw-l:${clawMul("left")}`,
    `--lob-claw-r:${clawMul("right")}`,
    ...(look.glint ? [`--lob-glint-seed:${look.glint}`] : []),
  ];
}

function lobsterPetSpriteStyle(
  look: LobsterPetLook,
  scale: number,
  spotPct: number,
  facing: 1 | -1,
) {
  return [
    ...lobsterLookStyleVars(look),
    `--lob-scale:${scale}`,
    `--lob-x:${spotPct}%`,
    `--lob-face:${facing}`,
  ].join(";");
}

export function renderLobsterPetScene(args: {
  look: LobsterPetLook;
  mode: LobsterPetMode;
  presence: "out" | "in" | "leaving";
  shellVisible: boolean;
  visitsEnabled: boolean;
  dismissed: boolean;
  passer: { kind: LobsterPasserKind; direction: 1 | -1; crossMs: number } | null;
  twinPlanned: boolean;
  anniversary: boolean;
  entering: boolean;
  entrance: LobsterPetEntrance;
  grumpy: boolean;
  vigil: boolean;
  elder: boolean;
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
  nameOverride: string | null;
  // Extra "· <flavor>" tooltip suffix (elder lore, old-friend returns).
  flavor: string | null;
  bottle: { spotPct: number; opened: boolean; fortune: string } | null;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: Event) => void;
  onBottleOpen: () => void;
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
      args.look.shiny ? "lobster-pet--shiny" : "",
      args.elder ? "lobster-pet--elder" : "",
      args.presence === "leaving" ? "lobster-pet--away" : "",
      args.entering ? "lobster-pet--entering" : "",
      args.entering && args.entrance !== "walk" ? `lobster-pet--enter-${args.entrance}` : "",
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
    const baseName = args.nameOverride ?? lobsterPetName(args.look, args.seed);
    const titled = honorific ? `${honorific} ${baseName}` : baseName;
    const name = args.look.shiny ? `✦ ${titled}` : titled;
    // The twin travels light; only the resident pet hauls the moving bindle.
    const bindle = args.movingDay && !twin;
    const title = twin
      ? `${name} Jr.`
      : bindle
        ? `${name} · just moved in`
        : args.flavor
          ? `${name} · ${args.flavor}`
          : name;
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
          ${args.entering && args.entrance === "balloon" ? BALLOON : nothing}
          ${args.entering && args.entrance === "bubble"
            ? html`<span class="lobster-pet__entry-bubble"></span>`
            : nothing}
          ${args.look.shiny
            ? html`
                <span class="lobster-pet__sparkle" style="--i:0;left:12%;bottom:64%">✦</span>
                <span class="lobster-pet__sparkle" style="--i:1;left:76%;bottom:82%">✦</span>
              `
            : nothing}
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
  const showSprites = args.presence !== "out";
  // The shell may outlive the visit while it fades, but dismissal and the
  // visits setting silence it like everything else.
  const showShell = args.shellVisible && args.visitsEnabled && !args.dismissed;
  const showPasser = args.passer !== null && args.visitsEnabled;
  // The bottle washes ashore whether or not the pet is around; it belongs to
  // the ledge, not the visit. Like every sprite here it is intentionally
  // aria-hidden and pointer-only, with fortunes on the native-tooltip channel
  // (no i18n surface); it must not join the tab order, where a surprise
  // easter-egg button would degrade keyboard flow.
  const showBottle = args.bottle !== null && args.visitsEnabled && !args.dismissed;
  if (!showSprites && !showShell && !showPasser && !showBottle) {
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
  // are other lobsters (never your palette); everyone else is at most
  // lobster-adjacent. None perch, none count for the Lobsterdex.
  const passerLook =
    args.passer?.kind === "stranger" ? strangerLookFor(args.seed, args.look.palette.id) : args.look;
  const passerClasses = args.passer
    ? [
        "lobster-pet",
        "lobster-pet--passer",
        args.passer.kind === "stranger"
          ? `lobster-pet--palette-${passerLook.palette.id}`
          : `lobster-pet--${args.passer.kind}`,
        args.passer.kind === "stranger" && passerLook.shiny ? "lobster-pet--shiny" : "",
        args.passer.direction === 1 ? "lobster-pet--passer-ltr" : "lobster-pet--passer-rtl",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const passerStyle = args.passer
    ? `${passerBaseStyle(args.passer.kind, args.passer.direction, passerLook)};--lob-cross:${args.passer.crossMs}ms`
    : "";
  return html`
    ${showShell
      ? html`
          <div class="lobster-pet lobster-pet--shell" style=${shellStyle} aria-hidden="true">
            <div class="lobster-pet__body">${renderLobsterSvg(args.look, { shell: true })}</div>
          </div>
        `
      : nothing}
    ${showBottle && args.bottle
      ? html`
          <div
            class="lobster-bottle ${args.bottle.opened ? "lobster-bottle--open" : ""}"
            style="--lob-x:${args.bottle.spotPct}%"
            title=${args.bottle.opened ? args.bottle.fortune : "a message in a bottle"}
            aria-hidden="true"
            @pointerdown=${args.onBottleOpen}
          >
            ${renderBottleSvg(args.bottle.opened)}
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
            title=${PASSER_TITLES[args.passer.kind]}
          >
            <div class="lobster-pet__body">
              ${args.passer.kind === "stranger"
                ? renderLobsterSvg(passerLook, { standalone: true })
                : PASSER_SPRITES[args.passer.kind]()}
            </div>
          </div>
        `
      : nothing}
  `;
}

// Non-lobster passers ignore the perch variables and carry fixed sprite
// proportions; strangers reuse the full look pipeline (capped size so a
// visiting grail does not upstage the resident).
function passerBaseStyle(
  kind: LobsterPasserKind,
  direction: 1 | -1,
  passerLook: LobsterPetLook,
): string {
  if (kind === "stranger") {
    return lobsterPetSpriteStyle(passerLook, Math.min(passerLook.scale, 2), 0, direction);
  }
  const fixed: Record<Exclude<LobsterPasserKind, "stranger">, string> = {
    crab: "--lob-scale:2;--lob-w:1;--lob-h:0.82;--lob-face:1",
    snail: `--lob-scale:1.7;--lob-w:1;--lob-h:0.9;--lob-face:${direction}`,
    duck: `--lob-scale:1.9;--lob-w:1;--lob-h:1;--lob-face:${direction}`,
    jellyfish: "--lob-scale:1.7;--lob-w:0.9;--lob-h:1.1;--lob-face:1",
  };
  return fixed[kind];
}
