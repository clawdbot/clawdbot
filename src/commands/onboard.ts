import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { runInteractiveOnboarding } from "./onboard-interactive.js";
import { runNonInteractiveOnboarding } from "./onboard-non-interactive.js";
import type { OnboardOptions } from "./onboard-types.js";

export async function onboardCommand(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  assertSupportedRuntime(runtime);
  const authChoice =
    opts.authChoice === "oauth" ? ("setup-token" as const) : opts.authChoice;
  const normalizedOpts =
    authChoice === opts.authChoice ? opts : { ...opts, authChoice };

  if (process.platform === "win32") {
    runtime.log(
      [
        "Windows detected.",
        "WSL2 is strongly recommended; native Windows is untested and more problematic.",
        "Guide: https://docs.clawd.bot/windows",
      ].join("\n"),
    );
  }

  if (normalizedOpts.nonInteractive) {
    await runNonInteractiveOnboarding(normalizedOpts, runtime);
    return;
  }

  await runInteractiveOnboarding(normalizedOpts, runtime);
}

export type { OnboardOptions } from "./onboard-types.js";
