import { formatCliCommand } from "../../cli/command-format.js";
import { replaceConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { applySkipBootstrapConfig } from "../onboard-config.js";
import { applyWizardMetadata } from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";

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
  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
    writeOptions: { allowConfigSizeDrop: true },
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
