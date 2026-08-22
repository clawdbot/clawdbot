// Main interactive configure/update wizard implementation.
import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { describeCodexNativeWebSearch } from "../agents/codex-native-web-search.shared.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatPortRangeHint } from "../cli/error-format.js";
import { parsePort } from "../cli/shared/parse-port.js";
import { readConfigFileSnapshotForWrite, resolveGatewayPort } from "../config/config.js";
import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { logConfigUpdated } from "../config/logging.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChannelSetupTransaction } from "../flows/channel-setup.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import { formatWindowsGatewayFirewallGuidance } from "../infra/windows-gateway-firewall-diagnostics.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { resolvePluginContributionOwners } from "../plugins/plugin-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { writeWizardConfigFile } from "../wizard/setup.shared.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon, type DaemonSetupOutcome } from "./configure.daemon.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import type {
  ChannelsWizardMode,
  ConfigureWizardParams,
  WizardSection,
} from "./configure.shared.js";
import {
  CONFIGURE_SECTION_OPTIONS,
  confirm,
  intro,
  outro,
  select,
  text,
} from "./configure.shared.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommandNonExiting } from "./health.js";
import {
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
  resolveSystemAgentOnboardingTarget,
} from "./onboard-agent-target.js";
import { setupChannels } from "./onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  guardCancel,
  probeGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveLocalControlUiProbeLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";
import type { OnboardMode } from "./onboard-types.js";

type ConfigureSectionChoice = WizardSection | "__continue";
type SetupPluginConfigModule = typeof import("../wizard/setup.plugin-config.js");
type GatewayHealthCheckOutcome = "succeeded" | "failed" | "skipped";

const GATEWAY_HINT_PROBE_TIMEOUT_MS = 300;

const setupPluginConfigModuleLoader = createLazyImportLoader<SetupPluginConfigModule>(
  () => import("../wizard/setup.plugin-config.js"),
);

function validateGatewayPortInput(value: unknown): string | undefined {
  if (parsePort(value) === null) {
    return formatPortRangeHint();
  }
  return undefined;
}

function loadSetupPluginConfigModule(): Promise<SetupPluginConfigModule> {
  return setupPluginConfigModuleLoader.load();
}

async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
}): Promise<GatewayHealthCheckOutcome> {
  const localLinks = resolveLocalControlUiProbeLinks({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
    tlsEnabled: params.cfg.gateway?.tls?.enabled === true,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const remoteWsUrl = params.cfg.gateway?.mode === "remote" ? remoteUrl : undefined;
  const probeMode = remoteWsUrl ? "remote" : "local";
  const wsUrl = remoteWsUrl ?? localLinks.wsUrl;
  let token: string | undefined;
  let password: string | undefined;
  // Remote and local probe credentials belong to different trust surfaces.
  // Keep their resolution separate so one target never receives the other's secrets.
  if (probeMode === "remote") {
    const remoteProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: params.cfg,
      env: process.env,
      mode: "remote",
    });
    if (remoteProbeAuth.warning) {
      const hasResolvedRemoteAuth = Boolean(
        remoteProbeAuth.auth.token || remoteProbeAuth.auth.password,
      );
      note(
        [
          "Could not resolve remote gateway SecretRef for health check.",
          remoteProbeAuth.warning,
          ...(hasResolvedRemoteAuth
            ? ["Continuing with the other configured remote credential."]
            : [
                "Health check skipped to avoid falling back to ambient credentials.",
                `Fix the SecretRef, then run \`${formatCliCommand("openclaw health")}\` again.`,
              ]),
        ].join("\n"),
        "Gateway auth",
      );
      // A failed ref does not invalidate a resolved sibling config credential.
      // Skip only when generic health auth could otherwise recover ambient auth.
      if (!hasResolvedRemoteAuth) {
        return "skipped";
      }
    }
    ({ token, password } = remoteProbeAuth.auth);
  } else {
    const localProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: params.cfg,
      env: process.env,
      mode: "local",
      localPrecedence: "env-first",
    });
    if (localProbeAuth.warning) {
      note(
        [
          "Could not resolve local gateway SecretRef for health check.",
          localProbeAuth.warning,
          "Health check skipped to avoid falling back to ambient credentials.",
          `Fix the SecretRef, then run \`${formatCliCommand("openclaw health")}\` again.`,
        ].join("\n"),
        "Gateway auth",
      );
      return "skipped";
    }
    ({ token, password } = localProbeAuth.auth);
  }

  try {
    const gatewayProbe = await waitForGatewayReachable({
      url: wsUrl,
      token,
      password,
      deadlineMs: 15_000,
    });
    if (!gatewayProbe.ok) {
      throw new Error(gatewayProbe.detail ?? `gateway did not become reachable at ${wsUrl}`);
    }
    await healthCommandNonExiting(
      {
        json: false,
        timeoutMs: 10_000,
        config: params.cfg,
        token,
        password,
        ...(probeMode === "local"
          ? { localPortOverride: params.port }
          : { ignoreEnvUrlOverride: true }),
      },
      params.runtime,
    );
  } catch (err) {
    // A trapped ExitError means healthCommand already printed its own
    // reachable-gateway diagnostic; re-formatting it would only add noise.
    if (!(err instanceof ExitError)) {
      params.runtime.error(formatHealthCheckFailure(err));
    }
    note(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
    return "failed";
  }
  return "succeeded";
}

async function promptConfigureSection(
  runtime: RuntimeEnv,
  hasSelection: boolean,
): Promise<ConfigureSectionChoice> {
  return guardCancel(
    await select<ConfigureSectionChoice>({
      message: "What do you want to configure?",
      options: [
        ...CONFIGURE_SECTION_OPTIONS,
        {
          value: "__continue",
          label: hasSelection ? "Done" : "Skip for now",
        },
      ],
      initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
    }),
    runtime,
    1,
  );
}

async function promptChannelMode(runtime: RuntimeEnv): Promise<ChannelsWizardMode> {
  return guardCancel(
    await select({
      message: "Channel setup",
      options: [
        {
          value: "configure",
          label: "Add or update channels",
          hint: "Configure accounts and disable unselected accounts",
        },
        {
          value: "remove",
          label: "Remove channel config",
          hint: "Delete channel tokens/settings from openclaw.json",
        },
      ],
      initialValue: "configure",
    }),
    runtime,
    1,
  ) as ChannelsWizardMode;
}

async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: ReturnType<typeof createClackPrompter>,
): Promise<OpenClawConfig> {
  type WebSearchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"];
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const { isCodexNativeWebSearchRelevant } = await import("../agents/codex-native-web-search.js");
  const hasManagedSearchProviders =
    resolvePluginContributionOwners({
      config: nextConfig,
      contribution: "contracts",
      matches: "webSearchProviders",
    }).length > 0;

  note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Codex-capable models can use native Codex web search.",
      "Other models use a separate web search provider, which you can configure here.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = guardCancel(
    await confirm({
      message: "Enable the web_search tool?",
      initialValue: existingSearch?.enabled ?? hasManagedSearchProviders,
    }),
    runtime,
    1,
  );

  let nextSearch: WebSearchConfig = {
    ...existingSearch,
    enabled: enableSearch,
  };
  let workingConfig = nextConfig;

  if (enableSearch) {
    const codexRelevant = isCodexNativeWebSearchRelevant({ config: nextConfig });
    let configureManagedProvider = true;

    if (codexRelevant) {
      note(
        [
          "Codex-capable models can use native Codex web search instead of a separate provider.",
          "Other models need a separate web search provider.",
          "If you do not choose one, OpenClaw can select a provider from available credentials; otherwise other models may not have web search.",
          ...(describeCodexNativeWebSearch(nextConfig)
            ? [describeCodexNativeWebSearch(nextConfig)!]
            : []),
        ].join("\n"),
        "Codex native search",
      );

      const enableCodexNative = guardCancel(
        await confirm({
          message: "Enable native Codex web search for Codex-capable models?",
          initialValue: existingSearch?.openaiCodex?.enabled === true,
        }),
        runtime,
        1,
      );

      if (enableCodexNative) {
        const codexMode = guardCancel(
          await select({
            message: "Native Codex web search mode",
            options: [
              {
                value: "cached",
                label: "cached (recommended)",
                hint: "Uses cached web content",
              },
              {
                value: "live",
                label: "live",
                hint: "Allows live external web access",
              },
            ],
            initialValue: existingSearch?.openaiCodex?.mode ?? "cached",
          }),
          runtime,
          1,
        );
        nextSearch = {
          ...nextSearch,
          openaiCodex: {
            ...existingSearch?.openaiCodex,
            enabled: true,
            mode: codexMode,
          },
        };
        configureManagedProvider = guardCancel(
          await confirm({
            message: existingSearch?.provider
              ? `Change the separate web search provider (currently ${existingSearch.provider})?`
              : "Also configure a separate web search provider for other models?",
            initialValue: Boolean(existingSearch?.provider),
          }),
          runtime,
          1,
        );
      } else {
        nextSearch = {
          ...nextSearch,
          openaiCodex: {
            ...existingSearch?.openaiCodex,
            enabled: false,
          },
        };
      }
    }

    if (configureManagedProvider) {
      const { resolveSearchProviderOptions, runSearchSetupFlow } =
        await import("../flows/search-setup.js");
      const searchProviderOptions = resolveSearchProviderOptions(nextConfig);
      if (searchProviderOptions.length === 0) {
        note(
          [
            "No web search providers are currently available under this plugin policy.",
            "Enable plugins or remove deny rules, then rerun configure.",
            "Docs: https://docs.openclaw.ai/tools/web",
          ].join("\n"),
          "Web search",
        );
        if (nextSearch.openaiCodex?.enabled !== true) {
          nextSearch = {
            ...existingSearch,
            enabled: false,
          };
        }
      } else {
        const searchSetup = await runSearchSetupFlow(workingConfig, runtime, prompter, {
          preserveDisabledSearchState: false,
        });
        workingConfig = searchSetup.config;
        const selectedSearch = workingConfig.tools?.web?.search;
        nextSearch = {
          ...selectedSearch,
          enabled:
            selectedSearch?.enabled ?? (selectedSearch?.provider ? true : existingSearch?.enabled),
          openaiCodex: {
            ...existingSearch?.openaiCodex,
            ...(nextSearch.openaiCodex as Record<string, unknown> | undefined),
          },
        };
      }
    }
  }

  note(
    [
      "`web_fetch` is a separate tool for reading a specific URL.",
      "It does not require an API key and works independently of web search providers, including Codex.",
    ].join("\n"),
    "Web fetch",
  );

  const enableFetch = guardCancel(
    await confirm({
      message: "Enable the web_fetch tool?",
      initialValue: existingFetch?.enabled ?? true,
    }),
    runtime,
    1,
  );

  const nextFetch = {
    ...workingConfig.tools?.web?.fetch,
    enabled: enableFetch,
  };

  return {
    ...workingConfig,
    tools: {
      ...workingConfig.tools,
      web: {
        ...workingConfig.tools?.web,
        search: nextSearch,
        fetch: nextFetch,
      },
    },
  };
}

/** Run the configure/update wizard, optionally limited to selected sections. */
export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  try {
    intro(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
    const prompter = createClackPrompter();

    const prepared = await readConfigFileSnapshotForWrite();
    const snapshot = prepared.snapshot;
    // Keep only path ownership across the interactive wizard. Each commit re-reads under
    // the mutation lock and must use that fresh snapshot's env/include conflict facts.
    const configWriteOwnership = {
      ...(prepared.writeOptions.assertConfigPathForWrite
        ? { assertConfigPathForWrite: prepared.writeOptions.assertConfigPathForWrite }
        : {}),
      expectedConfigPath: prepared.writeOptions.expectedConfigPath,
      ownedConfigPathForWrite: prepared.writeOptions.ownedConfigPathForWrite,
    };
    const currentBaseHash = snapshot.hash;
    const baseConfig: OpenClawConfig = snapshot.valid
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {};

    if (snapshot.exists) {
      const title = snapshot.valid ? "Existing config detected" : "Invalid config";
      note(summarizeExistingConfig(baseConfig), title);
      if (!snapshot.valid && snapshot.issues.length > 0) {
        note(
          [
            ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
            "",
            "Docs: https://docs.openclaw.ai/gateway/configuration",
          ].join("\n"),
          "Config issues",
        );
      }
      if (!snapshot.valid) {
        outro(
          `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`,
        );
        runtime.exit(1);
        return;
      }
    }

    const selectedSections = opts.sections;
    const shouldPromptGatewayRunMode =
      !selectedSections ||
      selectedSections.includes("gateway") ||
      selectedSections.includes("daemon") ||
      selectedSections.includes("health");
    const promptGatewayRunMode = async (): Promise<OnboardMode> => {
      const localUrl = `ws://127.0.0.1:${resolveGatewayPort(baseConfig)}`;
      const remoteUrl = normalizeOptionalString(baseConfig.gateway?.remote?.url) ?? "";
      const localProbePromise = (async () => {
        const localProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
          cfg: baseConfig,
          env: process.env,
          mode: "local",
          localPrecedence: "env-first",
        });
        if (localProbeAuth.warning) {
          return { ok: false, authUnavailable: true as const };
        }
        return probeGatewayReachable({
          url: localUrl,
          token: localProbeAuth.auth.token,
          password: localProbeAuth.auth.password,
          timeoutMs: GATEWAY_HINT_PROBE_TIMEOUT_MS,
        });
      })();
      const remoteProbePromise = remoteUrl
        ? (async () => {
            const remoteProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
              cfg: baseConfig,
              env: process.env,
              mode: "remote",
            });
            return probeGatewayReachable({
              url: remoteUrl,
              ...(baseConfig.gateway?.remote?.edgeAuth ? { config: baseConfig } : {}),
              token: remoteProbeAuth.auth.token,
              ...(remoteProbeAuth.auth.password ? { password: remoteProbeAuth.auth.password } : {}),
              timeoutMs: GATEWAY_HINT_PROBE_TIMEOUT_MS,
            });
          })()
        : Promise.resolve(null);
      const [localProbe, remoteProbe] = await Promise.all([localProbePromise, remoteProbePromise]);
      return guardCancel(
        await select({
          message: "Where will the Gateway run?",
          options: [
            {
              value: "local",
              label: "Local (this machine)",
              hint: localProbe.ok
                ? `Gateway reachable (${localUrl})`
                : "authUnavailable" in localProbe
                  ? `Gateway auth unavailable; probe skipped (${localUrl})`
                  : `No gateway detected (${localUrl})`,
            },
            {
              value: "remote",
              label: "Remote (info-only)",
              hint: !remoteUrl
                ? "No remote URL configured yet"
                : remoteProbe?.ok
                  ? `Gateway reachable (${remoteUrl})`
                  : `Configured but unreachable (${remoteUrl})`,
            },
          ],
        }),
        runtime,
        1,
      );
    };

    const mode = shouldPromptGatewayRunMode ? await promptGatewayRunMode() : "local";
    const metadataMode: OnboardMode =
      shouldPromptGatewayRunMode || baseConfig.gateway?.mode !== "remote" ? mode : "remote";
    const shouldSkipGatewaySummary = !shouldPromptGatewayRunMode;

    if (shouldPromptGatewayRunMode && mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: opts.command,
        mode: metadataMode,
      });
      const committed = await commitConfigWithPendingPluginInstalls({
        nextConfig: remoteConfig,
        ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
        writeOptions: configWriteOwnership,
      });
      remoteConfig = committed.config;
      logConfigUpdated(runtime);
      if (selectedSections?.includes("health")) {
        const healthCheckOutcome = await runGatewayHealthCheck({
          cfg: remoteConfig,
          runtime,
          port: resolveGatewayPort(remoteConfig),
        });
        outro(
          healthCheckOutcome === "succeeded"
            ? "Remote gateway configured and health check completed."
            : healthCheckOutcome === "failed"
              ? "Remote gateway configured, but health check failed."
              : "Remote gateway configured; health check skipped.",
        );
      } else {
        outro("Remote gateway configured.");
      }
      return;
    }

    let nextConfig = { ...baseConfig };
    let mergeBaseConfig = structuredClone(baseConfig);
    let hasPendingConfig = shouldPromptGatewayRunMode && nextConfig.gateway?.mode !== "local";
    if (hasPendingConfig) {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
    }
    // Configure keeps legacy default-owner semantics; only explicit fleets opt into
    // the System Agent target used unconditionally by setup and recovery callers.
    const resolveSetupTarget = () =>
      nextConfig.agents?.ownership === "explicit"
        ? resolveSystemAgentOnboardingTarget(nextConfig)
        : resolveOnboardingAgentTarget(inheritLegacyDefaultAgentId(baseConfig, nextConfig));
    let workspaceDir = resolveSetupTarget().workspaceDir;
    let gatewayPort = resolveGatewayPort(baseConfig);
    let didPersistConfig = false;
    let daemonSetupOutcome: DaemonSetupOutcome | undefined;
    let healthCheckOutcome: GatewayHealthCheckOutcome | undefined;
    const channelSetup = createChannelSetupTransaction({ runtime });

    const persistPendingConfig = async () => {
      if (!hasPendingConfig) {
        return;
      }
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode: metadataMode,
      });

      nextConfig = await channelSetup.commit(nextConfig, async (configToCommit) => {
        const committedConfig = await writeWizardConfigFile(configToCommit, {
          mergeBase: mergeBaseConfig,
          writeOptions: configWriteOwnership,
        });
        mergeBaseConfig = structuredClone(committedConfig);
        return committedConfig;
      });
      hasPendingConfig = false;
      didPersistConfig = true;
      logConfigUpdated(runtime);
    };

    const configureWorkspace = async () => {
      const workspaceInput = guardCancel(
        await text({
          message: "Workspace directory",
          initialValue: workspaceDir,
        }),
        runtime,
        1,
      );
      workspaceDir = resolveUserPath(
        normalizeOptionalString(workspaceInput ?? "") || DEFAULT_WORKSPACE,
      );
      if (!snapshot.exists) {
        const indicators = ["MEMORY.md", "memory", ".git"].map((name) =>
          nodePath.join(workspaceDir, name),
        );
        const hasExistingContent = (
          await Promise.all(
            indicators.map(async (candidate) => {
              try {
                await fsPromises.access(candidate);
                return true;
              } catch {
                return false;
              }
            }),
          )
        ).some(Boolean);
        if (hasExistingContent) {
          note(
            [
              `Existing workspace detected at ${workspaceDir}`,
              "Existing files are preserved. Missing templates may be created, never overwritten.",
            ].join("\n"),
            "Existing workspace",
          );
        }
      }
      const target = resolveSetupTarget();
      const authoredEntryKey = Object.keys(nextConfig.agents?.entries ?? {}).find(
        (key) => normalizeAgentId(key) === target.agentId,
      );
      const targetEntry = authoredEntryKey
        ? nextConfig.agents?.entries?.[authoredEntryKey]
        : undefined;
      // Explicit fleets own workspace at the selected entry even when it inherited
      // the global default; legacy owners stay global until they author an override.
      nextConfig =
        targetEntry?.workspace !== undefined ||
        (nextConfig.agents?.ownership === "explicit" && targetEntry !== undefined)
          ? {
              ...nextConfig,
              agents: {
                ...nextConfig.agents,
                entries: {
                  ...nextConfig.agents?.entries,
                  [authoredEntryKey ?? target.agentId]: { ...targetEntry, workspace: workspaceDir },
                },
              },
            }
          : {
              ...nextConfig,
              agents: {
                ...nextConfig.agents,
                defaults: {
                  ...nextConfig.agents?.defaults,
                  workspace: workspaceDir,
                },
              },
            };
    };

    const provisionWorkspace = async () => {
      await ensureOnboardingAgentWorkspace(resolveSetupTarget(), runtime, {
        skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
        skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
      });
    };

    const configureChannelsSection = async () => {
      const channelMode = await promptChannelMode(runtime);
      if (channelMode === "configure") {
        nextConfig = await setupChannels(nextConfig, runtime, prompter, {
          allowDisable: true,
          allowIMessageInstall: true,
          allowSignalInstall: true,
          deferStatusUntilSelection: true,
          skipConfirm: true,
          skipStatusNote: true,
          onPostWriteHook: channelSetup.onPostWriteHook,
        });
      } else {
        nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
      }
    };

    const promptDaemonPort = async () => {
      const portInput = guardCancel(
        await text({
          message: "Gateway port for service install",
          initialValue: String(gatewayPort),
          validate: validateGatewayPortInput,
        }),
        runtime,
        1,
      );
      gatewayPort = parsePort(portInput) ?? gatewayPort;
    };

    let didConfigureGateway = false;
    const sectionActions = {
      workspace: async () => {
        await configureWorkspace();
        await provisionWorkspace();
      },
      model: async () => {
        nextConfig = await promptAuthConfig(nextConfig, runtime, prompter, resolveSetupTarget());
      },
      web: async () => {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
      },
      gateway: async () => {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
        didConfigureGateway = true;
      },
      channels: configureChannelsSection,
      plugins: async () => {
        const { configurePluginConfig } = await loadSetupPluginConfigModule();
        nextConfig = await configurePluginConfig({
          config: nextConfig,
          prompter,
          workspaceDir: resolveSetupTarget().workspaceDir,
        });
      },
      skills: async () => {
        nextConfig = await setupSkills(
          nextConfig,
          resolveSetupTarget().workspaceDir,
          runtime,
          prompter,
        );
      },
      daemon: async () => {
        if (!didConfigureGateway) {
          await promptDaemonPort();
        }
        daemonSetupOutcome = await maybeInstallDaemon({ runtime, port: gatewayPort });
      },
      health: async () => {
        healthCheckOutcome = await runGatewayHealthCheck({
          cfg: nextConfig,
          runtime,
          port: gatewayPort,
        });
      },
    } satisfies Record<WizardSection, () => Promise<void>>;

    if (selectedSections) {
      if (selectedSections.length === 0) {
        outro("No configuration changes selected.");
        return;
      }

      // Section flags retain their canonical setup order regardless of flag order;
      // the complete config is committed once before service or health effects.
      for (const section of [
        "workspace",
        "model",
        "web",
        "gateway",
        "channels",
        "plugins",
        "skills",
      ] as const) {
        if (selectedSections.includes(section)) {
          await sectionActions[section]();
          hasPendingConfig = true;
        }
      }

      await persistPendingConfig();

      for (const section of ["daemon", "health"] as const) {
        if (selectedSections.includes(section)) {
          await sectionActions[section]();
        }
      }
    } else {
      let ranSection = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection);
        if (choice === "__continue") {
          break;
        }
        ranSection = true;
        if (choice === "daemon" || choice === "health") {
          await persistPendingConfig();
        }
        await sectionActions[choice]();
        if (choice !== "daemon" && choice !== "health") {
          // Interactive setup commits each section before showing another prompt.
          hasPendingConfig = true;
          await persistPendingConfig();
        }
      }

      if (!ranSection) {
        if (hasPendingConfig) {
          await persistPendingConfig();
          outro("Gateway mode set to local.");
          return;
        }
        outro("No configuration changes selected.");
        return;
      }
    }

    const failedSideEffects = [
      ...(daemonSetupOutcome === "failed" ? ["daemon setup"] : []),
      ...(healthCheckOutcome === "failed" ? ["health check"] : []),
    ];
    let completionMessage = didPersistConfig
      ? "Configuration updated."
      : "No configuration changes selected.";
    if (failedSideEffects.length > 0) {
      completionMessage = `${didPersistConfig ? "Configuration updated" : "Configuration unchanged"}, but ${failedSideEffects.join(" and ")} failed.`;
    } else if (!didPersistConfig && healthCheckOutcome) {
      completionMessage = `Health check ${healthCheckOutcome === "succeeded" ? "completed" : "skipped"}.`;
    } else if (!didPersistConfig && daemonSetupOutcome) {
      completionMessage = `Daemon setup ${daemonSetupOutcome === "succeeded" ? "completed" : "skipped"}.`;
    }

    if (shouldSkipGatewaySummary) {
      const remoteUrl = normalizeOptionalString(nextConfig.gateway?.remote?.url);
      if (remoteUrl) {
        note(
          ["Remote Gateway:", remoteUrl, "Docs: https://docs.openclaw.ai/gateway/remote"].join(
            "\n",
          ),
          "Gateway",
        );
      }
      outro(completionMessage);
      return;
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const displayLinks = await resolveAdvertisedControlUiLinks({
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    const probeLinks = resolveLocalControlUiProbeLinks({
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    const probeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: nextConfig,
      env: process.env,
      mode: "local",
      localPrecedence: "env-first",
    });
    let gatewayProbe = probeAuth.warning
      ? { ok: false, detail: "auth unavailable; probe skipped" }
      : await probeGatewayReachable({
          url: probeLinks.wsUrl,
          token: probeAuth.auth.token,
          password: probeAuth.auth.password,
        });
    if (!gatewayProbe.ok && !probeAuth.warning && baseConfig.gateway?.auth?.password) {
      const oldProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
        cfg: baseConfig,
        env: process.env,
        mode: "local",
        localPrecedence: "env-first",
      });
      if (
        !oldProbeAuth.warning &&
        oldProbeAuth.auth.password &&
        probeAuth.auth.password !== oldProbeAuth.auth.password
      ) {
        gatewayProbe = await probeGatewayReachable({
          url: probeLinks.wsUrl,
          token: probeAuth.auth.token,
          password: oldProbeAuth.auth.password,
        });
      }
    }
    const gatewayStatusLine = probeAuth.warning
      ? "Gateway: auth unavailable (probe skipped)"
      : gatewayProbe.ok
        ? "Gateway: reachable"
        : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
    const windowsFirewallLines = formatWindowsGatewayFirewallGuidance({ bind });

    note(
      [
        `Web UI: ${displayLinks.httpUrl}`,
        `Gateway WS: ${displayLinks.wsUrl}`,
        gatewayStatusLine,
        ...windowsFirewallLines,
        "Docs: https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outro(completionMessage);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
