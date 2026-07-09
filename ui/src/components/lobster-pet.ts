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
  | "startle";

export type LobsterPetMode = "idle" | "busy" | "offline";

export type LobsterPetPersonalityId = "sleepy" | "zoomy" | "friendly" | "showoff";

export type LobsterPetPalette = {
  id: "crimson" | "coral" | "teal" | "violet" | "ink" | "gold";
  shell: string;
  claw: string;
};

export type LobsterPetAccessory = "none" | "crown" | "sprout" | "patch";

export type LobsterPetAntennae = "perky" | "droopy";

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

const PALETTES: Array<[LobsterPetPalette, number]> = [
  [{ id: "crimson", shell: "#ff4f40", claw: "#ff775f" }, 30],
  [{ id: "coral", shell: "#d0836a", claw: "#de9b80" }, 30],
  [{ id: "teal", shell: "#2fbfa7", claw: "#5cd9c4" }, 12],
  [{ id: "violet", shell: "#9f7dfa", claw: "#bba4fd" }, 12],
  [{ id: "ink", shell: "#5e6b7a", claw: "#7b8996" }, 11],
  [{ id: "gold", shell: "#f4b840", claw: "#f9d47a" }, 5],
];

const ACCESSORIES: Array<[LobsterPetAccessory, number]> = [
  ["none", 62],
  ["sprout", 14],
  ["patch", 14],
  ["crown", 10],
];

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

// Keep the perch off the footer center so tooltips and the theme toggle
// never sit under the sprite.
const SPOT_ZONES = { left: [12, 38], right: [60, 84] } as const;
const ENTER_MS = 450;

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

export function createLobsterPetLook(seed: number): LobsterPetLook {
  const rng = mulberry32(seed);
  const palette = pickWeighted(rng, PALETTES);
  const scale = pickWeighted(rng, SCALES);
  const accessory = pickWeighted(rng, ACCESSORIES);
  const antennae: LobsterPetAntennae = rng() < 0.6 ? "perky" : "droopy";
  const side = rng() < 0.5 ? "left" : "right";
  const zone = SPOT_ZONES[side];
  const spotPct = Math.round(randomBetween(rng, zone[0], zone[1]));
  const facing = rng() < 0.5 ? 1 : -1;
  const personality = pickWeighted(rng, PERSONALITY_IDS);
  const blinkDelayS = Math.round(randomBetween(rng, 0, 4) * 10) / 10;
  return { palette, scale, accessory, antennae, side, spotPct, facing, personality, blinkDelayS };
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
};

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
function renderLobsterSvg(look: LobsterPetLook) {
  return svg`
    <svg
      class="lobster-pet__svg"
      viewBox="0 0 120 105"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
    >
      ${ANTENNAE_SPRITES[look.antennae]}
      <g class="lob-claw lob-claw--l">
        <path
          d="M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z"
          fill="var(--lob-claw)"
        />
      </g>
      <g class="lob-claw lob-claw--r">
        <path
          d="M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z"
          fill="var(--lob-claw)"
        />
      </g>
      <path
        d="M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z"
        fill="var(--lob-shell)"
      />
      <ellipse cx="48" cy="28" rx="20" ry="11" fill="#ffffff" opacity="0.1" />
      <g class="lob-eye-open">
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
      ${look.accessory === "none" ? nothing : ACCESSORY_SPRITES[look.accessory]}
    </svg>
  `;
}

export class LobsterPet extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) seed = 0;
  @property({ attribute: false }) mode: LobsterPetMode = "idle";

  @state() private act: LobsterPetAct | null = null;
  @state() private spotPct = 80;
  @state() private facing: 1 | -1 = 1;
  @state() private entering = false;

  private look: LobsterPetLook | null = null;
  private rng: () => number = mulberry32(0);
  private idleTimer: number | null = null;
  private actEndTimer: number | null = null;
  private enterTimer: number | null = null;
  private restartPending = false;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearTimers();
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    const seedChanged = this.look === null || changed.has("seed");
    if (seedChanged) {
      this.look = createLobsterPetLook(this.seed);
      this.rng = mulberry32(this.seed ^ 0x9e3779b9);
      this.spotPct = this.look.spotPct;
      this.facing = this.look.facing;
      // Reset the act loop inside the update pass; deferring state flips to
      // updated() would chain a second update and trip lit's change-in-update
      // warning.
      this.clearTimers();
      this.act = null;
      this.entering = !prefersReducedMotion();
      this.restartPending = this.entering;
    } else if (changed.has("mode") && !prefersReducedMotion()) {
      // Status flips get an immediate reaction; the act-end timer then
      // reschedules from the new mode's pool.
      this.performAct("startle");
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
      this.clearTimers();
      this.act = null;
    } else {
      this.scheduleNextAct();
    }
  };

  private readonly handlePoke = () => {
    if (prefersReducedMotion()) {
      return;
    }
    this.performAct("startle");
  };

  private clearTimers() {
    for (const timer of [this.idleTimer, this.actEndTimer, this.enterTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.idleTimer = null;
    this.actEndTimer = null;
    this.enterTimer = null;
  }

  private actProfile(): ActProfile | null {
    if (this.mode === "busy" || this.mode === "offline") {
      return LOBSTER_PET_MODE_ACTS[this.mode];
    }
    return this.look ? PERSONALITIES[this.look.personality] : null;
  }

  private scheduleNextAct() {
    // Guard here, not just at activation: the visibilitychange resume path
    // must also stay inert for reduced-motion users.
    if (
      !this.look ||
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
      if (!nextProfile || document.hidden) {
        return;
      }
      this.performAct(pickWeighted(this.rng, nextProfile.acts));
    }, delay);
  }

  private performAct(act: LobsterPetAct) {
    this.clearTimers();
    this.entering = false;
    if (act === "scuttle") {
      this.startScuttle();
    }
    this.act = act;
    this.actEndTimer = window.setTimeout(() => {
      this.actEndTimer = null;
      this.act = null;
      this.scheduleNextAct();
    }, LOBSTER_PET_ACT_DURATION_MS[act]);
  }

  private startScuttle() {
    if (!this.look) {
      return;
    }
    const zone = SPOT_ZONES[this.look.side];
    let target = Math.round(randomBetween(this.rng, zone[0], zone[1]));
    // A same-spot walk reads as a glitch; nudge to the other zone edge.
    if (Math.abs(target - this.spotPct) < 4) {
      target =
        Math.abs(zone[0] - this.spotPct) > Math.abs(zone[1] - this.spotPct) ? zone[0] : zone[1];
    }
    this.facing = target < this.spotPct ? -1 : 1;
    this.spotPct = target;
  }

  override render() {
    const look = this.look;
    if (!look) {
      return nothing;
    }
    const classes = [
      "lobster-pet",
      `lobster-pet--${this.mode}`,
      this.entering ? "lobster-pet--entering" : "",
      this.act ? `lobster-pet--act-${this.act}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = [
      `--lob-shell:${look.palette.shell}`,
      `--lob-claw:${look.palette.claw}`,
      `--lob-dim:color-mix(in srgb, ${look.palette.shell} 72%, #10181f)`,
      `--lob-scale:${look.scale}`,
      `--lob-x:${this.spotPct}%`,
      `--lob-face:${this.facing}`,
      `--lob-blink-delay:${look.blinkDelayS}s`,
    ].join(";");
    return html`
      <div class=${classes} style=${style} aria-hidden="true" @pointerdown=${this.handlePoke}>
        <div class="lobster-pet__body">
          ${renderLobsterSvg(look)}
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
}

if (!customElements.get("openclaw-lobster-pet")) {
  customElements.define("openclaw-lobster-pet", LobsterPet);
}
