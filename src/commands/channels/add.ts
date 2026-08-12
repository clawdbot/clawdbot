import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
// Implements guided and non-interactive `openclaw channels add` account setup.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  applyPreparedChannelAccountConfiguration,
  type ChannelAccountMutationPlugin,
  prepareChannelAccountConfiguration,
} from "../../channels/plugins/account-config-mutation.js";
import { getBundledChannelSetupPlugin } from "../../channels/plugins/bundled.js";
import { resolveChannelSetupCliOptionMetadata } from "../../channels/plugins/cli-add-options.js";
import { parseOptionalDelimitedEntries } from "../../channels/plugins/helpers.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId, ChannelSetupInput } from "../../channels/plugins/types.public.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  formatUnknownChannelMessage,
  formatUnsupportedChannelActionMessage,
} from "../../cli/error-format.js";
import { isTerminalInteractive } from "../../cli/terminal-interactivity.js";
import type { OpenClawConfig } from "../../config/config.js";
import { commitConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { normalizeExternalChannelSetupConfig } from "../channel-setup/config-compatibility.js";
import { channelLabel } from "./runtime-label.js";
import { requireValidConfigFileSnapshot, shouldUseWizard } from "./shared.js";

type ChannelSetupPluginInstallModule = typeof import("../channel-setup/plugin-install.js");
type OnboardChannelsModule = typeof import("../onboard-channels.js");

const channelSetupPluginInstallLoader = createLazyImportLoader<ChannelSetupPluginInstallModule>(
  () => import("../channel-setup/plugin-install.js"),
);
const onboardChannelsLoader = createLazyImportLoader<OnboardChannelsModule>(
  () => import("../onboard-channels.js"),
);

function loadChannelSetupPluginInstall(): Promise<ChannelSetupPluginInstallModule> {
  return channelSetupPluginInstallLoader.load();
}

function loadOnboardChannels(): Promise<OnboardChannelsModule> {
  return onboardChannelsLoader.load();
}

export type ChannelsAddOptions = {
  channel?: string;
  account?: string;
} & Record<string, unknown>;

const CHANNEL_ADD_CONTROL_OPTION_KEYS = new Set(["channel", "account"]);

async function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const entries = cfg
    ? await import("../channel-setup/trusted-catalog.js").then(
        ({ listTrustedChannelPluginCatalogEntries }) =>
          listTrustedChannelPluginCatalogEntries({
            cfg,
            workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
          }),
      )
    : await import("../../channels/plugins/catalog.js").then(
        ({ listRawChannelPluginCatalogEntries }) =>
          listRawChannelPluginCatalogEntries({ excludeWorkspace: true }),
      );
  return entries.find((entry) => {
    if (normalizeOptionalLowercaseString(entry.id) === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === trimmed,
    );
  });
}

function buildChannelSetupInput(opts: ChannelsAddOptions): ChannelSetupInput {
  const input: Record<string, unknown> = {};
  const { valueMetadataByAttributeName } = resolveChannelSetupCliOptionMetadata(opts.channel);
  for (const [key, value] of Object.entries(opts)) {
    if (CHANNEL_ADD_CONTROL_OPTION_KEYS.has(key) || value === undefined) {
      continue;
    }
    const metadata = valueMetadataByAttributeName.get(key);
    if (metadata?.valueType !== "int") {
      input[key] =
        metadata?.valueType === "list"
          ? Array.isArray(value)
            ? value.filter((entry): entry is string => typeof entry === "string")
            : parseOptionalDelimitedEntries(typeof value === "string" ? value : undefined)
          : value;
      continue;
    }
    if (value === null || value === "") {
      input[key] = undefined;
      continue;
    }
    const parsed = parseStrictNonNegativeInteger(value);
    if (parsed === undefined) {
      throw new Error(`${metadata.longFlag} must be a non-negative integer.`);
    }
    input[key] = parsed;
  }
  return input as ChannelSetupInput;
}

// Safe to forward every defined key: CLI registration is selection-scoped and
// resolveChannelsAddOptions drops non-user-authored values (Commander defaults),
// so no other channel's options or defaults can reach the selected contract.
function buildChannelOwnedSetupInput(opts: ChannelsAddOptions): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(opts).filter(
      ([key, value]) => !CHANNEL_ADD_CONTROL_OPTION_KEYS.has(key) && value !== undefined,
    ),
  );
}

/** Add or configure a channel account, using the wizard when no concrete flags are supplied. */
export async function channelsAddCommand(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
) {
  try {
    return await channelsAddCommandImpl(opts, runtime, params);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

async function channelsAddCommandImpl(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv,
  params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;
  const baseHash = configSnapshot.hash;
  let nextConfig = cfg;
  let pluginRegistrySourceChanged = false;

  const useWizard = shouldUseWizard(params);
  if (useWizard) {
    if (!isTerminalInteractive()) {
      runtime.error(
        "Interactive channel setup requires a TTY. Use `openclaw channels add --channel <id> --use-env` or pass the channel's credential flags for non-interactive setup.",
      );
      runtime.exit(1);
      return;
    }
    const { resolveInitialWizardChannel, runChannelsAddWizardFlow } =
      await import("./add-wizard.js");
    const initialChannel = await resolveInitialWizardChannel(opts.channel ?? "", cfg);
    await runChannelsAddWizardFlow({
      cfg,
      ...(baseHash !== undefined ? { baseHash } : {}),
      runtime,
      prompter: createClackPrompter(),
      ...(initialChannel ? { initialChannel } : {}),
      ...(params?.beforePersistentEffect
        ? { beforePersistentEffect: params.beforePersistentEffect }
        : {}),
    });
    return;
  }

  const rawChannel = opts.channel ?? "";
  let channel = normalizeChannelId(rawChannel);
  let catalogEntry = await resolveCatalogChannelEntry(rawChannel, nextConfig);
  const resolveWorkspaceDir = () =>
    resolveAgentWorkspaceDir(nextConfig, resolveDefaultAgentId(nextConfig));
  // May load a scoped plugin when the channel is not already registered.
  const loadScopedPlugin = async (
    channelId: ChannelId,
    pluginId?: string,
  ): Promise<ChannelAccountMutationPlugin | undefined> => {
    const existing = getLoadedChannelPlugin(channelId);
    if (existing?.setupContract?.applyAccountConfig || existing?.setup?.applyAccountConfig) {
      return existing;
    }
    const { loadChannelSetupPluginRegistrySnapshotForChannel } =
      await loadChannelSetupPluginInstall();
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: nextConfig,
      runtime,
      channel: channelId,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
      forceSetupOnlyChannelPlugins: true,
    });
    return (
      snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin ??
      getBundledChannelSetupPlugin(channelId) ??
      snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin ??
      existing
    );
  };

  if (catalogEntry) {
    const workspaceDir = resolveWorkspaceDir();
    const { isCatalogChannelInstalled } = await import("../channel-setup/discovery.js");
    const registeredPlugin = channel ? getLoadedChannelPlugin(channel) : undefined;
    const bundledSetupPlugin = channel ? getBundledChannelSetupPlugin(channel) : undefined;
    if (
      !registeredPlugin &&
      !bundledSetupPlugin &&
      !isCatalogChannelInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        workspaceDir,
      })
    ) {
      const { ensureChannelSetupPluginInstalled } = await loadChannelSetupPluginInstall();
      const prompter = createClackPrompter();
      const result = await ensureChannelSetupPluginInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        prompter,
        runtime,
        workspaceDir,
        promptInstall: false,
        ...(params?.beforePersistentEffect
          ? { beforePersistentEffect: params.beforePersistentEffect }
          : {}),
      });
      nextConfig = result.cfg;
      if (!result.installed) {
        return;
      }
      pluginRegistrySourceChanged = true;
      catalogEntry = {
        ...catalogEntry,
        ...(result.pluginId ? { pluginId: result.pluginId } : {}),
      };
    }
    channel ??= normalizeChannelId(catalogEntry.id) ?? (catalogEntry.id as ChannelId);
  }

  if (!channel) {
    const hint = catalogEntry
      ? `Plugin ${catalogEntry.meta.label} could not be loaded after install. Run openclaw doctor --fix, then retry openclaw channels add.`
      : formatUnknownChannelMessage({ channel: rawChannel });
    runtime.error(hint);
    runtime.exit(1);
    return;
  }

  const plugin = await loadScopedPlugin(channel, catalogEntry?.pluginId);
  if (!plugin) {
    runtime.error(
      `${formatUnsupportedChannelActionMessage({
        channel,
        action: "non-interactive add",
      })} Run ${formatCliCommand("openclaw channels add")} with no flags for guided setup.`,
    );
    runtime.exit(1);
    return;
  }
  const prepared = await prepareChannelAccountConfiguration({
    cfg: nextConfig,
    plugin,
    requestedAccountId: opts.account,
    resolveInput: () =>
      plugin.setupContract ? buildChannelOwnedSetupInput(opts) : buildChannelSetupInput(opts),
    runtime,
    ...(params?.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
  });
  if (!prepared.ok) {
    runtime.error(
      prepared.error.kind === "unsupported"
        ? `${formatUnsupportedChannelActionMessage({
            channel,
            action: "non-interactive add",
          })} Run ${formatCliCommand("openclaw channels add")} with no flags for guided setup.`
        : prepared.error.message,
    );
    runtime.exit(1);
    return;
  }
  const applied = await applyPreparedChannelAccountConfiguration({
    cfg: nextConfig,
    channel,
    prepared: prepared.value,
    runtime,
    ...(params?.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
  });
  nextConfig = normalizeExternalChannelSetupConfig({ cfg: applied.nextConfig, channel });

  await params?.beforePersistentEffect?.();
  const committed = await commitConfigWithPendingPluginInstalls({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  const writtenConfig = committed.config;
  if (committed.movedInstallRecords || pluginRegistrySourceChanged) {
    await refreshPluginRegistryAfterConfigMutation({
      config: writtenConfig,
      reason: "source-changed",
      ...(committed.movedInstallRecords ? { installRecords: committed.installRecords } : {}),
      logger: { warn: (message) => runtime.log(message) },
    });
  }
  runtime.log(
    `Added ${plugin.meta.label ?? channelLabel(channel)} account "${applied.accountId}".`,
  );
  const afterAccountConfigWritten = applied.afterAccountConfigWritten;
  if (afterAccountConfigWritten) {
    const { runCollectedChannelOnboardingPostWriteHooks } = await loadOnboardChannels();
    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: [
        {
          channel,
          accountId: applied.accountId,
          run: async ({ cfg: writtenCfg, runtime: hookRuntime }) =>
            await afterAccountConfigWritten({
              previousCfg: cfg,
              cfg: writtenCfg,
              accountId: applied.accountId,
              input: applied.input,
              runtime: hookRuntime,
            }),
        },
      ],
      cfg: writtenConfig,
      runtime,
      ...(params?.beforePersistentEffect
        ? { beforePersistentEffect: params.beforePersistentEffect }
        : {}),
    });
  }
}
