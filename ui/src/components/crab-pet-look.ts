import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, svg } from "lit";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { crabHonorific } from "./crab-dex.ts";
import type {
  CrabPasserKind,
  CrabPetAccessory,
  CrabPetAntennae,
  CrabPetBuild,
  CrabPetClawSize,
  CrabPetEntrance,
  CrabPetLook,
  CrabPetMode,
  CrabPetPalette,
  CrabPetPaletteId,
  CrabPetPersonalityId,
} from "./crab-pet-contract.ts";
import { crabPaletteName, crabRandomName } from "./crab-pet-lore.ts";
import { moonPhaseFraction } from "./crab-pet-moon.ts";
import {
  CANONICAL_CHIMERA_PARTS,
  CRAB_PALETTE_WEIGHTS,
  chimeraBodyClaw,
  rollChimeraParts,
} from "./crab-pet-palettes.ts";
import {
  ACTUAL_CRAB,
  ASCII_CRAB,
  BALLOON_CRAB,
  FLATPACK_CRAB,
  LOADING_CRAB,
  PORTAL_CRAB,
  TINFOIL_PARTS,
} from "./crab-pet-sprites-wild.ts";
import {
  ACCESSORY_SPRITES,
  ANTENNAE_SPRITES,
  BALLOON,
  BINDLE,
  FRECKLE_SPOTS,
  GLITCH_GHOSTS,
  GRUMPY_FACE,
  HEADWEAR,
  PALETTE_OVERLAYS,
  PASSER_SPRITES,
  PASSER_TITLES,
  PATTERNED_PALETTES,
  PIXEL_CRAB,
  RETRO_ANTENNAE,
  RETRO_FACE,
  RETRO_MEGA_CLAW,
  renderBottleSvg,
  SAILOR_CAP,
  SELENE_MOON,
  SPLIT_HALF,
  TAIL_FAN,
} from "./crab-pet-sprites.ts";

export { CRAB_PET_PALETTES } from "./crab-pet-palettes.ts";

const RETRO_GEOMETRY_PALETTES: ReadonlySet<CrabPetPaletteId> = new Set(["retro", "goldenretro"]);

const PALETTE_FRAME_CLASSES: Partial<Record<CrabPetPaletteId, string>> = {
  heisenbug: "crab-heisenbug-frame",
  cryptid: "crab-cryptid-frame",
  balloon: "crab-balloon-frame",
};

// A neutral look used to render catalog minis outside the pet lifecycle.
export function canonicalCrabLook(palette: CrabPetPalette): CrabPetLook {
  const paletteHash = fnv1aUtf16(palette.id);
  return {
    palette,
    scale: 2,
    accessory: "none",
    antennae: "perky",
    side: "left",
    spotPct: 0,
    facing: 1,
    personality: "friendly",
    blinkDelayS: (paletteHash % 36) / 10,
    build: "round",
    clawSize: "regular",
    tailFan: false,
    shiny: false,
    crusherSide: null,
    freckles: false,
    glint: null,
    chimeraParts: palette.id === "chimera" ? CANONICAL_CHIMERA_PARTS : null,
  };
}

const ACCESSORIES: Array<[CrabPetAccessory, number]> = [
  ["none", 62],
  ["sprout", 14],
  ["patch", 14],
  ["crown", 10],
];

// OpenClaw's repository was born 2025-11-24 (GitHub created_at); on the
// anniversary every visitor dresses as the classic logo and parties.
const ANNIVERSARY = { month: 10, day: 24 } as const;

function isCrabAnniversary(now: Date): boolean {
  return now.getMonth() === ANNIVERSARY.month && now.getDate() === ANNIVERSARY.day;
}

// Seasonal wardrobe: extra accessory entries join the pool on the right
// dates. One weighted roll either way, so the rest of the look sequence is
// unchanged on any given seed.
function seasonalAccessories(now: Date): Array<[CrabPetAccessory, number]> {
  const month = now.getMonth();
  const day = now.getDate();
  if (month === 11) {
    return [["santa", 18]];
  }
  if (month === 9 && day >= 20) {
    return [["pumpkin", 18]];
  }
  // National Crab Day (US, Sept 25): dress fancy. We do not cook friends.
  if (month === 8 && day === 25) {
    return [["monocle", 24]];
  }
  return [];
}

const PERSONALITY_IDS: Array<[CrabPetPersonalityId, number]> = [
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

const BUILDS: Array<[CrabPetBuild, number]> = [
  ["round", 40],
  ["squat", 30],
  ["slender", 30],
];

const CLAW_SIZES: Array<[CrabPetClawSize, number]> = [
  ["regular", 55],
  ["dainty", 25],
  ["mighty", 20],
];

// Builds reshape the whole sprite by stretching its aspect ratio (the svg
// renders with preserveAspectRatio="none"), so eyes, claws, accessories, and
// rare-variant geometry stay aligned for every silhouette.
const CRAB_PET_BUILD_MULS: Record<CrabPetBuild, { w: number; h: number }> = {
  round: { w: 1, h: 1 },
  squat: { w: 1.14, h: 0.94 },
  slender: { w: 0.88, h: 1.1 },
};

const CRAB_PET_CLAW_MULS: Record<CrabPetClawSize, number> = {
  dainty: 0.85,
  regular: 1,
  mighty: 1.18,
};

export function crabPetName(look: CrabPetLook, seed: number): string {
  const signatureName = crabPaletteName(look.palette.id);
  return signatureName !== look.palette.id ? signatureName : crabRandomName(seed);
}

// A stranger wears a different palette than the resident pet.
function strangerLookFor(seed: number, own: CrabPetPaletteId): CrabPetLook {
  for (let offset = 1; offset <= 24; offset++) {
    const look = createCrabPetLook((seed + offset * 7919) >>> 0);
    if (look.palette.id !== own) {
      return look;
    }
  }
  return createCrabPetLook((seed + 1) >>> 0);
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
  return expectDefined(entries.at(-1), "weighted crab choice fallback")[0];
}

export function randomBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

// Seeded glint tints for common palettes (rare palettes pin their own via
// CSS). Applied through --crab-glint-seed so offline grey still wins.
const GLINT_TINTS = ["#3fff7d", "#4ecfa6", "#b79bff"] as const;

export function createCrabPetLook(seed: number, now: Date = new Date()): CrabPetLook {
  const rng = mulberry32(seed);
  const palette = pickWeighted(rng, CRAB_PALETTE_WEIGHTS);
  const scale = pickWeighted(rng, SCALES);
  const accessory = pickWeighted(rng, [...ACCESSORIES, ...seasonalAccessories(now)]);
  const antennae: CrabPetAntennae = rng() < 0.6 ? "perky" : "droopy";
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
  // Append-only trait discipline: always burn all four distinct donor rolls,
  // then expose them only for Chimera so older seeded traits never shift.
  const rolledChimeraParts = rollChimeraParts(rng);
  const chimeraParts = palette.id === "chimera" ? rolledChimeraParts : null;
  const look: CrabPetLook = {
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
    chimeraParts,
  };
  // The LED rides the perky antenna tip. Keep the original antenna roll above
  // so adding Clawtron does not shift any later seeded trait.
  let preparedLook = palette.id === "clawtron" ? { ...look, antennae: "perky" as const } : look;
  // The undead do not do perky. Preserve the antenna roll above so later
  // seeded traits stay aligned, then enforce the identity at the end.
  if (palette.id === "zombie") {
    preparedLook = { ...look, antennae: "droopy" };
  }
  if (isCrabAnniversary(now)) {
    // Birthday dress code: everyone is the classic logo, party hats on.
    const retro = CRAB_PALETTE_WEIGHTS.find(([entry]) => entry.id === "retro")?.[0];
    return {
      ...preparedLook,
      palette: retro ?? palette,
      accessory: "party",
      chimeraParts: null,
    };
  }
  return preparedLook;
}

// Same species as icons.crab / the dreams-scene sleeper: smooth dome body
// with stubby legs, side claws, eye stalks, and teal-glint eyes.
const READING_BOOK = svg`
  <g class="crab-reading-book" transform="translate(0 2)">
    <path
      d="M25 62 Q43 56 59 66 L59 92 Q43 82 25 86 Z M61 66 Q77 56 95 62 L95 86 Q77 82 61 92 Z"
      fill="var(--crab-claw)"
      stroke="color-mix(in srgb, var(--crab-claw) 72%, #0a1014)"
      stroke-width="2.5"
      stroke-linejoin="round"
    />
    <path d="M29 62 Q44 58 59 68 L59 88 Q44 79 29 82 Z" fill="#fffaf0" />
    <path d="M61 68 Q76 58 91 62 L91 82 Q76 79 61 88 Z" fill="#fffaf0" />
    <path d="M60 67 L60 89" stroke="#d7cfc0" stroke-width="1.5" />
    <g stroke="#b8b0a3" stroke-width="1.25" stroke-linecap="round" opacity="0.58">
      <path d="M34 67 L51 71" /><path d="M34 72 L50 75" /><path d="M67 71 L85 67" />
      <path d="M68 76 L85 72" /><path d="M70 80 L83 77" />
    </g>
    <path
      class="crab-reading-book__page-glow"
      d="M31 62 Q45 59 57 68 L57 72 Q44 65 31 67 Z"
      fill="#ffffff"
      opacity="0"
    />
  </g>
`;

export function renderCrabSvg(
  look: CrabPetLook,
  options: {
    grumpy?: boolean;
    shell?: boolean;
    sleeping?: boolean;
    standalone?: boolean;
    bindle?: boolean;
    sailorCap?: boolean;
    reading?: boolean;
  } = {},
) {
  const isPixel = look.palette.id === "pixel";
  const isFlatpack = look.palette.id === "flatpack";
  const isLoading = look.palette.id === "loading";
  const isActual = look.palette.id === "actual";
  const isBalloon = look.palette.id === "balloon";
  const isAscii = look.palette.id === "ascii";
  const isPortal = look.palette.id === "portal";
  const isNewReplacementGeometry = isBalloon || isAscii || isPortal;
  const hasRetroGeometry = RETRO_GEOMETRY_PALETTES.has(look.palette.id);
  const eyesClosed = options.shell || (options.sleeping && !options.reading);
  const openEyeStyle = eyesClosed ? "display:none" : "";
  const closedEyeStyle = eyesClosed
    ? "opacity:1"
    : options.standalone || options.reading
      ? "display:none"
      : "";
  const selenePhase = Math.round(moonPhaseFraction(new Date()) * 8) % 8;
  return svg`
    <svg
      class="crab-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g class=${PALETTE_FRAME_CLASSES[look.palette.id] ?? ""}>
        ${
          isFlatpack
            ? FLATPACK_CRAB(openEyeStyle, closedEyeStyle)
            : isLoading
              ? LOADING_CRAB(openEyeStyle, closedEyeStyle)
              : isActual
                ? ACTUAL_CRAB(openEyeStyle, closedEyeStyle)
                : isBalloon
                  ? BALLOON_CRAB(openEyeStyle, closedEyeStyle)
                  : isAscii
                    ? ASCII_CRAB(openEyeStyle, closedEyeStyle)
                    : isPortal
                      ? PORTAL_CRAB(openEyeStyle, closedEyeStyle)
                      : isPixel
                        ? PIXEL_CRAB(openEyeStyle, closedEyeStyle)
                        : svg`
              ${hasRetroGeometry ? RETRO_ANTENNAE : ANTENNAE_SPRITES[look.antennae]}
              ${hasRetroGeometry && look.tailFan ? TAIL_FAN : nothing}
              <g class="crab-claw crab-claw--l">
                <path d="M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z" fill="var(--crab-claw)" />
              </g>
              ${
                hasRetroGeometry
                  ? nothing
                  : svg`<g class="crab-claw crab-claw--r"><path d="M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z" fill="var(--crab-claw)" /></g>`
              }
              ${look.palette.id === "heisenbug" ? GLITCH_GHOSTS : nothing}
              <path class="crab-standard-dome" d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" fill="var(--crab-shell)" />
              ${look.palette.id === "split" || look.palette.id === "geode" ? SPLIT_HALF : nothing}
              ${look.palette.id === "selene" ? SELENE_MOON(selenePhase) : nothing}
              ${PALETTE_OVERLAYS[look.palette.id] ?? nothing}
              ${
                look.palette.id === "tinfoil"
                  ? TINFOIL_PARTS(!HEADWEAR.has(look.accessory))
                  : nothing
              }
              ${look.freckles && !PATTERNED_PALETTES.has(look.palette.id) ? FRECKLE_SPOTS : nothing}
              ${look.palette.id === "invisible" ? nothing : svg`<ellipse cx="48" cy="28" rx="20" ry="11" fill="#ffffff" opacity="0.1" />`}
              <g class="crab-eye-open" style=${openEyeStyle}>
                <circle cx="45" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="75" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="46.5" cy="30.5" r="2.2" fill="var(--crab-glint, #00e5cc)" />
                <circle cx="76.5" cy="30.5" r="2.2" fill="var(--crab-glint, #00e5cc)" />
              </g>
              ${
                options.sleeping && !options.reading
                  ? svg`<g class="crab-eye-peek"><circle cx="45" cy="32" r="4" fill="#0a1014" /><circle cx="46" cy="30.8" r="1.6" fill="var(--crab-glint, #00e5cc)" /></g>`
                  : nothing
              }
              <g class="crab-eye-closed" stroke="#0a1014" stroke-width="3" stroke-linecap="round" fill="none" style=${closedEyeStyle}>
                <path d="M39 33 Q45 28 51 33" /><path d="M69 33 Q75 28 81 33" />
              </g>
            `
        }
      ${
        hasRetroGeometry
          ? svg`
            ${RETRO_FACE}
            <g class="crab-claw crab-claw--r">${RETRO_MEGA_CLAW}</g>
          `
          : nothing
      }
      ${
        options.grumpy &&
        !hasRetroGeometry &&
        !isFlatpack &&
        !isLoading &&
        !isActual &&
        !isNewReplacementGeometry
          ? GRUMPY_FACE
          : nothing
      }
      ${
        look.accessory === "none" || options.shell || isFlatpack
          ? nothing
          : ACCESSORY_SPRITES[look.accessory]
      }
      ${
        // The retro grail's mega claw owns the same shoulder; it moves light.
        options.bindle && !hasRetroGeometry && !isFlatpack ? BINDLE : nothing
      }
      ${
        // The foil hat is palette identity; Mulder declines the navy-issued
        // sailor cap rather than stacking two hats on crab days.
        options.sailorCap &&
        !options.shell &&
        !isFlatpack &&
        !HEADWEAR.has(look.accessory) &&
        look.palette.id !== "tinfoil"
          ? SAILOR_CAP
          : nothing
      }
      ${options.reading ? READING_BOOK : nothing}
      </g>
    </svg>
  `;
}

export const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;

// Shared inline vars for every surface that renders a look (ledge sprite,
// twin, stranger passer). The seeded glint rides
// --crab-glint-seed instead of --crab-glint so the class-driven palette and
// offline overrides in crab-pet.css still out-cascade it.
function crabLookStyleVars(look: CrabPetLook): string[] {
  const crusher = look.crusherSide;
  const paletteHash = fnv1aUtf16(look.palette.id);
  const breatheDelayS = ((paletteHash >>> 8) % 34) / 10;
  const bodyDonorClaw = look.chimeraParts ? chimeraBodyClaw(look.chimeraParts.body) : undefined;
  const clawMul = (side: "left" | "right") =>
    crusher === null
      ? CRAB_PET_CLAW_MULS[look.clawSize]
      : crusher === side
        ? CRAB_PET_CLAW_MULS.mighty
        : CRAB_PET_CLAW_MULS.dainty;
  return [
    `--crab-shell:${look.chimeraParts?.body ?? look.palette.shell}`,
    `--crab-claw:${bodyDonorClaw ?? look.palette.claw}`,
    `--crab-blink-delay:${look.blinkDelayS}s`,
    `--crab-breathe-delay:-${breatheDelayS}s`,
    `--crab-w:${CRAB_PET_BUILD_MULS[look.build].w}`,
    `--crab-h:${CRAB_PET_BUILD_MULS[look.build].h}`,
    `--crab-claw-l:${clawMul("left")}`,
    `--crab-claw-r:${clawMul("right")}`,
    ...(look.chimeraParts
      ? [
          `--crab-chimera-l:${look.chimeraParts.clawLeft}`,
          `--crab-chimera-r:${look.chimeraParts.clawRight}`,
          `--crab-antennae-color:${look.chimeraParts.antennae}`,
        ]
      : []),
    ...(look.glint ? [`--crab-glint-seed:${look.glint}`] : []),
  ];
}

export function crabLookStyle(look: CrabPetLook): string {
  return crabLookStyleVars(look).join(";");
}

function crabPetSpriteStyle(look: CrabPetLook, scale: number, spotPct: number, facing: 1 | -1) {
  return [
    ...crabLookStyleVars(look),
    `--crab-scale:${scale}`,
    `--crab-x:${spotPct}%`,
    `--crab-face:${facing}`,
  ].join(";");
}

export function renderCrabPetScene(args: {
  look: CrabPetLook;
  mode: CrabPetMode;
  presence: "out" | "in" | "leaving";
  shellVisible: boolean;
  visitsEnabled: boolean;
  dismissed: boolean;
  passer: { kind: CrabPasserKind; direction: 1 | -1; crossMs: number } | null;
  twinPlanned: boolean;
  anniversary: boolean;
  entering: boolean;
  entrance: CrabPetEntrance;
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
    // On the month/day anniversary of this palette's first Crabdex visit,
    // the party hat overrides whatever accessory the seed rolled.
    const dressed =
      args.anniversary && args.look.accessory !== "party"
        ? { ...args.look, accessory: "party" as const }
        : args.look;
    const classes = [
      "crab-pet",
      `crab-pet--${args.mode}`,
      `crab-pet--palette-${args.look.palette.id}`,
      twin ? "crab-pet--twin" : "",
      dressed.accessory === "party" ? "crab-pet--party" : "",
      args.look.shiny ? "crab-pet--shiny" : "",
      args.elder ? "crab-pet--elder" : "",
      args.presence === "leaving" ? "crab-pet--away" : "",
      args.entering ? "crab-pet--entering" : "",
      args.entering && args.entrance !== "walk" ? `crab-pet--enter-${args.entrance}` : "",
      args.grumpy ? "crab-pet--grumpy" : "",
      args.vigil ? "crab-pet--vigil" : "",
      args.act ? `crab-pet--act-${args.act}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    // The twin tags along on the parent's trailing side and copies every act
    // a beat later (--crab-act-delay feeds each act's animation-delay).
    const spotPct = twin
      ? Math.min(
          args.zone[1],
          Math.max(args.zone[0], args.spotPct + (args.facing === 1 ? -12 : 12)),
        )
      : args.spotPct;
    const scale = anchoredScale(twin ? args.look.scale * 0.55 : args.look.scale);
    const style = twin
      ? `${crabPetSpriteStyle(args.look, scale, spotPct, args.facing === 1 ? -1 : 1)};--crab-act-delay:0.18s`
      : crabPetSpriteStyle(args.look, scale, spotPct, args.facing);
    // Milestone honorifics come from the load-start familiarity snapshot, so
    // a title never pops mid-visit; it is simply there next time.
    const honorific = crabHonorific(args.familiarityVisits);
    const baseName = args.nameOverride ?? crabPetName(args.look, args.seed);
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
        <div class="crab-pet__body">
          ${renderCrabSvg(dressed, {
            grumpy: args.grumpy,
            bindle,
            sailorCap: args.sailorDay,
          })}
          ${args.entering && args.entrance === "balloon" ? BALLOON : nothing}
          ${args.entering && args.entrance === "bubble"
            ? html`<span class="crab-pet__entry-bubble"></span>`
            : nothing}
          ${args.look.shiny
            ? html`
                <span class="crab-pet__sparkle" style="--i:0;left:12%;bottom:64%">✦</span>
                <span class="crab-pet__sparkle" style="--i:1;left:76%;bottom:82%">✦</span>
              `
            : nothing}
          <span class="crab-pet__z" style="--i:0">z</span>
          <span class="crab-pet__z" style="--i:1">z</span>
          <span class="crab-pet__z" style="--i:2">Z</span>
          <span class="crab-pet__bubble" style="--i:0"></span>
          <span class="crab-pet__bubble" style="--i:1"></span>
          <span class="crab-pet__bubble" style="--i:2"></span>
          <span class="crab-pet__heart">♥</span>
          <svg class="crab-pet__broom" viewBox="0 0 24 40" aria-hidden="true">
            <path d="M12 2 L12 24" stroke="#5a6b52" stroke-width="3" stroke-linecap="round" />
            <path d="M6 24 L18 24 L21 38 L3 38 Z" fill="#e8b04b" />
            <path
              d="M7.5 28 L6.5 36 M12 28 L12 36 M16.5 28 L17.5 36"
              stroke="#4fb072"
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
  const shellStyle = crabPetSpriteStyle(
    args.look,
    anchoredScale(args.shellScale),
    args.shellSpotPct,
    args.facing,
  );
  // A pass-through visitor: crosses the ledge once and is gone. Strangers
  // are other crabs (never your palette); everyone else is at most
  // crab-adjacent. None perch, none count for the Crabdex.
  const passerLook =
    args.passer?.kind === "stranger" ? strangerLookFor(args.seed, args.look.palette.id) : args.look;
  const passerClasses = args.passer
    ? [
        "crab-pet",
        "crab-pet--passer",
        args.passer.kind === "stranger"
          ? `crab-pet--palette-${passerLook.palette.id}`
          : `crab-pet--${args.passer.kind}`,
        args.passer.kind === "stranger" && passerLook.shiny ? "crab-pet--shiny" : "",
        args.passer.direction === 1 ? "crab-pet--passer-ltr" : "crab-pet--passer-rtl",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const passerStyle = args.passer
    ? `${passerBaseStyle(args.passer.kind, args.passer.direction, passerLook)};--crab-cross:${args.passer.crossMs}ms`
    : "";
  return html`
    ${showShell
      ? html`
          <div class="crab-pet crab-pet--shell" style=${shellStyle} aria-hidden="true">
            <div class="crab-pet__body">${renderCrabSvg(args.look, { shell: true })}</div>
          </div>
        `
      : nothing}
    ${showBottle && args.bottle
      ? html`
          <div
            class="crab-bottle ${args.bottle.opened ? "crab-bottle--open" : ""}"
            style="--crab-x:${args.bottle.spotPct}%"
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
            <div class="crab-pet__body">
              ${args.passer.kind === "stranger"
                ? renderCrabSvg(passerLook, { standalone: true })
                : PASSER_SPRITES[args.passer.kind]()}
            </div>
          </div>
        `
      : nothing}
  `;
}

// Non-crab passers ignore the perch variables and carry fixed sprite
// proportions; strangers reuse the full look pipeline (capped size so a
// visiting grail does not upstage the resident).
function passerBaseStyle(kind: CrabPasserKind, direction: 1 | -1, passerLook: CrabPetLook): string {
  if (kind === "stranger") {
    return crabPetSpriteStyle(passerLook, Math.min(passerLook.scale, 2), 0, direction);
  }
  const fixed: Record<Exclude<CrabPasserKind, "stranger">, string> = {
    crab: "--crab-scale:2;--crab-w:1;--crab-h:0.82;--crab-face:1",
    snail: `--crab-scale:1.7;--crab-w:1;--crab-h:0.9;--crab-face:${direction}`,
    duck: `--crab-scale:1.9;--crab-w:1;--crab-h:1;--crab-face:${direction}`,
    jellyfish: "--crab-scale:1.7;--crab-w:0.9;--crab-h:1.1;--crab-face:1",
  };
  return fixed[kind];
}
