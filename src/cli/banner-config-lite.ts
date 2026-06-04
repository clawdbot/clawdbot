// Lightweight banner config reader kept out of the full CLI import path.
import { createConfigIO } from "../config/config.js";
import type { TaglineMode } from "./tagline.js";

/** Parse a persisted CLI banner tagline mode. */
export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

/** Read the banner tagline mode without pulling in full CLI command registration. */
export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    const parsed = createConfigIO({ env }).loadConfig() as {
      cli?: { banner?: { taglineMode?: unknown } };
    };
    return parseTaglineMode(parsed.cli?.banner?.taglineMode);
  } catch {
    return undefined;
  }
}
