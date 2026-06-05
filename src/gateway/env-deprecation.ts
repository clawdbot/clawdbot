// Gateway legacy environment warning.
// Emits a one-shot notice for ignored pre-OpenClaw environment prefixes.
import { isVitestRuntimeEnv } from "../infra/env.js";

// Legacy env warnings are process-wide and intentionally one-shot so normal
// gateway startup is noisy enough to notice but not spammed by repeated imports.
const LEGACY_ENV_PREFIXES = ["CLAWDBOT_", "MOLTBOT_"] as const;
type LegacyEnvPrefix = (typeof LEGACY_ENV_PREFIXES)[number];

let warned = false;

/** Emits a one-time warning when ignored legacy CLAWDBOT_/MOLTBOT_ env vars are present. */
export function warnLegacyOpenClawEnvVars(env: NodeJS.ProcessEnv = process.env): void {
  if (warned || isVitestRuntimeEnv(env)) {
    return;
  }

  const prefixCounts = new Map<LegacyEnvPrefix, number>();
  for (const key of Object.keys(env)) {
    // Count by prefix only; never print env names or values because some legacy
    // names may still encode account/provider secrets.
    const prefix = LEGACY_ENV_PREFIXES.find((candidate) => key.startsWith(candidate));
    if (prefix) {
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }

  const legacyVarCount = [...prefixCounts.values()].reduce((total, count) => total + count, 0);
  if (legacyVarCount === 0) {
    return;
  }

  const detectedPrefixes = LEGACY_ENV_PREFIXES.filter((prefix) => prefixCounts.has(prefix))
    .map((prefix) => `${prefix}*`)
    .join(", ");

  process.emitWarning(
    [
      `Legacy ${detectedPrefixes} environment variables were detected (${legacyVarCount} total), but OpenClaw only reads OPENCLAW_* names now.`,
      "Rename them by replacing the legacy prefix with OPENCLAW_; the old names are ignored.",
    ].join("\n"),
    { code: "OPENCLAW_LEGACY_ENV_VARS", type: "DeprecationWarning" },
  );
  warned = true;
}

/** Resets the one-shot legacy env warning latch for tests. */
export function resetLegacyOpenClawEnvWarningForTest(): void {
  warned = false;
}
