import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, svg } from "lit";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
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
import { lobsterPaletteName, lobsterRandomName } from "./lobster-pet-lore.ts";
import { moonPhaseFraction } from "./lobster-pet-moon.ts";
import {
  CANONICAL_CHIMERA_PARTS,
  LOBSTER_PALETTE_WEIGHTS,
  chimeraBodyClaw,
  rollChimeraParts,
} from "./lobster-pet-palettes.ts";
import {
  ACTUAL_LOBSTER,
  ASCII_LOBSTER,
  BALLOON_LOBSTER,
  FLATPACK_LOBSTER,
  LOADING_LOBSTER,
  PORTAL_LOBSTER,
  TINFOIL_PARTS,
} from "./lobster-pet-sprites-wild.ts";
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
  PIXEL_LOBSTER,
  RETRO_ANTENNAE,
  RETRO_FACE,
  RETRO_MEGA_CLAW,
  renderBottleSvg,
  SAILOR_CAP,
  SELENE_MOON,
  SPLIT_HALF,
  TAIL_FAN,
} from "./lobster-pet-sprites.ts";

export { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

const RETRO_GEOMETRY_PALETTES: ReadonlySet<LobsterPetPaletteId> = new Set(["retro", "goldenretro"]);

const PALETTE_FRAME_CLASSES: Partial<Record<LobsterPetPaletteId, string>> = {
  heisenbug: "lob-heisenbug-frame",
  cryptid: "lob-cryptid-frame",
  balloon: "lob-balloon-frame",
};

// A neutral look used to render catalog minis outside the pet lifecycle.
export function canonicalLobsterLook(palette: LobsterPetPalette): LobsterPetLook {
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
  squat: { w: 1.14, h: 0.94 },
  slender: { w: 0.88, h: 1.1 },
};

const LOBSTER_PET_CLAW_MULS: Record<LobsterPetClawSize, number> = {
  dainty: 0.85,
  regular: 1,
  mighty: 1.18,
};

export function lobsterPetName(look: LobsterPetLook, seed: number): string {
  const signatureName = lobsterPaletteName(look.palette.id);
  return signatureName !== look.palette.id ? signatureName : lobsterRandomName(seed);
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
  const palette = pickWeighted(rng, LOBSTER_PALETTE_WEIGHTS);
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
  // Append-only trait discipline: always burn all four distinct donor rolls,
  // then expose them only for Chimera so older seeded traits never shift.
  const rolledChimeraParts = rollChimeraParts(rng);
  const chimeraParts = palette.id === "chimera" ? rolledChimeraParts : null;
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
  if (isLobsterAnniversary(now)) {
    // Birthday dress code: everyone is the classic logo, party hats on.
    const retro = LOBSTER_PALETTE_WEIGHTS.find(([entry]) => entry.id === "retro")?.[0];
    return {
      ...preparedLook,
      palette: retro ?? palette,
      accessory: "party",
      chimeraParts: null,
    };
  }
  return preparedLook;
}

// Same species as icons.lobster / the dreams-scene sleeper: smooth dome body
// with stubby legs, side claws, antennae, and teal-glint eyes.
const READING_BOOK = svg`
  <g class="lob-reading-book" transform="translate(0 2)">
    <path
      d="M25 62 Q43 56 59 66 L59 92 Q43 82 25 86 Z M61 66 Q77 56 95 62 L95 86 Q77 82 61 92 Z"
      fill="var(--lob-claw)"
      stroke="color-mix(in srgb, var(--lob-claw) 72%, #0a1014)"
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
      class="lob-reading-book__page-glow"
      d="M31 62 Q45 59 57 68 L57 72 Q44 65 31 67 Z"
      fill="#ffffff"
      opacity="0"
    />
  </g>
`;

export function renderLobsterSvg(
  look: LobsterPetLook,
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
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g class=${PALETTE_FRAME_CLASSES[look.palette.id] ?? ""}>
        ${
          isFlatpack
            ? FLATPACK_LOBSTER(openEyeStyle, closedEyeStyle)
            : isLoading
              ? LOADING_LOBSTER(openEyeStyle, closedEyeStyle)
              : isActual
                ? ACTUAL_LOBSTER(openEyeStyle, closedEyeStyle)
                : isBalloon
                  ? BALLOON_LOBSTER(openEyeStyle, closedEyeStyle)
                  : isAscii
                    ? ASCII_LOBSTER(openEyeStyle, closedEyeStyle)
                    : isPortal
                      ? PORTAL_LOBSTER(openEyeStyle, closedEyeStyle)
                      : isPixel
                        ? PIXEL_LOBSTER(openEyeStyle, closedEyeStyle)
                        : svg`
              ${hasRetroGeometry ? RETRO_ANTENNAE : ANTENNAE_SPRITES[look.antennae]}
              ${look.tailFan ? TAIL_FAN : nothing}
              <g class="lob-claw lob-claw--l">
                <path d="M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z" fill="var(--lob-claw)" />
              </g>
              ${
                hasRetroGeometry
                  ? nothing
                  : svg`<g class="lob-claw lob-claw--r"><path d="M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z" fill="var(--lob-claw)" /></g>`
              }
              ${look.palette.id === "heisenbug" ? GLITCH_GHOSTS : nothing}
              <path class="lob-standard-dome" d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" fill="var(--lob-shell)" />
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
              <g class="lob-eye-open" style=${openEyeStyle}>
                <circle cx="45" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="75" cy="32" r="5.5" fill="#0a1014" />
                <circle cx="46.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
                <circle cx="76.5" cy="30.5" r="2.2" fill="var(--lob-glint, #00e5cc)" />
              </g>
              ${
                options.sleeping && !options.reading
                  ? svg`<g class="lob-eye-peek"><circle cx="45" cy="32" r="4" fill="#0a1014" /><circle cx="46" cy="30.8" r="1.6" fill="var(--lob-glint, #00e5cc)" /></g>`
                  : nothing
              }
              <g class="lob-eye-closed" stroke="#0a1014" stroke-width="3" stroke-linecap="round" fill="none" style=${closedEyeStyle}>
                <path d="M39 33 Q45 28 51 33" /><path d="M69 33 Q75 28 81 33" />
              </g>
            `
        }
      ${
        hasRetroGeometry
          ? svg`
            ${RETRO_FACE}
            <g class="lob-claw lob-claw--r">${RETRO_MEGA_CLAW}</g>
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
        // sailor cap rather than stacking two hats on lobster days.
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
// --lob-glint-seed instead of --lob-glint so the class-driven palette and
// offline overrides in lobster-pet.css still out-cascade it.
function lobsterLookStyleVars(look: LobsterPetLook): string[] {
  const crusher = look.crusherSide;
  const paletteHash = fnv1aUtf16(look.palette.id);
  const breatheDelayS = ((paletteHash >>> 8) % 34) / 10;
  const bodyDonorClaw = look.chimeraParts ? chimeraBodyClaw(look.chimeraParts.body) : undefined;
  const clawMul = (side: "left" | "right") =>
    crusher === null
      ? LOBSTER_PET_CLAW_MULS[look.clawSize]
      : crusher === side
        ? LOBSTER_PET_CLAW_MULS.mighty
        : LOBSTER_PET_CLAW_MULS.dainty;
  return [
    `--lob-shell:${look.chimeraParts?.body ?? look.palette.shell}`,
    `--lob-claw:${bodyDonorClaw ?? look.palette.claw}`,
    `--lob-blink-delay:${look.blinkDelayS}s`,
    `--lob-breathe-delay:-${breatheDelayS}s`,
    `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
    `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
    `--lob-claw-l:${clawMul("left")}`,
    `--lob-claw-r:${clawMul("right")}`,
    ...(look.chimeraParts
      ? [
          `--lob-chimera-l:${look.chimeraParts.clawLeft}`,
          `--lob-chimera-r:${look.chimeraParts.clawRight}`,
          `--lob-antennae-color:${look.chimeraParts.antennae}`,
        ]
      : []),
    ...(look.glint ? [`--lob-glint-seed:${look.glint}`] : []),
  ];
}

export function lobsterLookStyle(look: LobsterPetLook): string {
  return lobsterLookStyleVars(look).join(";");
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
