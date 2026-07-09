/**
 * Top-level `openclaw onboard` command entrypoint.
 *
 * It validates global setup flags, performs optional reset handling, and then
 * routes to interactive or non-interactive onboarding.
 */
import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  isDeprecatedAuthChoice,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "./auth-choice-legacy.js";
import { runGuidedOnboarding } from "./onboard-guided.js";
import { DEFAULT_WORKSPACE, handleReset } from "./onboard-helpers.js";
import { runInteractiveSetup } from "./onboard-interactive.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import type { OnboardOptions, ResetScope } from "./onboard-types.js";

const VALID_RESET_SCOPES = new Set<ResetScope>(["config", "config+creds+sessions", "full"]);

/**
 * Interactive onboarding defaults to guided setup. Any explicit
 * setup flag beyond this allowlist keeps the classic wizard — those flags are
 * a public automation contract and guided setup does not honor them.
 * Boolean false and undefined mean "not passed" (Commander coerces unset
 * booleans to false); explicit `--no-install-daemon` arrives as `false` via
 * resolveInstallDaemonFlag and is special-cased. `--modern` never reaches this
 * dispatch; it routes straight to Crestodian in the command layer.
 */
const GUIDED_SAFE_ONBOARD_KEYS = new Set([
  "workspace",
  "acceptRisk",
  "reset",
  "resetScope",
  "nonInteractive",
  "classic",
]);

function wantsClassicInteractiveSetup(opts: OnboardOptions): boolean {
  if (opts.classic === true) {
    return true;
  }
  if (opts.installDaemon !== undefined) {
    return true;
  }
  for (const [key, value] of Object.entries(opts)) {
    if (GUIDED_SAFE_ONBOARD_KEYS.has(key) || key === "installDaemon") {
      continue;
    }
    if (value === undefined || value === false) {
      continue;
    }
    return true;
  }
  return false;
}

/** Runs the onboard command after normalizing legacy flags and setup mode. */
export async function setupWizardCommand(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  assertSupportedRuntime(runtime);
  const originalAuthChoice = opts.authChoice;
  const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice, {
    env: process.env,
  });
  if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) {
    // Non-interactive output must be deterministic; reject deprecated aliases
    // instead of printing prompts or compatibility guidance mid-flow.
    runtime.error(
      formatDeprecatedNonInteractiveAuthChoiceError(originalAuthChoice, {
        env: process.env,
      })!,
    );
    runtime.exit(1);
    return;
  }
  if (isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) {
    runtime.log(
      resolveDeprecatedAuthChoiceReplacement(originalAuthChoice, { env: process.env })!.message,
    );
  }
  const flow = opts.flow === "manual" ? ("advanced" as const) : opts.flow;
  const normalizedOpts =
    normalizedAuthChoice === opts.authChoice && flow === opts.flow
      ? opts
      : { ...opts, authChoice: normalizedAuthChoice, flow };
  if (
    normalizedOpts.secretInputMode &&
    normalizedOpts.secretInputMode !== "plaintext" && // pragma: allowlist secret
    normalizedOpts.secretInputMode !== "ref" // pragma: allowlist secret
  ) {
    runtime.error(
      `Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for the interactive setup.`,
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.resetScope && !VALID_RESET_SCOPES.has(normalizedOpts.resetScope)) {
    runtime.error(
      `Invalid --reset-scope. Use "config", "config+creds+sessions", or "full". Run ${formatCliCommand("openclaw onboard --reset --reset-scope config")} for a config-only reset.`,
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.nonInteractive && normalizedOpts.acceptRisk !== true) {
    // Non-interactive setup can write credentials and daemon config without a
    // prompt, so the operator must acknowledge the security docs explicitly.
    runtime.error(
      [
        "Non-interactive setup requires explicit risk acknowledgement.",
        "Read: https://docs.openclaw.ai/security",
        `Re-run with: ${formatCliCommand("openclaw onboard --non-interactive --accept-risk ...")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.reset) {
    // Reset runs before setup mode dispatch so both interactive and
    // non-interactive setup start from the same cleaned state.
    const snapshot = await readConfigFileSnapshot();
    const baseConfig = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
    const workspaceDefault =
      normalizedOpts.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
    const resetScope: ResetScope = normalizedOpts.resetScope ?? "config+creds+sessions";
    await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
  }

  if (process.platform === "win32") {
    runtime.log(
      [
        "Windows detected - OpenClaw runs great on WSL2!",
        "Native Windows might be trickier.",
        "Quick setup: wsl --install (one command, one reboot)",
        "Guide: https://docs.openclaw.ai/windows",
      ].join("\n"),
    );
  }

  if (normalizedOpts.nonInteractive) {
    await runNonInteractiveSetup(normalizedOpts, runtime);
    return;
  }

  if (wantsClassicInteractiveSetup(normalizedOpts)) {
    await runInteractiveSetup(normalizedOpts, runtime);
    return;
  }

  await runGuidedOnboarding(normalizedOpts, runtime);
}

export const onboardCommand = setupWizardCommand;
