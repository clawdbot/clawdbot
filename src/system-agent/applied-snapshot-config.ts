import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type AppliedConfigSnapshot = {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
};

/**
 * A freshly read snapshot leaves non-env SecretRefs unresolved, so system-agent
 * surfaces that re-read config would lose credentials the active runtime already
 * resolved. Reuse the live runtime config while the file still matches the applied
 * source; once they diverge the fresh materialization is the correct answer, and
 * callers that compare against it keep failing closed on real drift.
 */
export function resolveAppliedSnapshotConfig(snapshot: AppliedConfigSnapshot): OpenClawConfig {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (
    runtimeConfig &&
    runtimeSourceConfig &&
    selectApplicableRuntimeConfig({
      inputConfig: snapshot.sourceConfig,
      runtimeConfig,
      runtimeSourceConfig,
    }) === runtimeConfig
  ) {
    return runtimeConfig;
  }
  return snapshot.runtimeConfig ?? snapshot.config;
}
