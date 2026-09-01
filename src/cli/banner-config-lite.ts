// Lightweight banner option parser kept out of the full CLI import path.
import type { TaglineMode } from "./tagline.js";

/** Parse an explicit CLI banner tagline mode. */
export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}
