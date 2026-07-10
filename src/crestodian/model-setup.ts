import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
// Crestodian model setup reuses the onboarding provider/auth step and config writer.
import { transformConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { mergeWizardConfigOntoLatest } from "../wizard/setup.shared.js";
import { appendCrestodianAuditEntry } from "./audit.js";

export type CrestodianModelSetupResult = {
  model?: string;
};

export async function runCrestodianModelSetup(params: {
  workspace?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<CrestodianModelSetupResult> {
  const [{ DEFAULT_WORKSPACE }, { readSetupConfigFileSnapshot }] = await Promise.all([
    import("../commands/onboard-helpers.js"),
    import("../wizard/setup.shared.js"),
  ]);
  const before = await readSetupConfigFileSnapshot();
  if (before.exists && !before.valid) {
    throw new Error("openclaw.json is invalid; run `openclaw doctor` before model setup");
  }
  const baseConfig = before.exists ? (before.sourceConfig ?? before.config) : {};
  const workspace = resolveUserPath(
    params.workspace?.trim() || baseConfig.agents?.defaults?.workspace?.trim() || DEFAULT_WORKSPACE,
  );

  const { runSetupModelAuthStep } = await import("../wizard/setup.model-auth.js");
  const nextConfig = await runSetupModelAuthStep({
    config: baseConfig,
    opts: {},
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: workspace,
  });
  const committed = await transformConfigWithPendingPluginInstalls({
    afterWrite: { mode: "auto" },
    writeOptions: { allowConfigSizeDrop: false },
    transform: (currentConfig, context) => {
      if (!context.snapshot.valid) {
        throw new Error("openclaw.json became invalid during model setup; run `openclaw doctor`");
      }
      return {
        nextConfig: mergeWizardConfigOntoLatest(currentConfig, baseConfig, nextConfig),
      };
    },
  });
  const model = resolveAgentModelPrimaryValue(committed.nextConfig.agents?.defaults?.model);

  await appendCrestodianAuditEntry({
    operation: "models.setup",
    summary: model ? `Configured model provider with ${model}` : "Ran model provider setup",
    configPath: committed.path,
    configHashBefore: committed.previousHash,
    configHashAfter: committed.persistedHash,
    details: {
      workspace,
      ...(model ? { model } : {}),
    },
  });

  return model ? { model } : {};
}
