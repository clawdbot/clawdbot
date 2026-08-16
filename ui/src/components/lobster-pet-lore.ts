import { expectDefined } from "@openclaw/normalization-core";
import type { LobsterPetPaletteId } from "./lobster-pet-contract.ts";

type LobsterPaletteLore = {
  flavor: string;
  hint: string;
};

const RARE_NAMES: Partial<Record<LobsterPetPaletteId, string>> = {
  blue: "Blueberry",
  gold: "Goldie",
  lumen: "Glimmer",
  magma: "Ember",
  oilslick: "Slick",
  aurora: "Borealis",
  nebula: "Cosmo",
  banana: "Peel",
  mood: "Ringo",
  bee: "Buzz",
  rubberduck: "Debuggy",
  watermelon: "Pips",
  clawtron: "Clawtron",
  selene: "Selene",
  geode: "Amethyst",
  ghost: "Boo",
  glass: "Prism",
  split: "Picasso",
  sourdough: "Boule",
  zombie: "Shambles",
  plush: "Buttons",
  balloon: "Squeaky",
  cottoncandy: "Taffy",
  cryptid: "Nessie",
  flatpack: "Skaldjur",
  tinfoil: "Mulder",
  actual: "Homarus",
  disco: "Boogie",
  chimera: "Frankie",
  blueprint: "Prototype",
  phosphor: "TTY",
  ascii: "Figlet",
  portal: "Warp",
  notexture: "Magenta",
  loading: "Spinner",
  eclipse: "Umbra",
  heisenbug: "Segfault",
  invisible: "Nobody",
  pixel: "Sprite",
  retro: "OG",
  goldenretro: "24K",
};

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

export function lobsterPaletteName(paletteId: LobsterPetPaletteId): string {
  return RARE_NAMES[paletteId] ?? paletteId;
}

export function lobsterRandomName(seed: number): string {
  return expectDefined(
    PET_NAMES[(seed >>> 3) % PET_NAMES.length],
    "lobster pet name catalog entry",
  );
}

// Like pet names and bottle fortunes, Lobsterdex lore is an English-only
// easter-egg channel rather than product UI copy.
export const LOBSTER_PALETTE_LORE: Record<LobsterPetPaletteId, LobsterPaletteLore> = {
  crimson: {
    flavor: "The classic red, first in every tide pool.",
    hint: "Where every story starts.",
  },
  blue: { flavor: "1 in 2 million, and knows it.", hint: "One in two million." },
  gold: { flavor: "1 in 30 million karats.", hint: "Worth its weight." },
  lumen: { flavor: "Brings its own night lights.", hint: "Glows where it's darkest." },
  magma: { flavor: "Fresh from the vent, still cooling.", hint: "Runs hot." },
  oilslick: { flavor: "Black shell, rainbow finish.", hint: "Spilled, not stirred." },
  aurora: {
    flavor: "Northern lights, southern claws.",
    hint: "Best seen on clear nights.",
  },
  nebula: {
    flavor: "Not from any ocean on this planet.",
    hint: "Came from very far away.",
  },
  banana: { flavor: "Banana. For scale.", hint: "For scale." },
  mood: { flavor: "Wears whatever color you're feeling.", hint: "Matches your vibe." },
  bee: { flavor: "Technically not a bee.", hint: "Do not tell the bees." },
  rubberduck: {
    flavor: "Listens to your bugs. Judges silently.",
    hint: "Quack.",
  },
  watermelon: { flavor: "Contains 6% lobster.", hint: "Ripe when thumped." },
  clawtron: { flavor: "60% rivets, 40% love.", hint: "Beep boop snip." },
  selene: { flavor: "Carries the current moon on its belly.", hint: "Waxes and wanes." },
  geode: { flavor: "Rock outside, amethyst inside.", hint: "Crack the surface." },
  ghost: { flavor: "1 in 100 million, barely there.", hint: "You'd walk right past it." },
  glass: {
    flavor: "Fully transparent. Nothing to hide.",
    hint: "Easy to miss, hard to forget.",
  },
  split: { flavor: "Two lobsters, one shell.", hint: "Can't pick a side." },
  sourdough: {
    flavor: "Started from a starter. 24-hour proof.",
    hint: "Still proofing.",
  },
  zombie: { flavor: "Slightly used. Still friendly.", hint: "It's been better." },
  plush: { flavor: "Machine washable. Air dry only.", hint: "Soft to the touch." },
  balloon: { flavor: "Do not pop.", hint: "Handle with care." },
  cottoncandy: {
    flavor: "Pastel, like the famous Maine catch.",
    hint: "Sweeter than it looks.",
  },
  cryptid: { flavor: "Every photo comes out blurry.", hint: "Sightings unconfirmed." },
  flatpack: { flavor: "Some assembly required.", hint: "Missing one screw." },
  tinfoil: { flavor: "The tide is a psyop.", hint: "They know." },
  actual: {
    flavor: "An actual lobster. Unsettling, honestly.",
    hint: "Anatomically correct.",
  },
  disco: { flavor: "Born under a mirror ball.", hint: "The night is still young." },
  chimera: { flavor: "Borrowed parts. No refunds.", hint: "Something's off." },
  blueprint: {
    flavor: "Final hardware pending approval.",
    hint: "Still on the drawing board.",
  },
  phosphor: { flavor: "80 columns, 24 rows, one lobster.", hint: "Hums at sixty hertz." },
  ascii: { flavor: "Renders anywhere. Even over SSH.", hint: "chmod +x" },
  portal: { flavor: "Arrives before it leaves.", hint: "Mind the gap." },
  notexture: { flavor: "Texture not found.", hint: "404." },
  loading: { flavor: "Still loading. Any second now.", hint: "…" },
  eclipse: { flavor: "Do not look directly at it.", hint: "Once in a blue moon." },
  heisenbug: {
    flavor: "Only renders right when nobody's watching.",
    hint: "Cannot be reproduced.",
  },
  invisible: { flavor: "It's right there. Look closer.", hint: "Trust me, it exists." },
  pixel: { flavor: "Rendered in 1987. Still runs.", hint: "Insert coin." },
  retro: {
    flavor: "The original: big claw, no apologies.",
    hint: "The one that started it all.",
  },
  goldenretro: { flavor: "One in a generation.", hint: "Worth the wait." },
};
