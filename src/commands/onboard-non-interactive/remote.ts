import type { ClawdbotConfig } from "../../config/config.js";
import { CONFIG_PATH_CLAWDBOT, writeConfigFile } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { applyWizardMetadata } from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";

export async function runNonInteractiveOnboardingRemote(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: ClawdbotConfig;
}) {
  const { opts, runtime, baseConfig } = params;
  const mode = "remote" as const;

  const remoteUrl = opts.remoteUrl?.trim();
  if (!remoteUrl) {
    runtime.error("Missing --remote-url for remote mode.");
    runtime.exit(1);
    return;
  }

  let nextConfig: ClawdbotConfig = {
    ...baseConfig,
    gateway: {
      ...baseConfig.gateway,
      mode: "remote",
      remote: {
        url: remoteUrl,
        token: opts.remoteToken?.trim() || undefined,
      },
    },
  };
  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

  const payload = {
    mode,
    remoteUrl,
    auth: opts.remoteToken ? "token" : "none",
  };
  if (opts.json) {
    runtime.log(JSON.stringify(payload, null, 2));
  } else {
    runtime.log(`Remote gateway: ${remoteUrl}`);
    runtime.log(`Auth: ${payload.auth}`);
    runtime.log(
      "Tip: run `clawdbot configure --section web` to store your Brave API key for web_search. Docs: https://docs.clawd.bot/tools/web",
    );
  }
}
