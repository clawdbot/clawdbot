// Implements `openclaw agents add`, including config mutation, workspace setup, auth copy, and route binding setup.
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  checkAgentCreationGate,
  createAgent,
  validateAgentIdInput,
} from "../agents/agent-create.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  buildPortableAuthProfileStoreForAgentCopy,
  ensureAuthProfileStore,
  persistAuthProfileBatch,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { AuthProfileStoreUnreadableError } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import { logConfigUpdated } from "../config/logging.js";
import { createChannelSetupTransaction } from "../flows/channel-setup.js";
import {
  commitConfigWithPendingPluginInstalls,
  transformConfigWithPendingPluginInstalls,
} from "../plugins/install-record-commit.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { applyAgentBindings, buildChannelBindings, describeBinding } from "./agents.bindings.js";
import { applyAgentConfig, listAgentEntries } from "./agents.config.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { prepareAuthChoice, warnIfModelConfigLooksOff } from "./auth-choice.js";
import { requireValidConfigFileSnapshot } from "./config-validation.js";
import {
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
} from "./onboard-agent-target.js";
import { setupChannels } from "./onboard-channels.js";
import type { ChannelChoice } from "./onboard-types.js";

type AgentsAddOptions = {
  name?: string;
  workspace?: string;
  model?: string;
  agentDir?: string;
  bind?: string[];
  nonInteractive?: boolean;
  json?: boolean;
};

type AgentBindingResult = ReturnType<typeof applyAgentBindings>;

function emptyBindingResult(config: Parameters<typeof applyAgentBindings>[0]): AgentBindingResult {
  return { config, added: [], updated: [], skipped: [], conflicts: [] };
}

function loadReadablePersistedAuthProfileStore(agentDir: string): AuthProfileStore | null {
  const store = loadPersistedAuthProfileStore(agentDir);
  if (!store && inspectPersistedAuthProfileStoreRaw(agentDir).status !== "missing") {
    throw new AuthProfileStoreUnreadableError(agentDir);
  }
  return store;
}

function hasOAuthProfiles(store: AuthProfileStore, profileIds: readonly string[]): boolean {
  return profileIds.some((profileId) => store.profiles[profileId]?.type === "oauth");
}

function formatSkippedOAuthProfilesMessage(
  sourceAgentId: string,
  sourceIsInheritedMain: boolean,
): string {
  return sourceIsInheritedMain
    ? `OAuth profiles stay shared from "${sourceAgentId}" unless this agent signs in separately.`
    : `OAuth profiles were not copied from "${sourceAgentId}"; sign in separately for this agent.`;
}

/** Create or update an agent through the non-interactive path or guided wizard. */
export async function agentsAddCommand(
  opts: AgentsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasAutomationFlags?: boolean },
) {
  const hasAutomationFlags = params?.hasAutomationFlags === true;
  const nonInteractive = opts.nonInteractive === true || hasAutomationFlags;
  const wizardOutput = opts.json ? process.stderr : process.stdout;
  if (!nonInteractive && !isTerminalInteractive(wizardOutput)) {
    runtime.error(
      `Agent creation needs an interactive TTY. Use \`${formatCliCommand("openclaw agents add <id> --non-interactive --workspace <dir>")}\` for automation.`,
    );
    runtime.exit(1);
    return;
  }

  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
  const baseHash = configSnapshot.hash;

  const workspaceFlag = opts.workspace?.trim();
  const nameInput = opts.name?.trim();

  if (nonInteractive) {
    if (!workspaceFlag) {
      runtime.error(
        `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
      );
      runtime.exit(1);
      return;
    }
    if (!nameInput) {
      runtime.error(
        `Agent name is required in non-interactive mode. Run ${formatCliCommand("openclaw agents add <id> --workspace <path>")}.`,
      );
      runtime.exit(1);
      return;
    }
    const validation = validateAgentIdInput(nameInput);
    if (!validation.ok) {
      runtime.error(
        validation.reason === "reserved-id"
          ? `"${validation.agentId}" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`
          : validation.message,
      );
      runtime.exit(1);
      return;
    }
    const agentId = validation.agentId;
    if (agentId !== nameInput) {
      runtime.log(`Normalized agent id to "${agentId}".`);
    }

    const created = await withPluginLifecycleLease({}, async () => {
      return await createAgent({
        name: nameInput,
        workspace: workspaceFlag,
        ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.bind?.length ? { bindingSpecs: opts.bind } : {}),
        transformConfig: transformConfigWithPendingPluginInstalls,
      });
    });
    if (created.status === "error") {
      runtime.error(
        created.reason === "reserved-id"
          ? `"${created.agentId}" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`
          : created.reason === "already-exists"
            ? `Agent "${created.agentId}" already exists.`
            : created.message,
      );
      runtime.exit(1);
      return;
    }

    const bindingResult = created.bindingResult ?? emptyBindingResult(cfg);
    if (!opts.json) {
      logConfigUpdated(runtime);
    }

    const payload = {
      agentId: created.agentId,
      name: created.name,
      workspace: created.workspace,
      agentDir: created.agentDir,
      model: created.model,
      bindings: {
        added: bindingResult.added.map(describeBinding),
        updated: bindingResult.updated.map(describeBinding),
        skipped: bindingResult.skipped.map(describeBinding),
        conflicts: bindingResult.conflicts.map(
          (conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
        ),
      },
    };
    if (opts.json) {
      writeRuntimeJson(runtime, payload);
    } else {
      runtime.log(`Agent: ${agentId}`);
      runtime.log(`Workspace: ${shortenHomePath(created.workspace)}`);
      runtime.log(`Agent dir: ${shortenHomePath(created.agentDir)}`);
      if (created.model) {
        runtime.log(`Model: ${created.model}`);
      }
      if (bindingResult.conflicts.length > 0) {
        runtime.error(
          [
            "Skipped bindings already claimed by another agent:",
            ...bindingResult.conflicts.map(
              (conflict) =>
                `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
            ),
          ].join("\n"),
        );
      }
    }
    return;
  }

  const prompter = createClackPrompter(wizardOutput);
  const wizardRuntime: RuntimeEnv = opts.json
    ? { ...runtime, log: (...args) => runtime.error(...args) }
    : runtime;
  try {
    await prompter.intro("Add OpenClaw agent");
    const name =
      nameInput ??
      (await prompter.text({
        message: "Agent name",
        validate: (value) => {
          if (!value?.trim()) {
            return "Required";
          }
          const validation = validateAgentIdInput(value);
          if (!validation.ok) {
            return validation.reason === "reserved-id"
              ? `"${validation.agentId}" is reserved. Choose another name.`
              : validation.message;
          }
          return undefined;
        },
      }));

    const agentName = normalizeOptionalString(name) ?? "";
    const validation = validateAgentIdInput(agentName);
    if (!validation.ok) {
      if (validation.reason === "reserved-id") {
        await prompter.outro(`"${validation.agentId}" is reserved. Choose another name.`);
        return;
      }
      await prompter.outro(validation.message);
      return;
    }
    const agentId = validation.agentId;
    if (agentName !== agentId) {
      await prompter.note(`Normalized id to "${agentId}".`, "Agent id");
    }

    const existingAgent = listAgentEntries(cfg).find(
      (agent) => normalizeAgentId(agent.id) === agentId,
    );
    if (existingAgent) {
      const shouldUpdate = await prompter.confirm({
        message: `Agent "${agentId}" already exists. Update it?`,
        initialValue: false,
      });
      if (!shouldUpdate) {
        await prompter.outro("No changes made.");
        return;
      }
    } else {
      const gateError = await checkAgentCreationGate(agentId);
      if (gateError) {
        await prompter.outro(gateError.message);
        return;
      }
    }

    const workspaceDefault = resolveAgentWorkspaceDir(cfg, agentId);
    const workspaceInput = await prompter.text({
      message: "Workspace directory",
      initialValue: workspaceDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    const workspaceDir = resolveUserPath(
      normalizeOptionalString(workspaceInput) || workspaceDefault,
    );
    const agentDir = resolveAgentDir(cfg, agentId);

    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
    });
    const stagedAuthProfiles: Array<
      Parameters<typeof persistAuthProfileBatch>[0]["profiles"][number]
    > = [];
    let stagedAuthOrder: AuthProfileStore["order"];
    let reportPortableAuthCopy: (() => Promise<void>) | undefined;

    const defaultAgentId = resolveDefaultAgentId(cfg);
    if (defaultAgentId !== agentId) {
      const sourceAgentDir = resolveAgentDir(cfg, defaultAgentId);
      const sourceAuthPath = resolveAuthProfileDatabasePath(sourceAgentDir);
      const destAuthPath = resolveAuthProfileDatabasePath(agentDir);
      const sharedMainAgentPath = resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir());
      const sameAuthPath =
        normalizeLowercaseStringOrEmpty(path.resolve(sourceAuthPath)) ===
        normalizeLowercaseStringOrEmpty(path.resolve(destAuthPath));
      const sourceIsInheritedMain =
        normalizeLowercaseStringOrEmpty(path.resolve(sourceAuthPath)) ===
        normalizeLowercaseStringOrEmpty(path.resolve(sharedMainAgentPath));
      if (!sameAuthPath) {
        const sourceStore = sourceIsInheritedMain
          ? loadAuthProfileStoreWithoutExternalProfiles(sourceAgentDir)
          : loadReadablePersistedAuthProfileStore(sourceAgentDir);
        const destStore = loadReadablePersistedAuthProfileStore(agentDir);
        const portable = sourceStore
          ? buildPortableAuthProfileStoreForAgentCopy(sourceStore)
          : undefined;
        const skippedOAuthProfiles =
          sourceStore && portable
            ? hasOAuthProfiles(sourceStore, portable.skippedProfileIds)
            : false;
        if (
          sourceStore &&
          portable &&
          portable.copiedProfileIds.length > 0 &&
          Object.keys(destStore?.profiles ?? {}).length === 0
        ) {
          const shouldCopy = await prompter.confirm({
            message: `Copy portable auth profiles from "${defaultAgentId}"?`,
            initialValue: false,
          });
          if (shouldCopy) {
            const copiedProfileIds = portable.copiedProfileIds;
            const copiedOAuthProfileIds = copiedProfileIds.filter(
              (profileId) => sourceStore.profiles[profileId]?.type === "oauth",
            );
            const sourceAgentId = defaultAgentId;
            const sourceInheritedMain = sourceIsInheritedMain;
            const destinationAgentDir = agentDir;
            for (const [profileId, credential] of Object.entries(portable.store.profiles)) {
              stagedAuthProfiles.push({ profileId, credential, replaceExisting: false });
            }
            stagedAuthOrder = portable.store.order;
            reportPortableAuthCopy = async () => {
              const persisted = loadPersistedAuthProfileStore(destinationAgentDir);
              const persistedIds = new Set(Object.keys(persisted?.profiles ?? {}));
              const copiedCount = copiedProfileIds.filter((profileId) =>
                persistedIds.has(profileId),
              ).length;
              const skippedOAuth =
                skippedOAuthProfiles ||
                copiedOAuthProfileIds.some((profileId) => !persistedIds.has(profileId));
              const copied = copiedCount
                ? `Copied ${copiedCount} portable auth profile${copiedCount === 1 ? "" : "s"} from "${sourceAgentId}".`
                : "";
              const skipped = skippedOAuth
                ? ` ${formatSkippedOAuthProfilesMessage(sourceAgentId, sourceInheritedMain)}`
                : "";
              await prompter.note(`${copied}${skipped}`.trim(), "Auth profiles");
            };
          }
        } else if (skippedOAuthProfiles) {
          const sourceAgentId = defaultAgentId;
          const sourceInheritedMain = sourceIsInheritedMain;
          reportPortableAuthCopy = async () => {
            await prompter.note(
              formatSkippedOAuthProfilesMessage(sourceAgentId, sourceInheritedMain),
              "Auth profiles",
            );
          };
        }
      }
    }

    const wantsAuth = await prompter.confirm({
      message: "Configure model/auth for this agent now?",
      initialValue: false,
    });
    if (wantsAuth) {
      const authStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });
      while (true) {
        const authChoice = await promptAuthChoiceGrouped({
          prompter,
          store: authStore,
          includeSkip: true,
          config: nextConfig,
        });

        const authResult = await prepareAuthChoice({
          authChoice,
          config: nextConfig,
          prompter,
          runtime: wizardRuntime,
          agentDir,
          setDefaultModel: false,
          agentId,
        });
        nextConfig = authResult.config;
        if (authResult.retrySelection) {
          continue;
        }
        stagedAuthProfiles.push(...authResult.authProfiles);
        if (authResult.agentModelOverride) {
          nextConfig = applyAgentConfig(nextConfig, {
            agentId,
            model: authResult.agentModelOverride,
          });
        }
        break;
      }
    }

    await warnIfModelConfigLooksOff(nextConfig, prompter, {
      agentId,
      agentDir,
      pendingAuthProfiles: stagedAuthProfiles.map(({ profileId, credential }) => ({
        profileId,
        credential,
      })),
      validateCatalog: false,
    });

    const channelSetup = createChannelSetupTransaction({ runtime: wizardRuntime });
    let selection: ChannelChoice[] = [];
    const channelAccountIds: Partial<Record<ChannelChoice, string>> = {};
    nextConfig = await setupChannels(nextConfig, wizardRuntime, prompter, {
      allowIMessageInstall: true,
      allowSignalInstall: true,
      onSelection: (value) => {
        selection = value;
      },
      promptAccountIds: true,
      onAccountId: (channel, accountId) => {
        channelAccountIds[channel] = accountId;
      },
      onPostWriteHook: channelSetup.onPostWriteHook,
    });

    if (selection.length > 0) {
      const wantsBindings = await prompter.confirm({
        message: "Route selected channels to this agent now? (bindings)",
        initialValue: false,
      });
      if (wantsBindings) {
        const desiredBindings = buildChannelBindings({
          agentId,
          selection,
          config: nextConfig,
          accountIds: channelAccountIds,
        });
        const result = applyAgentBindings(nextConfig, desiredBindings);
        nextConfig = result.config;
        if (result.conflicts.length > 0) {
          await prompter.note(
            [
              "Skipped bindings already claimed by another agent:",
              ...result.conflicts.map(
                (conflict) =>
                  `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
              ),
            ].join("\n"),
            "Routing bindings",
          );
        }
      } else {
        await prompter.note(
          [
            "Routing unchanged. Add bindings when you're ready.",
            "Docs: https://docs.openclaw.ai/concepts/multi-agent",
          ].join("\n"),
          "Routing",
        );
      }
    }

    const stagedEntry = existingAgent
      ? undefined
      : listAgentEntries(nextConfig).find(
          (candidate) => normalizeAgentId(candidate.id) === agentId,
        );
    const stagedAuthBatch =
      stagedAuthProfiles.length > 0
        ? {
            profiles: stagedAuthProfiles,
            ...(stagedAuthOrder ? { order: stagedAuthOrder } : {}),
            agentDir,
          }
        : undefined;

    let payload: { agentId: string; name: string; workspace: string; agentDir: string };
    if (existingAgent) {
      const target = resolveOnboardingAgentTarget(nextConfig, agentId);
      await ensureOnboardingAgentWorkspace(target, wizardRuntime, {
        skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
        skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
      });
      const authPersistence = stagedAuthBatch
        ? await persistAuthProfileBatch(stagedAuthBatch)
        : undefined;
      try {
        nextConfig = await channelSetup.commit(nextConfig, async (configToCommit) => {
          const committed = await commitConfigWithPendingPluginInstalls({
            nextConfig: configToCommit,
            ...(baseHash !== undefined ? { baseHash } : {}),
          });
          return committed.config;
        });
      } catch (error) {
        authPersistence?.rollback();
        throw error;
      }
      payload = {
        agentId: target.agentId,
        name: agentName,
        workspace: target.workspaceDir,
        agentDir: target.agentDir,
      };
    } else {
      if (!stagedEntry) {
        throw new Error(`staged agent "${agentId}" is missing from config`);
      }
      const created = await withPluginLifecycleLease({}, async () => {
        return await createAgent({
          entry: { ...stagedEntry, id: agentId },
          expectedConfigHash: baseHash ?? null,
          stagedConfig: nextConfig,
          transformConfig: transformConfigWithPendingPluginInstalls,
          ...(stagedAuthBatch
            ? {
                prepareConfigCommit: async () =>
                  (await persistAuthProfileBatch(stagedAuthBatch)).rollback,
              }
            : {}),
        });
      });
      if (created.status === "error") {
        await prompter.outro(created.message);
        return;
      }
      nextConfig = created.config;
      payload = {
        agentId: created.agentId,
        name: created.name,
        workspace: created.workspace,
        agentDir: created.agentDir,
      };
      await channelSetup.runPostWriteHooks(nextConfig);
    }
    await reportPortableAuthCopy?.();
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
    if (opts.json) {
      writeRuntimeJson(runtime, payload);
    }
    await prompter.outro(`Agent "${agentId}" ready.`);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
