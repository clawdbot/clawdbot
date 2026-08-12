// The crab pet's art locker: every static SVG sprite the look renderer
// and scene composer draw from - accessories, rare-palette geometry, retro
// homage parts, ledge visitors, and the bottle. Pure presentation; all
// selection logic stays in crab-pet-look.ts.
import { svg, type TemplateResult } from "lit";
import type {
  CrabPasserKind,
  CrabPetAccessory,
  CrabPetAntennae,
  CrabPetPaletteId,
} from "./crab-pet-contract.ts";
import {
  CHIMERA_STITCHES,
  ECLIPSE_CORONA,
  NOTEXTURE_CHECKER,
  WATERMELON_RIND,
} from "./crab-pet-sprites-wild.ts";

export const ACCESSORY_SPRITES: Record<Exclude<CrabPetAccessory, "none">, TemplateResult> = {
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
      <path d="M47 10 Q54 1 68 3 L72 9 Z" fill="#2FBF71" />
      <circle cx="71" cy="3.5" r="3.5" fill="#f5f7fa" />
      <ellipse cx="59" cy="10.5" rx="15" ry="3.5" fill="#f5f7fa" />
    </g>
  `,
  pumpkin: svg`
    <g>
      <ellipse cx="60" cy="6.5" rx="8.5" ry="5.5" fill="#57C785" />
      <path d="M56 2.5 Q56 6.5 56 10.5 M64 2.5 Q64 6.5 64 10.5" stroke="#1F9D57" stroke-width="1.5" fill="none" />
      <path d="M60 1.5 Q60.5 0 63 0.5" stroke="#4c9a4c" stroke-width="2.5" stroke-linecap="round" fill="none" />
    </g>
  `,
  party: svg`
    <g>
      <path d="M52 11 L60 0.5 L68 11 Z" fill="#7c5cff" />
      <path d="M55.5 6.5 L64.5 6.5" stroke="#3fff7d" stroke-width="2" />
      <circle cx="60" cy="1" r="2.4" fill="#3ec9a0" />
    </g>
  `,
  // Elder wear: a patient little colony riding the shell's shoulder.
  barnacle: svg`
    <g class="crab-barnacles">
      <path d="M32 22 L36.5 13 L41 22 Z" fill="#cfd8de" />
      <path d="M42 18 L45.5 11 L49 18 Z" fill="#b8c4cc" />
      <path d="M27 26 L30 20.5 L33 26 Z" fill="#b8c4cc" />
      <circle cx="36.5" cy="18.5" r="1.1" fill="#8a949d" />
      <circle cx="45.5" cy="15" r="0.9" fill="#8a949d" />
    </g>
  `,
  // National Crab Day formal wear: gold rim, chain, no further questions.
  monocle: svg`
    <g class="crab-monocle" fill="none" stroke="#2FBF71">
      <circle cx="75" cy="32" r="8.5" stroke-width="2.5" />
      <path d="M81 39 Q85 48 80 56" stroke-width="1.5" />
    </g>
  `,
};

// Light speckle trait; skipped on palettes whose identity is already
// pattern-driven (see renderCrabSvg).
export const FRECKLE_SPOTS = svg`
  <g class="crab-freckles" fill="#ffffff" opacity="0.3">
    <circle cx="42" cy="45" r="1.6" />
    <circle cx="50" cy="41" r="1.2" />
    <circle cx="70" cy="45" r="1.6" />
    <circle cx="78" cy="41" r="1.2" />
    <circle cx="55" cy="62" r="1.4" />
    <circle cx="67" cy="66" r="1.2" />
  </g>
`;

// Lumen photophores: dotted running lights along the shell. The glow (and
// its dark-theme-only intensity) lives in crab-pet.css.
const LUMEN_SPOTS = svg`
  <g class="crab-lumen" fill="#7ef5dd">
    <circle cx="36" cy="54" r="2.4" />
    <circle cx="50" cy="66" r="2" />
    <circle cx="66" cy="70" r="2.2" />
    <circle cx="80" cy="60" r="2" />
    <circle cx="88" cy="46" r="1.7" />
    <circle cx="60" cy="86" r="1.7" />
  </g>
`;

const MAGMA_SEAMS = svg`
  <g class="crab-magma" fill="none" stroke="#2FBF71" stroke-width="2" stroke-linecap="round">
    <path d="M40 44 L48 54 L42 66 L50 78" />
    <path d="M74 40 L68 52 L78 64" />
    <path d="M56 82 L62 90" />
  </g>
`;

const OILSLICK_SHEEN = svg`
  <g class="crab-oilsheen">
    <ellipse cx="46" cy="60" rx="22" ry="11" fill="#7f77dd" opacity="0.3" transform="rotate(-14 46 60)" />
    <ellipse cx="76" cy="74" rx="17" ry="8" fill="#1d9e75" opacity="0.28" transform="rotate(10 76 74)" />
  </g>
`;

const AURORA_BANDS = svg`
  <g class="crab-aurora" fill="none" stroke-linecap="round">
    <path class="crab-aurora__band1" d="M24 62 Q48 48 70 58 T102 54" stroke="#4ecfa6" stroke-width="6" opacity="0.5" />
    <path class="crab-aurora__band2" d="M28 76 Q54 62 78 72 T100 68" stroke="#a184ec" stroke-width="5" opacity="0.45" />
  </g>
`;

const NEBULA_STARS = svg`
  <g class="crab-nebula-stars">
    <circle cx="38" cy="52" r="1" fill="#fff" />
    <circle cx="52" cy="70" r="1.2" fill="#fff" />
    <circle cx="84" cy="48" r="1.4" fill="#fff" />
    <circle cx="66" cy="86" r="1" fill="#fff" />
    <circle cx="72" cy="60" r="1.6" fill="#8be9fd" />
    <circle cx="46" cy="40" r="1.4" fill="#7ef5dd" />
    <path class="crab-twinkle" d="M60 52 L61.5 55.5 L65 57 L61.5 58.5 L60 62 L58.5 58.5 L55 57 L58.5 55.5 Z" fill="#fff" />
  </g>
`;

const GLASS_GLINTS = svg`
  <g class="crab-glass-glints" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" opacity="0.7">
    <path d="M34 22 L28 32" />
    <path d="M40 16 L37 22" />
  </g>
`;

const GEODE_FACETS = svg`
  <g class="crab-geode-facets">
    <polygon points="70,34 80,30 78,44" fill="#9b6ff0" />
    <polygon points="82,46 94,42 88,58" fill="#b48ef0" />
    <polygon points="72,58 84,62 74,74" fill="#7a4fd0" />
    <polygon points="86,68 96,64 90,80" fill="#9b6ff0" />
    <circle class="crab-twinkle" cx="90" cy="50" r="1.8" fill="#fff" />
  </g>
`;

const PHOSPHOR_SCANLINES = svg`
  <g class="crab-scanlines" stroke="#3fff7d" stroke-width="1" opacity="0.16">
    <path d="M40 20 H80 M30 27 H90 M26 34 H94 M21 41 H99 M18 48 H102 M17 55 H103 M17 62 H103 M18 69 H102 M22 76 H98 M31 83 H89 M45 90 H75" />
  </g>
`;

export const GLITCH_GHOSTS = svg`
  <g class="crab-glitch-ghosts">
    <path d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" transform="translate(-3 0)" fill="#00e5cc" opacity="0.4" />
    <path d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" transform="translate(3 1)" fill="#22d3ee" opacity="0.4" />
  </g>
`;

const BLUEPRINT_MARKS = svg`
  <g class="crab-blueprint" fill="none" stroke="#cfe3ff">
    <path class="crab-bp-outline" d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z" stroke-width="1.5" stroke-dasharray="5 3" />
    <path d="M54 58 H66 M60 52 V64" stroke-width="1" opacity="0.7" />
    <path d="M16 100 H104" stroke-width="1" stroke-dasharray="2 3" opacity="0.7" />
  </g>
`;

const MECHA_PLATES = svg`
  <g class="crab-mecha">
    <g fill="none" stroke="#5f6a75" stroke-width="1.5">
      <path d="M28 56 Q60 66 92 56" />
      <path d="M34 74 Q60 82 86 74" />
    </g>
    <g fill="#5f6a75">
      <circle cx="36" cy="61" r="1.4" />
      <circle cx="60" cy="64" r="1.4" />
      <circle cx="84" cy="61" r="1.4" />
    </g>
    <circle class="crab-led" cx="89" cy="7" r="3" fill="#4ade80" />
  </g>
`;

export function SELENE_MOON(phaseIndex: number): TemplateResult {
  const phase = ((Math.round(phaseIndex) % 8) + 8) % 8;
  if (phase === 0) {
    return svg`<g class="crab-selene-moon"><circle cx="60" cy="64" r="12" fill="#26304a" /><circle cx="60" cy="64" r="11" fill="none" stroke="#f4f7fc" stroke-width="1" /></g>`;
  }
  if (phase === 4) {
    return svg`<g class="crab-selene-moon"><circle cx="60" cy="64" r="12" fill="#26304a" /><circle cx="60" cy="64" r="11" fill="#f4f7fc" /></g>`;
  }
  const darkOffset = phase < 4 ? [-5, -9, -14][phase - 1] : [14, 9, 5][phase - 5];
  return svg`
    <g class="crab-selene-moon">
      <circle cx="60" cy="64" r="12" fill="#26304a" />
      <circle cx="60" cy="64" r="11" fill="#f4f7fc" />
      <circle cx=${60 + (darkOffset ?? 0)} cy="64" r="11" fill="#26304a" />
    </g>
  `;
}

export function PIXEL_CRAB(openEyeStyle: string, closedEyeStyle: string): TemplateResult {
  return svg`
    <g class="crab-pixel-frame" shape-rendering="crispEdges">
      <g class="crab-pixel-antennae" fill="#2fbf71">
        <rect x="42" y="0" width="6" height="12" />
        <rect x="72" y="0" width="6" height="12" />
      </g>
      <g class="crab-pixel-claws">
        <path d="M18 42 H6 V48 H0 V60 H6 V66 H18 V60 H24 V48 H18 Z M6 48 H12 V60 H6 Z" fill="#2fbf71" />
        <rect x="6" y="60" width="12" height="6" fill="#1f9d57" />
        <path d="M102 42 H114 V48 H120 V60 H114 V66 H102 V60 H96 V48 H102 Z M108 48 H114 V60 H108 Z" fill="#2fbf71" />
        <rect x="102" y="60" width="12" height="6" fill="#1f9d57" />
      </g>
      <!-- Main cells keep the palette variable so offline and mood-style tinting still read. -->
      <g class="crab-pixel-body" fill="var(--crab-shell, #2fbf71)">
        <rect x="42" y="12" width="36" height="6" /><rect x="36" y="18" width="48" height="6" />
        <rect x="30" y="24" width="60" height="6" /><rect x="24" y="30" width="72" height="48" />
        <rect x="30" y="78" width="60" height="12" /><rect x="36" y="90" width="48" height="6" />
        <rect x="36" y="96" width="12" height="9" /><rect x="72" y="96" width="12" height="9" />
      </g>
      <g fill="#8ee3af"><rect x="36" y="24" width="24" height="6" /><rect x="30" y="30" width="18" height="12" /><rect x="24" y="42" width="12" height="12" /></g>
      <g fill="#1f9d57"><rect x="30" y="78" width="60" height="12" /><rect x="36" y="90" width="48" height="6" /><rect x="36" y="96" width="12" height="9" /><rect x="72" y="96" width="12" height="9" /></g>
      <g class="crab-eye-open" style=${openEyeStyle}>
        <rect x="42" y="30" width="6" height="6" fill="#0a1014" /><rect x="72" y="30" width="6" height="6" fill="#0a1014" />
        <rect x="42" y="30" width="2.5" height="2.5" fill="#fff" /><rect x="72" y="30" width="2.5" height="2.5" fill="#fff" />
      </g>
      <g class="crab-eye-closed" style=${closedEyeStyle} fill="#0a1014"><rect x="42" y="33" width="6" height="3" /><rect x="72" y="33" width="6" height="3" /></g>
    </g>
  `;
}

// Palettes whose identity is already pattern-driven skip the freckle trait;
// stacking speckle sets reads as noise, not a variant.
export const PATTERNED_PALETTES: ReadonlySet<CrabPetPaletteId> = new Set([
  "split",
  "retro",
  "lumen",
  "magma",
  "oilslick",
  "aurora",
  "nebula",
  "glass",
  "geode",
  "phosphor",
  "heisenbug",
  "blueprint",
  "clawtron",
  "selene",
  "pixel",
  "banana",
  "bee",
  "rubberduck",
  "watermelon",
  "sourdough",
  "zombie",
  "plush",
  "balloon",
  "disco",
  "cryptid",
  "flatpack",
  "tinfoil",
  "actual",
  "chimera",
  "notexture",
  "loading",
  "eclipse",
  "ascii",
  "portal",
  "invisible",
  "goldenretro",
]);

const BANANA_MARKS = svg`
  <g fill="#8a6430">
    <rect x="56" y="8" width="8" height="6" rx="2.5" />
    <ellipse cx="60" cy="91" rx="6" ry="3.5" />
    <circle cx="37" cy="48" r="2.5" />
    <circle cx="79" cy="55" r="2" />
    <circle cx="47" cy="70" r="1.8" />
    <circle cx="72" cy="79" r="2.3" />
  </g>
`;

const BEE_PARTS = svg`
  <g class="crab-bee-wings" fill="#ffffff" opacity="0.45">
    <ellipse cx="38" cy="14" rx="8" ry="4.5" transform="rotate(-24 38 14)" />
    <ellipse cx="82" cy="14" rx="8" ry="4.5" transform="rotate(24 82 14)" />
  </g>
  <g fill="#2b2b23" opacity="0.9">
    <path d="M19 42 Q60 51 101 42 L103 50 Q60 60 17 50 Z" />
    <path d="M17 58 Q60 67 103 58 L101 67 Q60 76 19 67 Z" />
    <path d="M24 76 Q60 84 96 76 L90 85 Q60 92 30 85 Z" />
  </g>
`;

const DUCK_BILL = svg`
  <g>
    <ellipse cx="60" cy="71" rx="21" ry="14" fill="#ffffff" opacity="0.5" />
    <rect x="47" y="41" width="26" height="8" rx="4" fill="#2FBF71" />
    <rect x="50" y="47" width="20" height="5" rx="2.5" fill="#2FBF71" />
  </g>
`;

const SOURDOUGH_SCORING = svg`
  <g fill="none" stroke="#a8763e" stroke-width="2.5" stroke-linecap="round">
    <path d="M38 23 Q45 29 52 30" />
    <path d="M52 17 Q59 24 66 25" />
    <path d="M67 18 Q74 24 81 25" />
  </g>
  <g fill="#ffffff" opacity="0.5">
    <circle cx="34" cy="39" r="1.2" /><circle cx="86" cy="38" r="1" />
    <circle cx="45" cy="57" r="1.4" /><circle cx="74" cy="62" r="1.1" />
    <circle cx="56" cy="78" r="1" /><circle cx="83" cy="75" r="1.3" />
  </g>
`;

const ZOMBIE_STITCHES = svg`
  <g fill="none" stroke="#5a6b52" stroke-width="2" stroke-linecap="round">
    <path d="M32 24 Q47 19 61 23" />
    <path d="M38 19 L40 26 M46 18 L47 25 M54 19 L53 26" />
    <path d="M57 72 Q72 78 87 72" />
    <path d="M65 72 L63 79 M73 73 L72 80 M81 71 L83 78" />
  </g>
  <ellipse cx="35" cy="61" rx="9" ry="6" fill="#86987a" opacity="0.8" transform="rotate(-18 35 61)" />
`;

const PLUSH_SEAMS = svg`
  <g fill="none" stroke="#7fc8b8" stroke-width="1.5" stroke-dasharray="3 3">
    <path d="M30 32 Q60 4 90 32" />
    <path d="M60 50 Q58 72 60 96" />
  </g>
  <g class="crab-plush-button">
    <circle cx="78" cy="44" r="3.5" fill="#2e7d46" />
    <circle cx="76.8" cy="44" r="0.7" fill="#7fc8b8" />
    <circle cx="79.2" cy="44" r="0.7" fill="#7fc8b8" />
  </g>
`;

const DISCO_FACETS = svg`
  <g class="crab-disco" fill="#ffffff">
    <rect x="42" y="18" width="4" height="4" opacity="0.3" /><rect x="52" y="16" width="4" height="4" opacity="0.5" />
    <rect x="63" y="17" width="4" height="4" opacity="0.25" /><rect x="74" y="20" width="4" height="4" opacity="0.4" />
    <rect x="31" y="40" width="4" height="4" opacity="0.4" /><rect x="53" y="39" width="4" height="4" opacity="0.25" />
    <rect x="65" y="42" width="4" height="4" opacity="0.5" /><rect x="86" y="40" width="4" height="4" opacity="0.3" />
    <rect x="39" y="59" width="4" height="4" opacity="0.25" /><rect x="51" y="62" width="4" height="4" opacity="0.45" />
    <rect x="68" y="60" width="4" height="4" opacity="0.3" /><rect x="80" y="58" width="4" height="4" opacity="0.5" />
    <rect x="49" y="79" width="4" height="4" opacity="0.35" /><rect x="70" y="80" width="4" height="4" opacity="0.25" />
  </g>
`;

export const PALETTE_OVERLAYS: Partial<Record<CrabPetPaletteId, TemplateResult>> = {
  lumen: LUMEN_SPOTS,
  magma: MAGMA_SEAMS,
  oilslick: OILSLICK_SHEEN,
  aurora: AURORA_BANDS,
  nebula: NEBULA_STARS,
  glass: GLASS_GLINTS,
  geode: GEODE_FACETS,
  phosphor: PHOSPHOR_SCANLINES,
  blueprint: BLUEPRINT_MARKS,
  clawtron: MECHA_PLATES,
  banana: BANANA_MARKS,
  bee: BEE_PARTS,
  rubberduck: DUCK_BILL,
  sourdough: SOURDOUGH_SCORING,
  zombie: ZOMBIE_STITCHES,
  plush: PLUSH_SEAMS,
  disco: DISCO_FACETS,
  watermelon: WATERMELON_RIND,
  eclipse: ECLIPSE_CORONA,
  notexture: NOTEXTURE_CHECKER,
  chimera: CHIMERA_STITCHES,
};

// Split two-tone: the right half of the body (down to the belly midline)
// repainted in the second shell color; the right claw and antenna follow via
// CSS. Mirrors the famous bilateral half-and-half crabs.
export const SPLIT_HALF = svg`
  <path
    class="crab-split-half"
    d="M60 8 C88 8 104 32 104 52 C104 72 90 90 76 95 L76 104 L66 104 L66 96 C64 96.8 62 97.1 60 97.1 L60 8 Z"
    fill="var(--crab-shell2, #46536b)"
  />
`;

// Retro homage parts (classic OpenClaw logo): one oversized raised claw with
// a pincer notch, tall V antennae, angry brows, and a smirk. The mega claw
// lives inside the .crab-claw--r group so wave/snip acts swing it.
export const RETRO_MEGA_CLAW = svg`
  <path
    d="M95 55 C112 53 119 39 116 25 C113 11 99 5 91 12 C88 15 87 19 88 23 C83 27 83 36 88 43 C91 49 93 52 95 55 Z"
    fill="var(--crab-claw)"
  />
  <path
    d="M92 14 C97 22 99 31 95 41"
    class="crab-retro-claw-line"
    stroke="#1f9d57"
    stroke-width="3"
    stroke-linecap="round"
    fill="none"
  />
`;

export const RETRO_ANTENNAE = svg`
  <g class="crab-antennae" stroke="var(--crab-shell)" stroke-width="4" stroke-linecap="round" fill="none">
    <path d="M50 16 L48 8" />
    <path d="M70 16 L72 8" />
  </g>
`;

export const RETRO_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M49 45 Q59 51 69 45 L72 42" stroke-width="3" />
  </g>
`;

// Tail-fan lobes peek out diagonally behind the lower body (drawn before the
// body path so they read as "behind"). Fill color lives in crab-pet.css.
export const TAIL_FAN = svg`
  <g class="crab-tail">
    <ellipse cx="60" cy="94" rx="8" ry="4.5" />
  </g>
`;

// Moving-day bindle: a stick over the shoulder with a polka-dot bundle,
// carried for the whole first load after a gateway upgrade.
export const BINDLE = svg`
  <g class="crab-bindle">
    <path d="M70 62 L99 30" stroke="#5a6b52" stroke-width="3.5" stroke-linecap="round" />
    <circle cx="101" cy="27" r="9.5" fill="#e8b04b" />
    <circle cx="98" cy="24" r="1.6" fill="#4fb072" />
    <circle cx="104" cy="29" r="1.6" fill="#4fb072" />
    <circle cx="100" cy="32" r="1.3" fill="#4fb072" />
  </g>
`;

// On crab days (see src/shared/crab-day.ts, shared with the CLI
// banner cousin) the pet wears a little sailor cap - unless the seed already
// rolled headwear, which keeps its place.
export const HEADWEAR: ReadonlySet<CrabPetAccessory> = new Set([
  "crown",
  "sprout",
  "santa",
  "pumpkin",
  "party",
]);

export const SAILOR_CAP = svg`
  <g class="crab-cap">
    <path d="M46 10 Q60 -3 74 10 L74 13 Q60 7 46 13 Z" fill="#f5f7fa" />
    <path d="M45 12 Q60 6 75 12 L75 16 Q60 10.5 45 16 Z" fill="#dfe7ee" />
    <circle cx="60" cy="2.5" r="1.8" fill="#3b6ea5" />
  </g>
`;

// Shown while grumpy (poked too much): angry brows and a frown.
export const GRUMPY_FACE = svg`
  <g stroke="#0a1014" stroke-linecap="round" fill="none">
    <path d="M37 24 L51 28" stroke-width="3.5" />
    <path d="M69 28 L83 24" stroke-width="3.5" />
    <path d="M50 48 Q60 42 70 48" stroke-width="3" />
  </g>
`;

export const ANTENNAE_SPRITES: Record<CrabPetAntennae, TemplateResult> = {
  perky: svg`
    <g class="crab-antennae" stroke="var(--crab-shell)" stroke-width="4" stroke-linecap="round" fill="none">
      <path d="M46 14 L46 7" />
      <path d="M74 14 L74 7" />
    </g>
  `,
  droopy: svg`
    <g class="crab-antennae" stroke="var(--crab-shell)" stroke-width="4" stroke-linecap="round" fill="none">
      <path d="M46 14 L45 8" />
      <path d="M74 14 L75 8" />
    </g>
  `,
};

// Not a crab. Wide shell, eye stalks, walks sideways across the ledge,
// and the Crabdex refuses to acknowledge it.
function renderCrabSvg() {
  return svg`
    <svg
      class="crab-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g stroke="#2e7d46" stroke-width="4" stroke-linecap="round" fill="none">
        <path d="M22 78 L8 88" />
        <path d="M28 88 L16 99" />
        <path d="M98 78 L112 88" />
        <path d="M92 88 L104 99" />
      </g>
      <g stroke="#2fbf71" stroke-width="3.5" stroke-linecap="round" fill="none">
        <path d="M44 38 L40 24" />
        <path d="M76 38 L80 24" />
      </g>
      <circle cx="40" cy="22" r="4.5" fill="#0a1014" />
      <circle cx="80" cy="22" r="4.5" fill="#0a1014" />
      <circle cx="41.5" cy="20.5" r="1.8" fill="#3fff7d" />
      <circle cx="81.5" cy="20.5" r="1.8" fill="#3fff7d" />
      <ellipse cx="60" cy="70" rx="46" ry="30" fill="#2fbf71" />
      <ellipse cx="48" cy="60" rx="16" ry="9" fill="#ffffff" opacity="0.1" />
      <path
        d="M16 58 C2 52 -2 62 4 72 C10 82 20 76 24 66 C26 60 22 58 16 58 Z"
        fill="#57c785"
      />
      <path
        d="M104 58 C118 52 122 62 116 72 C110 82 100 76 96 66 C94 60 98 58 104 58 Z"
        fill="#57c785"
      />
      <path d="M48 82 Q60 90 72 82" stroke="#1f9d57" stroke-width="3" stroke-linecap="round" fill="none" />
    </svg>
  `;
}

// Also not a crab. Crosses the ledge on its own schedule, which is to
// say: eventually.
function renderSnailSvg() {
  return svg`
    <svg
      class="crab-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M14 96 Q32 84 58 88 L96 88 Q110 90 112 97 Q112 103 102 103 L24 103 Q14 103 14 96 Z"
        fill="#c9a06a"
      />
      <g stroke="#c9a06a" stroke-width="3.5" stroke-linecap="round" fill="none">
        <path d="M94 88 Q96 76 91 68" />
        <path d="M103 88 Q107 76 103 66" />
      </g>
      <circle cx="90" cy="65" r="3.6" fill="#0a1014" />
      <circle cx="103" cy="63" r="3.6" fill="#0a1014" />
      <circle cx="91" cy="64" r="1.3" fill="#3fff7d" />
      <circle cx="104" cy="62" r="1.3" fill="#3fff7d" />
      <circle cx="50" cy="62" r="27" fill="#5a6b52" />
      <path
        d="M50 41 a21 21 0 1 1 -15 36 a14 14 0 1 0 11 -25 a8 8 0 1 0 4 14"
        stroke="#5f3d1c"
        stroke-width="4"
        stroke-linecap="round"
        fill="none"
      />
    </svg>
  `;
}

// The rubber duck: patron saint of debugging. It floats through, listens,
// and leaves without judging anyone's architecture.
function renderDuckSvg() {
  return svg`
    <svg
      class="crab-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M30 82 Q20 74 27 65 Q30 76 40 79 Z" fill="#f0b52e" />
      <ellipse cx="58" cy="85" rx="34" ry="17" fill="#ffd23e" />
      <circle cx="82" cy="50" r="18" fill="#ffd23e" />
      <path d="M98 49 Q112 52 99 59 Q95 56 95 51 Z" fill="#3fff7d" />
      <circle cx="86" cy="44" r="3.6" fill="#0a1014" />
      <circle cx="87" cy="43" r="1.3" fill="#ffffff" />
      <path d="M44 82 Q58 72 72 82 Q58 93 44 82 Z" fill="#f0b52e" opacity="0.75" />
    </svg>
  `;
}

// A jellyfish drifting past above the ledge, pulsing gently, thinking about
// nothing at all.
function renderJellyfishSvg() {
  return svg`
    <svg
      class="crab-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g class="crab-jelly-tentacles" stroke="#9f7dfa" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.8">
        <path d="M40 58 Q35 74 42 90" />
        <path d="M54 61 Q52 78 57 96" />
        <path d="M68 61 Q71 78 64 94" />
        <path d="M80 58 Q85 72 78 88" />
      </g>
      <path
        d="M30 52 C30 22 90 22 90 52 L90 58 Q82 52 75 58 Q67 52 60 58 Q52 52 45 58 Q38 52 30 58 Z"
        fill="#b79bff"
        opacity="0.78"
      />
      <ellipse cx="47" cy="37" rx="12" ry="6" fill="#ffffff" opacity="0.25" />
      <circle cx="52" cy="45" r="2.6" fill="#0a1014" />
      <circle cx="66" cy="45" r="2.6" fill="#0a1014" />
    </svg>
  `;
}

export const PASSER_SPRITES: Record<Exclude<CrabPasserKind, "stranger">, () => TemplateResult> = {
  crab: renderCrabSvg,
  snail: renderSnailSvg,
  duck: renderDuckSvg,
  jellyfish: renderJellyfishSvg,
};

// While hovering, a closed bottle keeps its secret; opening swaps the title
// to the fortune — the pet-name tooltip channel, so no i18n surface.
export function renderBottleSvg(opened: boolean) {
  return svg`
    <svg class="crab-bottle__svg" viewBox="0 0 48 44" aria-hidden="true">
      <g transform="rotate(-16 24 30)">
        <rect x="5" y="18" width="30" height="16" rx="7" fill="#7fc8b8" opacity="0.72" />
        <rect x="33" y="22" width="9" height="8" rx="2.5" fill="#7fc8b8" opacity="0.72" />
        ${
          opened
            ? svg`
              <rect x="36" y="20" width="11" height="7" rx="1.5" fill="#f2e5c9" transform="rotate(-24 41 23)" />
              <rect x="43" y="30" width="4.5" height="8" rx="1.6" fill="#5a6b52" transform="rotate(38 45 34)" />
            `
            : svg`<rect x="41" y="21.5" width="5" height="9" rx="1.8" fill="#5a6b52" />`
        }
        <rect x="11" y="22" width="12" height="8" rx="1.5" fill="#f2e5c9" />
        <path d="M13 24.5 L21 24.5 M13 27 L19 27" stroke="#b6a071" stroke-width="1" />
        <ellipse cx="13" cy="20.5" rx="5" ry="2" fill="#ffffff" opacity="0.35" />
      </g>
    </svg>
  `;
}

// Balloon entrance rig: rendered inside the body while the descent plays,
// then unmounts with the entering flag.
export const BALLOON = svg`
  <svg class="crab-pet__balloon" viewBox="0 0 40 62" aria-hidden="true">
    <path d="M20 34 Q23 46 18 60" stroke="#8a949d" stroke-width="1.5" fill="none" />
    <ellipse cx="20" cy="16" rx="13" ry="15" fill="#3ec9a0" />
    <path d="M17 30 L20 34.5 L23 30 Z" fill="#4ecfa6" />
    <ellipse cx="15" cy="10" rx="4" ry="6" fill="#ffffff" opacity="0.3" />
  </svg>
`;

export const PASSER_TITLES: Record<CrabPasserKind, string> = {
  stranger: "a stranger",
  crab: "definitely a crab",
  snail: "in no particular hurry",
  duck: "a duck. obviously",
  jellyfish: "just drifting",
};
