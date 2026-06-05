/**
 * Remote non-interactive onboarding orchestration.
 *
 * It writes gateway.remote config without local gateway setup, preserving the
 * same config commit path as local onboarding.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { applySkipBootstrapConfig } from "../onboard-config.js";
import { applyWizardMetadata } from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";
import { commitNonInteractiveOnboardConfig } from "./config-write.js";

/** Runs non-interactive setup for clients that connect to an existing remote gateway. */
export async function runNonInteractiveRemoteSetup(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  baseHash?: string;
}) {
  const { opts, runtime, baseConfig, baseHash } = params;
  const mode = "remote" as const;

  const remoteUrl = normalizeOptionalString(opts.remoteUrl);
  if (!remoteUrl) {
    // Remote mode cannot infer a target gateway; fail before writing partial
    // remote config that would leave status/agent commands misconfigured.
    runtime.error(
      `Missing --remote-url for remote mode. Example: ${formatCliCommand("openclaw onboard --non-interactive --mode remote --remote-url ws://127.0.0.1:3000")}.`,
    );
    runtime.exit(1);
    return;
  }

  let nextConfig: OpenClawConfig = {
    ...baseConfig,
    gateway: {
      ...baseConfig.gateway,
      mode: "remote",
      remote: {
        url: remoteUrl,
        token: normalizeOptionalString(opts.remoteToken),
      },
    },
  };
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }
  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await commitNonInteractiveOnboardConfig({
    nextConfig,
    baseConfig,
    baseHash,
    reset: opts.reset,
  });
  logConfigUpdated(runtime);

  const payload = {
    mode,
    remoteUrl,
    auth: opts.remoteToken ? "token" : "none",
  };
  if (opts.json) {
    writeRuntimeJson(runtime, payload);
  } else {
    runtime.log(`Remote gateway: ${remoteUrl}`);
    runtime.log(`Auth: ${payload.auth}`);
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}
