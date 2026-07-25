// Setup inference verification owns the shared verify/repair loop used by onboarding imports.
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { runSetupModelAuthStep, type SetupModelAuthCandidate } from "./setup.model-auth.js";

export async function offerLiveModelVerification(params: {
  config: OpenClawConfig;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
  agentDir?: string;
  stateDir?: string;
  writeConfig: (config: OpenClawConfig) => Promise<OpenClawConfig>;
  required?: boolean;
}): Promise<{ config: OpenClawConfig; verified: boolean; modelRef?: string }> {
  if (!params.required) {
    const shouldTest = await params.prompter.confirm({
      message: t("wizard.setup.testAiAccess"),
      initialValue: true,
    });
    if (!shouldTest) {
      return { config: params.config, verified: false };
    }
  }
  const [inference, authStore, agentDatabase] = await Promise.all([
    import("../system-agent/setup-inference.js"),
    import("../agents/auth-profiles/store.js"),
    import("../state/openclaw-agent-db.js"),
  ]);
  const stagedEnv = params.stateDir
    ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir }
    : undefined;
  const verify = async (candidate: SetupModelAuthCandidate) => {
    const progress = params.prompter.progress(t("wizard.setup.testAiProgress"));
    const result = await withConsoleSubsystemsSuppressed(() =>
      inference.verifySetupInferenceConfig({
        config: candidate.config,
        runtime: params.runtime,
        authProfiles: candidate.authProfiles,
        ...(params.agentDir ? { agentDir: params.agentDir } : {}),
        ...(params.stateDir
          ? {
              deps: {
                updateAuthProfileStoreWithLock: async (updateParams) =>
                  await authStore.updateAuthProfileStoreWithLock({
                    ...updateParams,
                    stateDir: params.stateDir,
                  }),
                disposeOpenClawAgentDatabaseByPath: (pathname) =>
                  agentDatabase.disposeOpenClawAgentDatabaseByPath(pathname, {
                    env: stagedEnv!,
                  }),
              },
            }
          : {}),
      }),
    );
    progress.stop();
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

  let candidate: SetupModelAuthCandidate = {
    config: params.config,
    authProfiles: [],
    persistAuthProfiles: async () => {},
  };
  let shouldPersistCandidate = false;
  while (true) {
    const result = await verify(candidate);
    if (result.ok) {
      if (!shouldPersistCandidate) {
        return { config: params.config, verified: true, modelRef: result.modelRef };
      }
      await candidate.persistAuthProfiles(result.authProfiles);
      const config = await params.writeConfig(candidate.config);
      return { config, verified: true, modelRef: result.modelRef };
    }
    if (result.authProfiles) {
      candidate.authProfiles = result.authProfiles;
    }
    if (params.opts.nonInteractive) {
      return { config: params.config, verified: false };
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
      return { config: params.config, verified: false };
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
