// Runtime main-session lookup binds the config-backed helper for callers without config access.
import { getRuntimeConfig } from "../io.js";
import { resolveSystemMainSessionKey } from "./main-session.js";

/** Resolves the main session key from the active runtime config. */
export function resolveMainSessionKeyFromConfig(): string {
  return resolveSystemMainSessionKey(getRuntimeConfig());
}
