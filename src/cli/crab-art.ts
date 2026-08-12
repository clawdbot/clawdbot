import { expectDefined } from "@openclaw/normalization-core";
// The Control UI crab pet has a CLI cousin: on roughly one day in sixteen
// the interactive banner gains a tiny ASCII crab. The day comes from the
// shared crab-day hash (the sidebar pet dresses up on the same days), so
// every surface agrees on the calendar and tests can pin dates.
import { isCrabDay, crabDayHash } from "../shared/crab-day.js";

const CRAB_ARTS: readonly string[] = [
  // Pincers up, waving hello.
  ["   \\_/ \\_/", "    ( v.v )", "   /|___|\\", "    |   |"].join("\n"),
  // Just the eyestalks, watching from below the waterline.
  ["     o   o", "     )   (", "  ~~~~~~~~~~~"].join("\n"),
] as const;

/**
 * Return the ASCII crab for `now`'s calendar day, or null on non-crab
 * days and in CI/test environments (banner tests assert exact bytes).
 */
export function pickCliCrabArt(now: Date, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CI || env.VITEST) {
    return null;
  }
  if (!isCrabDay(now)) {
    return null;
  }
  return expectDefined(
    CRAB_ARTS[(crabDayHash(now) >>> 8) % CRAB_ARTS.length],
    "crab arts entry at (crab day hash(now) >>> 8) % crab arts.length",
  );
}
