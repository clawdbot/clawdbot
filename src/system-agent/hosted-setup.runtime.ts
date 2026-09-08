import { stat } from "node:fs/promises";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type {
  MemoryImportProviderOutcome,
  SetupMemoryImportOutcome,
} from "../wizard/setup.memory-import.js";
import { appendSystemAgentAuditEntry } from "./audit.js";

type SetupSharedModule = typeof import("../wizard/setup.shared.js");
let setupSharedPromise: Promise<SetupSharedModule> | undefined;

function loadSetupShared(): Promise<SetupSharedModule> {
  return (setupSharedPromise ??= import("../wizard/setup.shared.js"));
}

export const GATEWAY_WRITE_POLICY = {
  mode: "none",
  reason: "Gateway setup defers runtime apply until explicit restart",
} as const;

export type HostedSetupCompletion = "applied" | "kept-current";

export type HostedMemoryImportOutcome =
  | SetupMemoryImportOutcome
  | { status: "workspace-missing"; providers: []; workspace: string };

export function requireLocalGateway(config: OpenClawConfig): void {
  if (config.gateway?.mode === "local") {
    return;
  }
  throw new Error(
    "Hosted Gateway setup manages only a local Gateway. Use `openclaw onboard` for fresh setup or `openclaw configure` for the mode question, then retry after selecting local mode.",
  );
}

function createHostedWizardRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code): never => {
      throw new Error(`hosted wizard exited with code ${String(code)}`);
    },
  };
}

export async function runHostedSetup(params: {
  label: string;
  runtime?: RuntimeEnv;
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>;
  afterWrite?: import("../config/runtime-snapshot.js").ConfigWriteAfterWrite;
  run: (context: { baseConfig: OpenClawConfig; runtime: RuntimeEnv }) => Promise<
    | {
        nextConfig: OpenClawConfig;
        afterWrite?: (configPath: string) => Promise<void>;
      }
    | { keptCurrent: true }
  >;
}): Promise<HostedSetupCompletion> {
  const { readSetupConfigFileSnapshot, writeWizardConfigFile } = await loadSetupShared();
  const snapshot = await readSetupConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid || !snapshot.hash) {
    throw new Error(
      `${params.label} requires a valid saved config snapshot. On the machine running OpenClaw, run \`openclaw doctor --fix\` and resolve any remaining validation errors; then retry.`,
    );
  }
  const baseConfig = snapshot.sourceConfig ?? snapshot.config;
  const runtime = params.runtime ?? createHostedWizardRuntime(defaultRuntime);
  const result = await params.run({ baseConfig, runtime });
  if ("keptCurrent" in result) {
    return "kept-current";
  }
  await params.beforePersistentApply(runtime);
  const committed = await writeWizardConfigFile(result.nextConfig, {
    allowConfigSizeDrop: false,
    baseHash: snapshot.hash,
    ...(params.afterWrite ? { afterWrite: params.afterWrite } : {}),
  });
  await result.afterWrite?.(committed.path);
  return "applied";
}

export async function runHostedChannelSetup(
  channel: string,
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
): Promise<HostedSetupCompletion> {
  const { createChannelSetupHooks, setupChannels } =
    await import("../commands/onboard-channels.js");
  let channelSetup: ReturnType<typeof createChannelSetupHooks>;
  return await runHostedSetup({
    label: "Channel setup",
    runtime,
    beforePersistentApply,
    run: async ({ baseConfig, runtime: setupRuntime }) => {
      channelSetup = createChannelSetupHooks({
        runtime: setupRuntime,
        beforePersistentEffect: async () => await beforePersistentApply(setupRuntime),
      });
      return {
        nextConfig: await setupChannels(baseConfig, setupRuntime, prompter, {
          initialSelection: [channel],
          forceAllowFromChannels: [channel],
          allowIMessageInstall: true,
          allowSignalInstall: true,
          deferStatusUntilSelection: true,
          quickstartDefaults: true,
          skipDmPolicyPrompt: true,
          skipConfirm: true,
          beforePersistentEffect: async () => await beforePersistentApply(setupRuntime),
          onPostWriteHook: (hook) => channelSetup.onPostWriteHook(hook),
        }),
        afterWrite: async (configPath) => {
          await channelSetup.runPostWriteHooks(configPath);
        },
      };
    },
  });
}

export async function runHostedSkillsSetup(
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
): Promise<HostedSetupCompletion> {
  const [{ setupSkills }, { resolveSystemAgentOnboardingTarget }] = await Promise.all([
    import("../commands/onboard-skills.js"),
    import("../commands/onboard-agent-target.js"),
  ]);
  return await runHostedSetup({
    label: "Skills setup",
    runtime,
    beforePersistentApply,
    run: async ({ baseConfig, runtime: setupRuntime }) => ({
      nextConfig: await setupSkills(
        baseConfig,
        resolveSystemAgentOnboardingTarget(baseConfig).workspaceDir,
        setupRuntime,
        prompter,
        { beforePersistentEffect: async () => await beforePersistentApply(setupRuntime) },
      ),
    }),
  });
}

export async function runHostedSearchSetup(
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
): Promise<HostedSetupCompletion> {
  const { runSearchSetupFlow } = await import("../flows/search-setup.js");
  return await runHostedSetup({
    label: "Web search setup",
    runtime,
    beforePersistentApply,
    run: async ({ baseConfig, runtime: setupRuntime }) => {
      const result = await runSearchSetupFlow(baseConfig, setupRuntime, prompter, {
        preserveDisabledSearchState: false,
        beforePersistentEffect: async () => await beforePersistentApply(setupRuntime),
      });
      if (result.outcome === "install-failed") {
        const failure = result.reason === "timed-out" ? "timed out" : "failed";
        throw new Error(`web search provider ${result.providerId} installation ${failure}`);
      }
      if (result.outcome === "kept-current") {
        if (result.reason === "user-skipped" || result.reason === "provider-install-skipped") {
          return { keptCurrent: true };
        }
        const reason =
          result.reason === "no-providers"
            ? "no web search providers are available under the current plugin policy"
            : "the selected web search provider is no longer available";
        throw new Error(reason);
      }
      return { nextConfig: result.config };
    },
  });
}

export async function runHostedGatewaySetup(
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
): Promise<HostedSetupCompletion> {
  const [
    { resolveGatewayPort },
    { configureGatewayForSetup },
    { resolveQuickstartGatewayDefaults },
  ] = await Promise.all([
    import("../config/config.js"),
    import("../wizard/setup.gateway-config.js"),
    loadSetupShared(),
  ]);
  return await runHostedSetup({
    label: "Gateway setup",
    runtime,
    beforePersistentApply,
    afterWrite: GATEWAY_WRITE_POLICY,
    run: async ({ baseConfig, runtime: setupRuntime }) => {
      requireLocalGateway(baseConfig);
      const result = await configureGatewayForSetup({
        flow: "advanced",
        baseConfig,
        nextConfig: baseConfig,
        localPort: resolveGatewayPort(baseConfig),
        quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig),
        prompter,
        runtime: setupRuntime,
      });
      return { nextConfig: result.nextConfig };
    },
  });
}

export async function runHostedMemoryImport(
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  onProviderOutcome: (outcome: MemoryImportProviderOutcome) => void,
): Promise<HostedMemoryImportOutcome> {
  const [{ readSetupConfigFileSnapshot }, { resolveSystemAgentOnboardingTarget }] =
    await Promise.all([loadSetupShared(), import("../commands/onboard-agent-target.js")]);
  const snapshot = await readSetupConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid || !snapshot.hash) {
    throw new Error(
      "Memory import requires a valid saved config. Run `openclaw doctor --fix`, then retry.",
    );
  }
  const baseHash = snapshot.hash;
  const config = snapshot.config;
  const { agentId, workspaceDir: workspace } = resolveSystemAgentOnboardingTarget(config);
  try {
    if (!(await stat(workspace)).isDirectory()) {
      return { status: "workspace-missing", providers: [], workspace };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "workspace-missing", providers: [], workspace };
    }
    throw error;
  }

  const { runSetupMemoryImportStep } = await import("../wizard/setup.memory-import.js");
  const runtime = createHostedWizardRuntime(defaultRuntime);
  return await runSetupMemoryImportStep({
    config,
    agentId,
    prompter,
    runtime,
    beforeApply: async () => {
      await beforePersistentApply(runtime);
      const currentSnapshot = await readSetupConfigFileSnapshot();
      if (!currentSnapshot.exists || !currentSnapshot.valid || currentSnapshot.hash !== baseHash) {
        throw new Error(
          "configuration changed during memory import; nothing further was copied — retry to import against the current setup",
        );
      }
    },
    onProviderOutcome,
  });
}

type ConfirmedMemoryImportProviderOutcome = Extract<
  MemoryImportProviderOutcome,
  { migrated: number }
>;

function hasConfirmedMemoryImportCount(
  provider: MemoryImportProviderOutcome,
): provider is ConfirmedMemoryImportProviderOutcome {
  return provider.copiesIndeterminate !== true;
}

function formatItemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

function formatMemoryImportProviders(providers: ConfirmedMemoryImportProviderOutcome[]): string {
  return providers
    .map((provider) => `${provider.label} (${formatItemCount(provider.migrated)})`)
    .join(", ");
}

export async function auditMemoryImport(
  providers: MemoryImportProviderOutcome[],
  appendAuditEntry = appendSystemAgentAuditEntry,
): Promise<void> {
  const confirmedProviders = providers.filter(hasConfirmedMemoryImportCount);
  const importedProviders = confirmedProviders.filter((provider) => provider.migrated > 0);
  const indeterminateProviders = providers.filter(
    (provider) => provider.copiesIndeterminate === true,
  );
  const importedItems = importedProviders.reduce((total, provider) => total + provider.migrated, 0);
  if (importedItems === 0 && indeterminateProviders.length === 0) {
    return;
  }
  const providerSummary = formatMemoryImportProviders(importedProviders);
  const indeterminateSummary = indeterminateProviders
    .map((provider) => `${provider.label} (copy count indeterminate)`)
    .join(", ");
  const summary =
    indeterminateProviders.length > 0
      ? `Memory import failed partway via chat: ${[
          providerSummary ? `confirmed ${providerSummary}` : "",
          indeterminateSummary,
        ]
          .filter(Boolean)
          .join("; ")}`
      : `Imported memory via chat: ${providerSummary}`;
  await appendAuditEntry({
    operation: "memory.import",
    summary,
    details: {
      ...(indeterminateProviders.length > 0
        ? { confirmedItems: importedItems, copiesIndeterminate: true }
        : { totalItems: importedItems }),
      providers: providers.map((provider) =>
        provider.copiesIndeterminate === true
          ? { providerId: provider.providerId, copiesIndeterminate: true }
          : {
              providerId: provider.providerId,
              items: provider.migrated,
              ...(provider.failure ? { partial: true } : {}),
            },
      ),
    },
  });
}

export async function renderMemoryImport(
  outcome: HostedMemoryImportOutcome | undefined,
  appendAuditEntry = appendSystemAgentAuditEntry,
): Promise<string> {
  if (!outcome) {
    return "Memory import did not complete. No outcome was reported, and no success was assumed.";
  }
  if (outcome.status === "workspace-missing") {
    return [
      `Memory import is unavailable because the default agent workspace does not exist at ${outcome.workspace}.`,
      "Finish onboarding first with `openclaw onboard`, then retry.",
    ].join("\n");
  }
  if (outcome.status === "nothing-to-import") {
    return "Nothing to import — no new memory files were detected in supported local agent homes.";
  }
  if (outcome.status === "skipped") {
    return "Memory import skipped. Nothing was copied.";
  }

  const confirmedProviders = outcome.providers.filter(hasConfirmedMemoryImportCount);
  const importedProviders = confirmedProviders.filter((provider) => provider.migrated > 0);
  const failedProviders = confirmedProviders.filter((provider) => provider.failure);
  const indeterminateProviders = outcome.providers.filter(
    (provider) => provider.copiesIndeterminate === true,
  );
  const importedItems = importedProviders.reduce((total, provider) => total + provider.migrated, 0);
  const providerSummary = formatMemoryImportProviders(importedProviders);
  await auditMemoryImport(outcome.providers, appendAuditEntry);

  if (importedItems === 0) {
    if (indeterminateProviders.length > 0) {
      return [
        "Memory import failed partway. Some files may have been copied before the failure.",
        `Copy counts are indeterminate for: ${indeterminateProviders
          .map((provider) => provider.label)
          .join(", ")}.`,
      ].join("\n");
    }
    if (failedProviders.length > 0) {
      return [
        "Memory import did not complete. No files were copied.",
        `Failed providers: ${failedProviders.map((provider) => provider.label).join(", ")}.`,
      ].join("\n");
    }
    return "Nothing was imported. No files were copied.";
  }

  const sourceSummary =
    importedProviders.length === 1 ? importedProviders[0]!.label : providerSummary;
  return [
    `Imported ${formatItemCount(importedItems)} from ${sourceSummary}.`,
    indeterminateProviders.length > 0
      ? `Memory import failed partway for ${indeterminateProviders
          .map((provider) => provider.label)
          .join(", ")}; some additional files may have been copied before the failure.`
      : failedProviders.length > 0
        ? `Some providers did not complete: ${failedProviders
            .map((provider) => provider.label)
            .join(", ")}.`
        : "",
  ]
    .filter(Boolean)
    .join("\n");
}
