// Setup inference verification owns the shared verify/repair loop used by onboarding imports.
import type { OnboardOptions } from "../commands/onboard-types.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { runSetupModelAuthStep, type SetupModelAuthCandidate } from "./setup.model-auth.js";

export async function offerLiveModelVerification(params: {
  config: OpenClawConfig;
  initialCandidate?: SetupModelAuthCandidate;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
  agentDir?: string;
  stateDir?: string;
  writeConfig: (config: OpenClawConfig) => Promise<OpenClawConfig>;
  required?: boolean;
}): Promise<{
  config: OpenClawConfig;
  attempted: boolean;
  persisted: boolean;
  verified: boolean;
  modelRef?: string;
}> {
  if (!params.required) {
    const shouldTest = await params.prompter.confirm({
      message: t("wizard.setup.testAiAccess"),
      initialValue: true,
    });
    if (!shouldTest) {
      return { config: params.config, attempted: false, persisted: false, verified: false };
    }
  }
  const inference = await import("../system-agent/setup-inference.js");
  // Sign-in saves the credential; the turn only confirms the route it produced.
  const verify = async (candidate: SetupModelAuthCandidate) => {
    await candidate.persistAuthProfiles();
    const progress = params.prompter.progress(t("wizard.setup.testAiProgress"));
    const verification = withConsoleSubsystemsSuppressed(() =>
      inference.verifySetupInferenceConfig({
        // SAFETY: Canonical roster migration preserves typed config; this runtime view is never persisted.
        config: migratePersistedImplicitMainRoster(candidate.config).config as OpenClawConfig,
        runtime: params.runtime,
      }),
    );
    let result: Awaited<typeof verification>;
    try {
      result = await verification;
    } finally {
      progress.stop();
    }
    if (result.ok) {
      await params.prompter.note(
        t("wizard.setup.testAiSuccess", { seconds: (result.latencyMs / 1000).toFixed(1) }),
        t("wizard.setup.testAiTitle"),
      );
    } else {
      await params.prompter.note(
        t("wizard.setup.testAiFailure", { reason: result.error }),
        t("wizard.setup.testAiTitle"),
      );
    }
    return result;
  };

  let candidate: SetupModelAuthCandidate =
    params.initialCandidate ??
    ({
      config: params.config,
      authProfiles: [],
      persistAuthProfiles: async () => {},
    } satisfies SetupModelAuthCandidate);
  let shouldPersistCandidate = params.initialCandidate !== undefined;
  while (true) {
    const result = await verify(candidate);
    if (result.ok) {
      if (!shouldPersistCandidate) {
        return {
          config: params.config,
          attempted: true,
          persisted: false,
          verified: true,
          modelRef: result.modelRef,
        };
      }
      const config = await params.writeConfig(candidate.config);
      return {
        config,
        attempted: true,
        persisted: true,
        verified: true,
        modelRef: result.modelRef,
      };
    }
    if (params.opts.nonInteractive) {
      return { config: params.config, attempted: true, persisted: false, verified: false };
    }
    if (
      !params.required &&
      (await params.prompter.select({
        message: t("wizard.setup.testAiFailureChoice"),
        options: [
          { value: "fix", label: t("wizard.setup.testAiFix") },
          { value: "continue", label: t("wizard.setup.testAiContinue") },
        ],
      })) === "continue"
    ) {
      return { config: params.config, attempted: true, persisted: false, verified: false };
    }

    candidate = await runSetupModelAuthStep({
      config: params.config,
      stagedCandidate: candidate,
      opts: { ...params.opts, authChoice: undefined },
      prompter: params.prompter,
      runtime: params.runtime,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    });
    shouldPersistCandidate = true;
  }
}
