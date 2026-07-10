// The Control UI lobster pet has a CLI cousin: on roughly one day in sixteen
// the interactive banner gains a tiny ASCII lobster. Deterministic per
// calendar day (like the holiday taglines) so every terminal agrees on
// lobster day, and callers can pin the date in tests.

const LOBSTER_ARTS: readonly string[] = [
  // Claws up, saying hi.
  ["  (\\/)  (\\/)", "   \\_\\  /_/", "    ( o.o )", "    /|__|\\"].join("\n"),
  // Just the eyestalks, watching from below the waterline.
  ["     o   o", "     )   (", "  ~~~~~~~~~~~"].join("\n"),
] as const;

function hashDay(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Return the ASCII lobster for `now`'s calendar day, or null on non-lobster
 * days and in CI/test environments (banner tests assert exact bytes).
 */
export function pickCliLobsterArt(now: Date, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CI || env.VITEST) {
    return null;
  }
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const hash = hashDay(key);
  if (hash % 16 !== 3) {
    return null;
  }
  return LOBSTER_ARTS[(hash >>> 8) % LOBSTER_ARTS.length];
}
