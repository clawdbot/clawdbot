import { formatCliCommand } from "../cli/command-format.js";
import { replaceConfigFile } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { logConfigUpdated } from "../config/logging.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runNonInteractiveLocalSetup } from "./onboard-non-interactive/local.js";
import { runNonInteractiveRemoteSetup } from "./onboard-non-interactive/remote.js";
import type { OnboardOptions } from "./onboard-types.js";

function createNonInteractiveMigrationPrompter(runtime: RuntimeEnv): WizardPrompter {
  const unavailable = <T>(message: string): Promise<T> =>
    Promise.reject(
      new Error(
        `Non-interactive migration import needs explicit flags before prompting: ${message}`,
      ),
    );
  return {
    async intro(title) {
      runtime.log(title);
    },
    async outro(message) {
      runtime.log(message);
    },
    async note(message, title) {
      runtime.log(title ? `${title}\n${message}` : message);
    },
    select(params) {
      return unavailable(params.message);
    },
    multiselect(params) {
      return unavailable(params.message);
    },
    text(params) {
      return unavailable(params.message);
    },
    confirm(params) {
      return unavailable(params.message);
    },
    progress(label) {
      runtime.log(label);
      return {
        update(message) {
          runtime.log(message);
        },
        stop(message) {
          if (message) {
            runtime.log(message);
          }
        },
      };
    },
  };
}

async function runNonInteractiveMigrationImport(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  baseHash?: string;
}) {
  const providerId = params.opts.importFrom?.trim();
  if (!providerId) {
    params.runtime.error("--import-from is required for non-interactive migration import.");
    params.runtime.exit(1);
    return;
  }
  const { detectSetupMigrationSources, runSetupMigrationImport } =
    await import("../wizard/setup.migration-import.js");
  const detections = await detectSetupMigrationSources({
    config: params.baseConfig,
    runtime: params.runtime,
  });
  await runSetupMigrationImport({
    opts: { ...params.opts, importFrom: providerId, nonInteractive: true },
    baseConfig: params.baseConfig,
    detections,
    prompter: createNonInteractiveMigrationPrompter(params.runtime),
    runtime: params.runtime,
    async commitConfigFile(config) {
      await replaceConfigFile({
        nextConfig: config,
        ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
        writeOptions: { allowConfigSizeDrop: true },
      });
      logConfigUpdated(params.runtime);
      return config;
    },
  });
}

export async function runNonInteractiveSetup(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    runtime.error(
      `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`,
    );
    runtime.exit(1);
    return;
  }

  const baseConfig: OpenClawConfig = snapshot.valid
    ? snapshot.exists
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {}
    : {};
  const mode = opts.mode ?? "local";
  if (mode !== "local" && mode !== "remote") {
    runtime.error(`Invalid --mode "${String(mode)}" (use local|remote).`);
    runtime.exit(1);
    return;
  }

  if (opts.importFrom || opts.importSource || opts.importSecrets || opts.flow === "import") {
    await runNonInteractiveMigrationImport({ opts, runtime, baseConfig, baseHash: snapshot.hash });
    return;
  }

  if (mode === "remote") {
    await runNonInteractiveRemoteSetup({ opts, runtime, baseConfig, baseHash: snapshot.hash });
    return;
  }

  await runNonInteractiveLocalSetup({ opts, runtime, baseConfig, baseHash: snapshot.hash });
}
