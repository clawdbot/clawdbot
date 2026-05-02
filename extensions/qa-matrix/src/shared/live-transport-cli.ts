import type { Command } from "commander";
import { collectString } from "../cli-options.js";
import type { QaProviderModeInput } from "../run-config.js";

export type LiveTransportQaCommandOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  failFast?: boolean;
  profile?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
};

type LiveTransportQaCommanderOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  model?: string;
  altModel?: string;
  scenario?: string[];
  fast?: boolean;
  failFast?: boolean;
  profile?: string;
  sutAccount?: string;
  credentialSource?: string;
  credentialRole?: string;
};

export type LiveTransportQaCliRegistration = {
  commandName: string;
  register(qa: Command): void;
};

type LiveTransportQaCredentialCliOptions = {
  sourceDescription?: string;
  roleDescription?: string;
};

export function createLazyCliRuntimeLoader<T>(load: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  return async () => {
    promise ??= load();
    return await promise;
  };
}

function mapLiveTransportQaCommanderOptions(
  opts: LiveTransportQaCommanderOptions,
): LiveTransportQaCommandOptions {
  return {
    repoRoot: opts.repoRoot,
    outputDir: opts.outputDir,
    providerMode: opts.providerMode,
    primaryModel: opts.model,
    alternateModel: opts.altModel,
    fastMode: opts.fast,
    failFast: opts.failFast,
    profile: opts.profile,
    scenarioIds: opts.scenario,
    sutAccountId: opts.sutAccount,
    credentialSource: opts.credentialSource,
    credentialRole: opts.credentialRole,
  };
}

function registerLiveTransportQaCli(params: {
  qa: Command;
  commandName: string;
  credentialOptions?: LiveTransportQaCredentialCliOptions;
  description: string;
  outputDirHelp: string;
  profileHelp?: string;
  failFastHelp?: string;
  scenarioHelp: string;
  sutAccountHelp: string;
  run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
}) {
  const command = params.qa
    .command(params.commandName)
    .description(params.description)
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", params.outputDirHelp)
    .option(
      "--provider-mode <mode>",
      "Provider mode: mock-openai or live-frontier (legacy live-openai still works)",
      "live-frontier",
    )
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option("--scenario <id>", params.scenarioHelp, collectString, [])
    .option("--fast", "Enable provider fast mode where supported", false)
    .option("--sut-account <id>", params.sutAccountHelp, "sut");

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
    await params.run(mapLiveTransportQaCommanderOptions(opts));
  });
}

export function createLiveTransportQaCliRegistration(params: {
  commandName: string;
  credentialOptions?: LiveTransportQaCredentialCliOptions;
  description: string;
  outputDirHelp: string;
  profileHelp?: string;
  failFastHelp?: string;
  scenarioHelp: string;
  sutAccountHelp: string;
  run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
}): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    register(qa: Command) {
      registerLiveTransportQaCli({
        qa,
        commandName: params.commandName,
        credentialOptions: params.credentialOptions,
        description: params.description,
        outputDirHelp: params.outputDirHelp,
        profileHelp: params.profileHelp,
        failFastHelp: params.failFastHelp,
        scenarioHelp: params.scenarioHelp,
        sutAccountHelp: params.sutAccountHelp,
        run: params.run,
      });
    },
  };
}
