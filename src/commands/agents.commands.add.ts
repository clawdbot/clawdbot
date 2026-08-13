// Implements `openclaw agents add`, including config mutation, workspace setup, auth copy, and route binding setup.
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { createAgent } from "../agents/agent-create.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  buildPortableAuthProfileStoreForAgentCopy,
  ensureAuthProfileStore,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { AuthProfileStoreUnreadableError } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { logConfigUpdated } from "../config/logging.js";
import {
  commitConfigWithPendingPluginInstalls,
  transformConfigWithPendingPluginInstalls,
} from "../plugins/install-record-commit.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { applyAgentBindings, buildChannelBindings, describeBinding } from "./agents.bindings.js";
import { applyAgentConfig, listAgentEntries } from "./agents.config.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, warnIfModelConfigLooksOff } from "./auth-choice.js";
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
  params?: { hasFlags?: boolean },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
  const baseHash = configSnapshot.hash;

  const workspaceFlag = opts.workspace?.trim();
  const nameInput = opts.name?.trim();
  const hasFlags = params?.hasFlags === true;
  const nonInteractive = opts.nonInteractive === true || hasFlags;

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
    const agentId = normalizeAgentId(nameInput);
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

  const prompter = createClackPrompter();
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
          const normalized = normalizeAgentId(value);
          if (normalized === LEGACY_IMPLICIT_AGENT_ID || isReservedSystemAgentId(normalized)) {
            return `"${normalized}" is reserved. Choose another name.`;
          }
          return undefined;
        },
      }));

    const agentName = normalizeOptionalString(name) ?? "";
    const agentId = normalizeAgentId(agentName);
    if (agentId === LEGACY_IMPLICIT_AGENT_ID || isReservedSystemAgentId(agentId)) {
      await prompter.outro(`"${agentId}" is reserved. Choose another name.`);
      return;
    }
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

    const defaultAgentId = resolveDefaultAgentId(cfg);
    if (defaultAgentId !== agentId) {
      const sourceAgentDir = resolveAgentDir(cfg, defaultAgentId);
      const sourceAuthPath = resolveAuthProfileDatabasePath(sourceAgentDir);
      const destAuthPath = resolveAuthProfileDatabasePath(agentDir);
      const mainAuthPath = resolveAuthProfileDatabasePath();
      const sameAuthPath =
        normalizeLowercaseStringOrEmpty(path.resolve(sourceAuthPath)) ===
        normalizeLowercaseStringOrEmpty(path.resolve(destAuthPath));
      const sourceIsInheritedMain =
        normalizeLowercaseStringOrEmpty(path.resolve(sourceAuthPath)) ===
        normalizeLowercaseStringOrEmpty(path.resolve(mainAuthPath));
      if (!sameAuthPath) {
        const sourceStore = loadReadablePersistedAuthProfileStore(sourceAgentDir);
        const destStore = loadReadablePersistedAuthProfileStore(agentDir);
        const portable = sourceStore
          ? buildPortableAuthProfileStoreForAgentCopy(sourceStore)
          : undefined;
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
            await fs.mkdir(agentDir, { recursive: true });
            saveAuthProfileStore(portable.store, agentDir, {
              filterExternalAuthProfiles: false,
              syncExternalCli: false,
            });
            const persistedDestStore = loadPersistedAuthProfileStore(agentDir);
            const copiedCount = portable.copiedProfileIds.filter(
              (profileId) => persistedDestStore?.profiles[profileId] !== undefined,
            ).length;
            const skippedOAuthProfiles =
              hasOAuthProfiles(sourceStore, portable.skippedProfileIds) ||
              portable.copiedProfileIds.some(
                (profileId) =>
                  sourceStore.profiles[profileId]?.type === "oauth" &&
                  persistedDestStore?.profiles[profileId] === undefined,
              );
            const copiedText =
              copiedCount > 0
                ? `Copied ${copiedCount} portable auth profile${copiedCount === 1 ? "" : "s"} from "${defaultAgentId}".`
                : "";
            const skippedText = skippedOAuthProfiles
              ? ` ${formatSkippedOAuthProfilesMessage(defaultAgentId, sourceIsInheritedMain)}`
              : "";
            await prompter.note(`${copiedText}${skippedText}`.trim(), "Auth profiles");
          }
        } else if (
          sourceStore &&
          portable &&
          hasOAuthProfiles(sourceStore, portable.skippedProfileIds)
        ) {
          await prompter.note(
            formatSkippedOAuthProfilesMessage(defaultAgentId, sourceIsInheritedMain),
            "Auth profiles",
          );
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
      });
      while (true) {
        const authChoice = await promptAuthChoiceGrouped({
          prompter,
          store: authStore,
          includeSkip: true,
          config: nextConfig,
        });

        const authResult = await applyAuthChoice({
          authChoice,
          config: nextConfig,
          prompter,
          runtime,
          agentDir,
          setDefaultModel: false,
          agentId,
        });
        nextConfig = authResult.config;
        if (authResult.retrySelection) {
          continue;
        }
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
      validateCatalog: false,
    });

    let selection: ChannelChoice[] = [];
    const channelAccountIds: Partial<Record<ChannelChoice, string>> = {};
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowIMessageInstall: true,
      allowSignalInstall: true,
      onSelection: (value) => {
        selection = value;
      },
      promptAccountIds: true,
      onAccountId: (channel, accountId) => {
        channelAccountIds[channel] = accountId;
      },
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

    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    nextConfig = committed.config;
    logConfigUpdated(runtime);
    const target = resolveOnboardingAgentTarget(nextConfig, agentId);
    await ensureOnboardingAgentWorkspace(target, runtime, {
      skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
      skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
    });

    const payload = {
      agentId: target.agentId,
      name: agentName,
      workspace: target.workspaceDir,
      agentDir: target.agentDir,
    };
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
