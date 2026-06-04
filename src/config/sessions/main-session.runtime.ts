import { getRuntimeConfig } from "../io.js";
import { resolveMainSessionKey } from "./main-session.js";

/** Resolves the main session key from the active runtime config. */
export function resolveMainSessionKeyFromConfig(): string {
  return resolveMainSessionKey(getRuntimeConfig());
}
