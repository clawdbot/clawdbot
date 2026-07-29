// Qa Lab plugin module implements live transport cli behavior.
import type { Command } from "commander";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { DEFAULT_QA_LIVE_PROVIDER_MODE, formatQaProviderModeHelp } from "../../providers/index.js";

export type LiveTransportQaCommandOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: string;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  allowFailures?: boolean;
  failFast?: boolean;
  profile?: string;
  scenarioIds?: string[];
  listScenarios?: boolean;
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
};

type LiveTransportQaCommanderOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: string;
  model?: string;
  altModel?: string;
  scenario?: string[];
  listScenarios?: boolean;
  fast?: boolean;
  allowFailures?: boolean;
  failFast?: boolean;
  profile?: string;
  sutAccount?: string;
  credentialSource?: string;
  credentialRole?: string;
};

export type LiveTransportQaCliRegistration = QaRunnerCliRegistration;

type LiveTransportQaCliRegistrationOptions = {
  commandName: string;
  credentialOptions?: {
    sourceDescription?: string;
    roleDescription?: string;
  };
  defaultProviderMode: string;
  description: string;
  providerModeHelp: string;
  listScenariosHelp?: string;
  outputDirHelp: string;
  profileHelp?: string;
  failFastHelp?: string;
  allowFailuresHelp?: string;
  scenarioHelp: string;
  sutAccountHelp: string;
  adapterFactory?: QaRunnerCliRegistration["adapterFactory"];
  run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
};

export function createLazyCliRuntimeLoader<T>(load: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  return async () => {
    promise ??= load();
    return await promise;
  };
}

function collectStringOption(value: string, previous: string[]) {
  const trimmed = value.trim();
  return trimmed ? [...previous, trimmed] : previous;
}

function mapCommanderOptions(opts: LiveTransportQaCommanderOptions): LiveTransportQaCommandOptions {
  return {
    repoRoot: opts.repoRoot,
    outputDir: opts.outputDir,
    providerMode: opts.providerMode,
    primaryModel: opts.model,
    alternateModel: opts.altModel,
    fastMode: opts.fast,
    allowFailures: opts.allowFailures,
    failFast: opts.failFast,
    profile: opts.profile,
    scenarioIds: opts.scenario,
    listScenarios: opts.listScenarios,
    sutAccountId: opts.sutAccount,
    credentialSource: opts.credentialSource,
    credentialRole: opts.credentialRole,
  };
}

function createSharedLiveTransportQaCliRegistration(
  params: LiveTransportQaCliRegistrationOptions,
): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    adapterFactory: params.adapterFactory,
    register(qa: Command) {
      const command = qa
        .command(params.commandName)
        .description(params.description)
        .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
        .option("--output-dir <path>", params.outputDirHelp)
        .option("--provider-mode <mode>", params.providerModeHelp, params.defaultProviderMode)
        .option("--model <ref>", "Primary provider/model ref")
        .option("--alt-model <ref>", "Alternate provider/model ref")
        .option("--scenario <id>", params.scenarioHelp, collectStringOption, [])
        .option("--fast", "Enable provider fast mode where supported", false);

      if (params.allowFailuresHelp) {
        command.option("--allow-failures", params.allowFailuresHelp, false);
      }
      command.option("--sut-account <id>", params.sutAccountHelp, "sut");
      if (params.listScenariosHelp) {
        command.option("--list-scenarios", params.listScenariosHelp, false);
      }
      if (params.profileHelp) {
        command.option("--profile <profile>", params.profileHelp);
      }
      if (params.failFastHelp) {
        command.option("--fail-fast", params.failFastHelp, false);
      }
      if (params.credentialOptions) {
        command.option(
          "--credential-source <source>",
          params.credentialOptions.sourceDescription ??
            "Credential source for live lanes: env or convex (default: env)",
        );
        if (params.credentialOptions.roleDescription) {
          command.option("--credential-role <role>", params.credentialOptions.roleDescription);
        }
      }
      command.action(async (opts: LiveTransportQaCommanderOptions) => {
        await params.run(mapCommanderOptions(opts));
      });
    },
  };
}

// All dedicated commands share one memoized import of the consolidated suite host.
export const loadLiveTransportQaSuiteRuntime = createLazyCliRuntimeLoader<
  typeof import("./live-transport-suite.runtime.js")
>(() => import("./live-transport-suite.runtime.js"));

type QaLabLiveTransportQaCliRegistrationOptions = Omit<
  LiveTransportQaCliRegistrationOptions,
  "allowFailuresHelp" | "defaultProviderMode" | "providerModeHelp"
> & {
  defaultProviderMode?: LiveTransportQaCliRegistrationOptions["defaultProviderMode"];
};

export function createLiveTransportQaCliRegistration(
  params: QaLabLiveTransportQaCliRegistrationOptions,
) {
  return createSharedLiveTransportQaCliRegistration({
    ...params,
    allowFailuresHelp: "Write artifacts without setting a failing exit code when scenarios fail",
    defaultProviderMode: params.defaultProviderMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
    providerModeHelp: formatQaProviderModeHelp(),
  });
}

export function createLiveTransportQaAdapterFactory(params: {
  create: NonNullable<LiveTransportQaCliRegistrationOptions["adapterFactory"]>["create"];
  id: string;
  isolatesInstances?: boolean;
}): NonNullable<LiveTransportQaCliRegistrationOptions["adapterFactory"]> {
  return {
    id: params.id,
    isolatesInstances: params.isolatesInstances,
    matches: ({ channelId, driver }) => driver === "live" && channelId === params.id,
    create: params.create,
  };
}
