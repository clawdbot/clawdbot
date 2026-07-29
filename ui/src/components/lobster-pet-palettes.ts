import { expectDefined } from "@openclaw/normalization-core";
import type { LobsterPetLook, LobsterPetPalette } from "./lobster-pet-contract.ts";

// Rarity ladder loosely mirrors real lobster genetics: blue and gold lead into
// terminal fantasies whose geometry and styling key off each id.
export const LOBSTER_PALETTE_WEIGHTS: Array<[LobsterPetPalette, number]> = [
  [{ id: "crimson", shell: "#ff4f40", claw: "#ff775f" }, 26],
  [{ id: "blue", shell: "#4a7dfc", claw: "#7fa4ff" }, 7],
  [{ id: "gold", shell: "#f4b840", claw: "#f9d47a" }, 5],
  [{ id: "lumen", shell: "#1d2f4e", claw: "#2e4a77" }, 2],
  [{ id: "magma", shell: "#241214", claw: "#3a1d18" }, 2],
  [{ id: "oilslick", shell: "#15171d", claw: "#23262e" }, 2],
  [{ id: "aurora", shell: "#dce6f0", claw: "#e9f0f7" }, 2],
  [{ id: "nebula", shell: "#34255c", claw: "#4a3a7d" }, 2],
  [{ id: "banana", shell: "#f7e27d", claw: "#f3d55b" }, 2],
  // CSS values are the palette color contract; var()/rgba() pass through.
  [{ id: "mood", shell: "var(--accent, #7f77dd)", claw: "var(--accent-hover, #9a93e8)" }, 1.5],
  [{ id: "bee", shell: "#f4c531", claw: "#2b2b23" }, 1.5],
  [{ id: "rubberduck", shell: "#ffd93b", claw: "#ffb03b" }, 1.5],
  [{ id: "watermelon", shell: "#3f9d63", claw: "#4fb072" }, 1.5],
  [{ id: "clawtron", shell: "#8d99a6", claw: "#a2aeba" }, 1],
  [{ id: "selene", shell: "#c9ced8", claw: "#d8dde5" }, 1],
  [{ id: "geode", shell: "#6b6474", claw: "#7d7588" }, 1],
  [{ id: "ghost", shell: "#dce8f2", claw: "#ecf3fa" }, 1],
  [{ id: "glass", shell: "#cfe4f4", claw: "#e0eef8" }, 1],
  [{ id: "split", shell: "#ff4f40", claw: "#ff775f" }, 1],
  [{ id: "sourdough", shell: "#d9a662", claw: "#e6bc82" }, 1],
  [{ id: "zombie", shell: "#9db08a", claw: "#86a17a" }, 1],
  [{ id: "plush", shell: "#e8967a", claw: "#f2b09a" }, 1],
  [{ id: "balloon", shell: "#ff5c8a", claw: "#ff7ea1" }, 1],
  [{ id: "cryptid", shell: "#6e6257", claw: "#7d7263" }, 0.9],
  [{ id: "flatpack", shell: "#d9c9a8", claw: "#d9c9a8" }, 0.9],
  [{ id: "tinfoil", shell: "#9aa4ad", claw: "#a8b2bb" }, 0.9],
  [{ id: "actual", shell: "#a63c28", claw: "#8f3220" }, 0.9],
  [{ id: "cottoncandy", shell: "#f6a8c9", claw: "#a5c6f0" }, 0.8],
  [{ id: "disco", shell: "#b8c4d8", claw: "#cbd5e6" }, 0.8],
  [{ id: "chimera", shell: "#b0685a", claw: "#b0685a" }, 0.75],
  [{ id: "pixel", shell: "#d84c3e", claw: "#ef8f6a" }, 0.7],
  [{ id: "blueprint", shell: "#123a66", claw: "#123a66" }, 0.7],
  [{ id: "phosphor", shell: "#0d2415", claw: "#0f2b19" }, 0.7],
  // Terminal ink rides a theme var so the glyph art stays legible on light
  // cards; the CSS contract passes var() values through untouched (mood).
  [
    { id: "ascii", shell: "var(--lob-ascii-ink, #d8dee6)", claw: "var(--lob-ascii-ink, #d8dee6)" },
    0.7,
  ],
  [{ id: "portal", shell: "#4a9df8", claw: "#ff9a2e" }, 0.7],
  [{ id: "notexture", shell: "#ff00dc", claw: "#111111" }, 0.65],
  [{ id: "loading", shell: "#3a4150", claw: "#454d5e" }, 0.65],
  [{ id: "eclipse", shell: "#14161d", claw: "#1d2026" }, 0.65],
  [{ id: "heisenbug", shell: "#262a33", claw: "#343945" }, 0.6],
  [{ id: "invisible", shell: "rgba(127,140,160,0.07)", claw: "rgba(127,140,160,0.07)" }, 0.55],
  // The classic-logo grails stay the final, strictly rarest two entries.
  [{ id: "retro", shell: "#e8262c", claw: "#f04a3e" }, 0.5],
  [{ id: "goldenretro", shell: "#e8b422", claw: "#f6cf5a" }, 0.1],
];

export const LOBSTER_PET_PALETTES: readonly LobsterPetPalette[] = LOBSTER_PALETTE_WEIGHTS.map(
  ([palette]) => palette,
);

const CHIMERA_DONOR_IDS = ["crimson", "blue", "gold", "banana", "watermelon"] as const;

export const CANONICAL_CHIMERA_PARTS: NonNullable<LobsterPetLook["chimeraParts"]> = {
  body: "#ff4f40",
  clawLeft: "#4a7dfc",
  clawRight: "#f4b840",
  antennae: "#3f9d63",
};

export function rollChimeraParts(rng: () => number): NonNullable<LobsterPetLook["chimeraParts"]> {
  const remaining = CHIMERA_DONOR_IDS.map((id) =>
    expectDefined(
      LOBSTER_PET_PALETTES.find((palette) => palette.id === id),
      `chimera donor palette ${id}`,
    ),
  );
  const pick = (): LobsterPetPalette => {
    const index = Math.floor(rng() * remaining.length);
    return expectDefined(remaining.splice(index, 1)[0], "distinct chimera donor");
  };
  return {
    body: pick().shell,
    clawLeft: pick().shell,
    clawRight: pick().shell,
    antennae: pick().shell,
  };
}

export function chimeraBodyClaw(bodyColor: string): string | undefined {
  return LOBSTER_PET_PALETTES.find((palette) => palette.shell === bodyColor)?.claw;
}
