// Main interactive configure/update wizard implementation.
import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { describeCodexNativeWebSearch } from "../agents/codex-native-web-search.shared.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatPortRangeHint } from "../cli/error-format.js";
import { parsePort } from "../cli/shared/parse-port.js";
import {
  createConfigIO,
  readConfigFileSnapshotForWrite,
  resolveGatewayPort,
} from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { formatWindowsGatewayFirewallGuidance } from "../infra/windows-gateway-firewall-diagnostics.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { resolvePluginContributionOwners } from "../plugins/plugin-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { resolveSetupSecretInputString } from "../wizard/setup.secret-input.js";
import { mergeWizardConfigOntoLatest } from "../wizard/setup.shared.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon } from "./configure.daemon.js";
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
import { healthCommand } from "./health.js";
import {
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
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

async function resolveGatewaySecretInputForWizard(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  try {
    return await resolveSetupSecretInputString({
      config: params.cfg,
      value: params.value,
      path: params.path,
      env: process.env,
    });
  } catch {
    return undefined;
  }
}

async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
}): Promise<void> {
  const localLinks = resolveLocalControlUiProbeLinks({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
    tlsEnabled: params.cfg.gateway?.tls?.enabled === true,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
  const configuredToken = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
  });
  const configuredPassword = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.password,
    path: "gateway.auth.password",
  });
  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? configuredToken;
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD ?? configuredPassword;

  await waitForGatewayReachable({
    url: wsUrl,
    token,
    password,
    deadlineMs: 15_000,
  });

  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
  } catch (err) {
    params.runtime.error(formatHealthCheckFailure(err));
    note(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
  }
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
      const { resolveSearchProviderOptions, setupSearch } = await import("./onboard-search.js");
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
        workingConfig = await setupSearch(workingConfig, runtime, prompter, {
          preserveDisabledSearchState: false,
        });
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
    const readOwnedConfigSnapshot = async () =>
      (
        await createConfigIO({
          configPath: configWriteOwnership.ownedConfigPathForWrite,
        }).readConfigFileSnapshotForWrite()
      ).snapshot;
    let currentBaseHash = snapshot.hash;
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
        const [baseLocalProbeToken, baseLocalProbePassword] = await Promise.all([
          resolveGatewaySecretInputForWizard({
            cfg: baseConfig,
            value: baseConfig.gateway?.auth?.token,
            path: "gateway.auth.token",
          }),
          resolveGatewaySecretInputForWizard({
            cfg: baseConfig,
            value: baseConfig.gateway?.auth?.password,
            path: "gateway.auth.password",
          }),
        ]);
        return probeGatewayReachable({
          url: localUrl,
          token: process.env.OPENCLAW_GATEWAY_TOKEN ?? baseLocalProbeToken,
          password: process.env.OPENCLAW_GATEWAY_PASSWORD ?? baseLocalProbePassword,
          timeoutMs: GATEWAY_HINT_PROBE_TIMEOUT_MS,
        });
      })();
      const remoteProbePromise = remoteUrl
        ? (async () => {
            const baseRemoteProbeToken = await resolveGatewaySecretInputForWizard({
              cfg: baseConfig,
              value: baseConfig.gateway?.remote?.token,
              path: "gateway.remote.token",
            });
            return probeGatewayReachable({
              url: remoteUrl,
              token: baseRemoteProbeToken,
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
      currentBaseHash = undefined;
      logConfigUpdated(runtime);
      outro("Remote gateway configured.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let mergeBaseConfig = structuredClone(baseConfig);
    let didSetGatewayMode = false;
    if (shouldPromptGatewayRunMode && nextConfig.gateway?.mode !== "local") {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
      didSetGatewayMode = true;
    }
    const resolveSetupTarget = () => resolveOnboardingAgentTarget(nextConfig);
    let workspaceDir = resolveSetupTarget().workspaceDir;
    let gatewayPort = resolveGatewayPort(baseConfig);

    const persistConfig = async () => {
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode: metadataMode,
      });

      // Retry loop: if config was mutated by a plugin, re-read and merge before retry
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const committed = await commitConfigWithPendingPluginInstalls({
            nextConfig,
            ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
            writeOptions: configWriteOwnership,
          });
          nextConfig = committed.config;

          // After successful write, re-read the snapshot to get the new hash
          const freshSnapshot = await readOwnedConfigSnapshot();
          currentBaseHash = freshSnapshot.hash ?? undefined;
          mergeBaseConfig = structuredClone(nextConfig);

          logConfigUpdated(runtime);
          return;
        } catch (err) {
          if (
            err instanceof ConfigMutationConflictError &&
            err.retryable &&
            attempt < maxRetries - 1
          ) {
            // Config was mutated externally (e.g. plugin wrote token during auth setup).
            // Re-read the on-disk config and merge plugin changes into nextConfig so
            // the retry won't silently overwrite them.
            const freshSnapshot = await readOwnedConfigSnapshot();
            currentBaseHash = freshSnapshot.hash ?? undefined;
            const diskConfig = freshSnapshot.valid
              ? (freshSnapshot.sourceConfig ?? freshSnapshot.config)
              : {};
            nextConfig = mergeWizardConfigOntoLatest(diskConfig, mergeBaseConfig, nextConfig);
            continue;
          }
          throw err;
        }
      }
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
      const targetEntry = nextConfig.agents?.entries?.[target.agentId];
      nextConfig =
        targetEntry?.workspace !== undefined
          ? {
              ...nextConfig,
              agents: {
                ...nextConfig.agents,
                entries: {
                  ...nextConfig.agents?.entries,
                  [target.agentId]: { ...targetEntry, workspace: workspaceDir },
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

    if (selectedSections) {
      const selected = selectedSections;
      if (!selected || selected.length === 0) {
        outro("No configuration changes selected.");
        return;
      }

      if (selected.includes("workspace")) {
        await configureWorkspace();
        await provisionWorkspace();
      }

      if (selected.includes("model")) {
        nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("web")) {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("gateway")) {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
      }

      if (selected.includes("channels")) {
        await configureChannelsSection();
      }

      if (selected.includes("plugins")) {
        const { configurePluginConfig } = await loadSetupPluginConfigModule();
        nextConfig = await configurePluginConfig({
          config: nextConfig,
          prompter,
          workspaceDir: resolveSetupTarget().workspaceDir,
        });
      }

      if (selected.includes("skills")) {
        nextConfig = await setupSkills(
          nextConfig,
          resolveSetupTarget().workspaceDir,
          runtime,
          prompter,
        );
      }

      await persistConfig();

      if (selected.includes("daemon")) {
        if (!selected.includes("gateway")) {
          await promptDaemonPort();
        }

        await maybeInstallDaemon({ runtime, port: gatewayPort });
      }

      if (selected.includes("health")) {
        await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
      }
    } else {
      let ranSection = false;
      let didConfigureGateway = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection);
        if (choice === "__continue") {
          break;
        }
        ranSection = true;

        if (choice === "workspace") {
          await configureWorkspace();
          await provisionWorkspace();
          await persistConfig();
        }

        if (choice === "model") {
          nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "web") {
          nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "gateway") {
          const gateway = await promptGatewayConfig(nextConfig, runtime);
          nextConfig = gateway.config;
          gatewayPort = gateway.port;
          didConfigureGateway = true;
          await persistConfig();
        }

        if (choice === "channels") {
          await configureChannelsSection();
          await persistConfig();
        }

        if (choice === "plugins") {
          const { configurePluginConfig } = await loadSetupPluginConfigModule();
          nextConfig = await configurePluginConfig({
            config: nextConfig,
            prompter,
            workspaceDir: resolveSetupTarget().workspaceDir,
          });
          await persistConfig();
        }

        if (choice === "skills") {
          nextConfig = await setupSkills(
            nextConfig,
            resolveSetupTarget().workspaceDir,
            runtime,
            prompter,
          );
          await persistConfig();
        }

        if (choice === "daemon") {
          if (!didConfigureGateway) {
            await promptDaemonPort();
          }
          await maybeInstallDaemon({
            runtime,
            port: gatewayPort,
          });
        }

        if (choice === "health") {
          await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
        }
      }

      if (!ranSection) {
        if (didSetGatewayMode) {
          await persistConfig();
          outro("Gateway mode set to local.");
          return;
        }
        outro("No configuration changes selected.");
        return;
      }
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
      outro("Configuration updated.");
      return;
    }

    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
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
    const newPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const oldPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: baseConfig,
        value: baseConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const token =
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.token,
        path: "gateway.auth.token",
      }));

    let gatewayProbe = await probeGatewayReachable({
      url: probeLinks.wsUrl,
      token,
      password: newPassword,
    });
    if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) {
      gatewayProbe = await probeGatewayReachable({
        url: probeLinks.wsUrl,
        token,
        password: oldPassword,
      });
    }
    const gatewayStatusLine = gatewayProbe.ok
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

    outro("Configuration updated.");
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
