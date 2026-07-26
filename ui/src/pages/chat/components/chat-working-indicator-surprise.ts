import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";

// One salt per page load keeps each run stable while varying the surprise between visits.
const SURPRISE_SALT = Math.trunc(Math.random() * 0xffffffff);
const SURPRISE_CHANCE_PER_THOUSAND = 30;
const SURPRISE_CLASSES = [
  "chat-reading-indicator--southpaw",
  "chat-reading-indicator--flurry",
  "chat-reading-indicator--spin",
  "chat-reading-indicator--shadowbox",
  "chat-reading-indicator--backflip",
  "chat-reading-indicator--zen",
  "chat-reading-indicator--drummer",
  "chat-reading-indicator--peekaboo",
] as const;

export function selectWorkingClawSurprise(
  key: string,
  options: { salt?: number; eligible?: boolean } = {},
): string {
  if (options.eligible === false) {
    return "";
  }
  const hash = (fnv1aUtf16(key) ^ (options.salt ?? SURPRISE_SALT)) >>> 0;
  if (hash % 1000 >= SURPRISE_CHANCE_PER_THOUSAND) {
    return "";
  }
  return SURPRISE_CLASSES[Math.floor(hash / 1000) % SURPRISE_CLASSES.length] ?? "";
}
