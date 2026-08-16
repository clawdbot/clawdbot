import { collectConfigRuntimeEnvVars } from "./env-vars.js";
import type { OpenClawConfig } from "./types.js";

export const GATEWAY_CONFIG_SELECTION_ENV_KEYS: ReadonlySet<string> = new Set([
  "ANDROID_DATA",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_INCLUDE_ROOTS",
  "OPENCLAW_NIX_MODE",
  "OPENCLAW_OAUTH_DIR",
  "OPENCLAW_PACKAGE_DIR",
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_WORKSPACE_DIR",
  "PI_CODING_AGENT_DIR",
  "PREFIX",
  "USERPROFILE",
]);

/** Rejects config.env changes that would retarget a running Gateway process. */
export function assertGatewayConfigEnvSelectionUnchanged(
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): void {
  const normalize = (config: OpenClawConfig) =>
    new Map(
      Object.entries(collectConfigRuntimeEnvVars(config)).map(([key, value]) => [
        key.toUpperCase(),
        value,
      ]),
    );
  const previous = normalize(previousConfig);
  const next = normalize(nextConfig);
  for (const key of GATEWAY_CONFIG_SELECTION_ENV_KEYS) {
    if (previous.get(key) !== next.get(key)) {
      throw new Error(
        `Config env cannot change process-stable Gateway selector ${key} during reload. Restart with the target environment instead.`,
      );
    }
  }
}
