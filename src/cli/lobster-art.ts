// The Control UI lobster pet has a CLI cousin: on roughly one day in sixteen
// the interactive banner gains a tiny ASCII lobster. The day comes from the
// shared lobster-day hash (the sidebar pet dresses up on the same days), so
// every surface agrees on the calendar and tests can pin dates.
import { isLobsterDay, lobsterDayHash } from "../shared/lobster-day.js";

const LOBSTER_ARTS: readonly string[] = [
  // Claws up, saying hi.
  ["  (\\/)  (\\/)", "   \\_\\  /_/", "    ( o.o )", "    /|__|\\"].join("\n"),
  // Just the eyestalks, watching from below the waterline.
  ["     o   o", "     )   (", "  ~~~~~~~~~~~"].join("\n"),
] as const;

/**
 * Return the ASCII lobster for `now`'s calendar day, or null on non-lobster
 * days and in CI/test environments (banner tests assert exact bytes).
 */
export function pickCliLobsterArt(now: Date, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CI || env.VITEST) {
    return null;
  }
  if (!isLobsterDay(now)) {
    return null;
  }
  return LOBSTER_ARTS[(lobsterDayHash(now) >>> 8) % LOBSTER_ARTS.length];
}
