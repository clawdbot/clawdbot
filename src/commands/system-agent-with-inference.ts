// OpenClaw command gate: prove inference before starting conversational setup.

import { requestExitAfterOneShotOutput } from "../cli/one-shot-exit.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { BoundVerifySetupInferenceResult } from "../system-agent/setup-inference.js";
import type { SystemAgentCommandOptions } from "../system-agent/system-agent.js";
import type { OnboardOptions } from "./onboard-types.js";

type RunSystemAgent = typeof import("../system-agent/system-agent.js").runSystemAgent;
type VerifySetupInference = (params: {
  runtime: RuntimeEnv;
  bindSession: true;
}) => Promise<BoundVerifySetupInferenceResult>;
type RunGuidedOnboarding = typeof import("./onboard-guided.js").runGuidedOnboarding;

type SystemAgentWithInferenceDeps = {
  verifyInference?: VerifySetupInference;
  runGuidedOnboarding?: RunGuidedOnboarding;
  runSystemAgent?: RunSystemAgent;
};

function hasInteractiveTty(opts: SystemAgentCommandOptions): boolean {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  return (
    (input as { isTTY?: boolean }).isTTY === true && (output as { isTTY?: boolean }).isTTY === true
  );
}

function isOneShotRequest(opts: SystemAgentCommandOptions): boolean {
  return Boolean(opts.json || opts.message?.trim() || opts.interactive === false);
}

function formatOneShotExecutionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failOneShotExecution(
  opts: SystemAgentCommandOptions,
  runtime: RuntimeEnv,
  error: unknown,
): void {
  const message = formatOneShotExecutionError(error);
  if (opts.json) {
    writeRuntimeJson(runtime, { ok: false, error: message });
  } else {
    runtime.error(message);
  }
  if (!requestExitAfterOneShotOutput(runtime, 1)) {
    runtime.exit(1);
  }
}

/**
 * Start OpenClaw only after the configured default model completes a real
 * turn. Interactive failures return to inference onboarding; automation fails
 * closed with a stable command operators can run to repair the prerequisite.
 */
export async function runSystemAgentWithInference(
  opts: SystemAgentCommandOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
  onboardingOptions: Pick<OnboardOptions, "workspace" | "acceptRisk"> = {},
  deps: SystemAgentWithInferenceDeps = {},
): Promise<void> {
  if (opts.yes && !opts.message?.trim()) {
    failOneShotExecution(
      opts,
      runtime,
      new Error("OpenClaw --yes requires --message so approval is limited to one request."),
    );
    return;
  }
  const oneShot = isOneShotRequest(opts);
  if (!oneShot && !hasInteractiveTty(opts)) {
    runtime.error("OpenClaw needs an interactive TTY. Use --message for one command.");
    runtime.exit(1);
    return;
  }
  let inference: BoundVerifySetupInferenceResult;
  try {
    const verifyInference =
      deps.verifyInference ??
      (await import("../system-agent/setup-inference.js")).verifySetupInference;
    inference = await withConsoleSubsystemsSuppressed(() =>
      verifyInference({ runtime, bindSession: true }),
    );
  } catch (error) {
    if (!oneShot) {
      throw error;
    }
    failOneShotExecution(opts, runtime, error);
    return;
  }
  if (inference.ok) {
    const runSystemAgent =
      deps.runSystemAgent ?? (await import("../system-agent/system-agent.js")).runSystemAgent;
    try {
      await runSystemAgent({ ...opts, verifiedInference: inference.binding }, runtime);
    } catch (error) {
      if (!oneShot) {
        throw error;
      }
      failOneShotExecution(opts, runtime, error);
      return;
    }
    if (oneShot) {
      requestExitAfterOneShotOutput(runtime);
    }
    return;
  }

  if (oneShot) {
    const guidance = "Run `openclaw onboard` to connect and live-test AI first.";
    if (opts.json) {
      writeRuntimeJson(runtime, {
        ok: false,
        status: inference.status,
        error: `OpenClaw requires working inference: ${inference.error}`,
        guidance,
      });
    } else {
      runtime.error(
        [`OpenClaw requires working inference: ${inference.error}`, guidance].join("\n"),
      );
    }
    if (!requestExitAfterOneShotOutput(runtime, 1)) {
      runtime.exit(1);
    }
    return;
  }

  runtime.log("OpenClaw requires working inference. Starting guided AI setup…");
  const runGuidedOnboarding =
    deps.runGuidedOnboarding ?? (await import("./onboard-guided.js")).runGuidedOnboarding;
  await runGuidedOnboarding(onboardingOptions, runtime);
}
