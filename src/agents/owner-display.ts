/**
 * Owner display settings for prompt rendering.
 *
 * Owner ids are rendered raw; no config or secret is required.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

type OwnerDisplaySetting = {
  ownerDisplay?: "raw" | "hash";
  ownerDisplaySecret?: string;
};

type OwnerDisplaySecretResolution = {
  config: OpenClawConfig;
  generatedSecret?: string;
};

/**
 * Resolve owner display settings for prompt rendering.
 * Keep auth secrets decoupled from owner hash secrets.
 */
export function resolveOwnerDisplaySetting(_config?: OpenClawConfig): OwnerDisplaySetting {
  return { ownerDisplay: "raw", ownerDisplaySecret: undefined };
}

/**
 * Ensure hash mode has a dedicated secret.
 * Returns updated config and generated secret when autofill was needed.
 */
export function ensureOwnerDisplaySecret(
  config: OpenClawConfig,
  _generateSecret?: () => string,
): OwnerDisplaySecretResolution {
  return { config };
}
