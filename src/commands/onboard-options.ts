/**
 * Shared rejection path for `openclaw onboard` option validation.
 *
 * Lives above the local/remote split because both the outer command and the
 * non-interactive handlers reject options, and every one of them must honor --json.
 */
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { OnboardOptions } from "./onboard-types.js";

/** Reports an invalid option and exits; returns false so validators can `return` it directly. */
export function rejectOnboardingOption(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  message: string,
): false {
  // --json promises exactly one machine-readable object per run, so a rejection has to emit one
  // too. Without this the caller sees an empty stdout and cannot tell a bad flag from a crash.
  if (opts.json) {
    writeRuntimeJson(runtime, { ok: false, phase: "options", message });
  }
  runtime.error(message);
  runtime.exit(1);
  return false;
}
