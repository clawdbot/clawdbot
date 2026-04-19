import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describeCodexNativeWebSearch } from "../agents/codex-native-web-search.shared.js";
import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshot, replaceConfigFile, resolveGatewayPort } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { isPlainObject, resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { resolveSetupSecretInputString } from "../wizard/setup.secret-input.js";
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
import { setupChannels } from "./onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  probeGatewayReachable,
  resolveControlUiLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";

type ConfigureSectionChoice = WizardSection | "__continue";
type SetupPluginConfigModule = typeof import("../wizard/setup.plugin-config.js");

let setupPluginConfigModulePromise: Promise<SetupPluginConfigModule> | undefined;

function loadSetupPluginConfigModule(): Promise<SetupPluginConfigModule> {
  setupPluginConfigModulePromise ??= import("../wizard/setup.plugin-config.js");
  return setupPluginConfigModulePromise;
}

function mergeWizardConfigOntoLatest(current: unknown, base: unknown, next: unknown): unknown {
  if (isDeepStrictEqual(next, base)) {
    return current;
  }
  if (isPlainObject(current) && isPlainObject(base) && isPlainObject(next)) {
    const merged: Record<string, unknown> = { ...current };
    const keys = new Set([...Object.keys(current), ...Object.keys(base), ...Object.keys(next)]);
    for (const key of keys) {
      const mergedValue = mergeWizardConfigOntoLatest(current[key], base[key], next[key]);
      if (mergedValue === undefined) {
        delete merged[key];
      } else {
        merged[key] = mergedValue;
      }
    }
    return merged;
  }
  return structuredClone(next);
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
  const localLinks = resolveControlUiLinks({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
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
      message: "Select sections to configure",
      options: [
        ...CONFIGURE_SECTION_OPTIONS,
        {
          value: "__continue",
          label: "Continue",
          hint: hasSelection ? "Done" : "Skip for now",
        },
      ],
      initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
    }),
    runtime,
  );
}

async function promptChannelMode(runtime: RuntimeEnv): Promise<ChannelsWizardMode> {
  return guardCancel(
    await select({
      message: "Channels",
      options: [
        {
          value: "configure",
          label: "Configure/link",
          hint: "Add/update channels; disable unselected accounts",
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
  const { resolveSearchProviderOptions, setupSearch } = await import("./onboard-search.js");
  const { isCodexNativeWebSearchRelevant } = await import("../agents/codex-native-web-search.js");
  const searchProviderOptions = resolveSearchProviderOptions(nextConfig);

  note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Choose a managed provider now, and Codex-capable models can also use native Codex web search.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = guardCancel(
    await confirm({
      message: "Enable web_search?",
      initialValue: existingSearch?.enabled ?? searchProviderOptions.length > 0,
    }),
    runtime,
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
          "Codex-capable models can optionally use native Codex web search.",
          "Managed web_search still controls non-Codex models.",
          "If no managed provider is configured, non-Codex models still rely on provider auto-detect and may have no search available.",
          ...(describeCodexNativeWebSearch(nextConfig)
            ? [describeCodexNativeWebSearch(nextConfig)!]
            : ["Recommended mode: cached."]),
        ].join("\n"),
        "Codex native search",
      );

      const enableCodexNative = guardCancel(
        await confirm({
          message: "Enable native Codex web search for Codex-capable models?",
          initialValue: existingSearch?.openaiCodex?.enabled === true,
        }),
        runtime,
      );

      if (enableCodexNative) {
        const codexMode = guardCancel(
          await select({
            message: "Codex native web search mode",
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
            message: "Configure or change a managed web search provider now?",
            initialValue: Boolean(existingSearch?.provider),
          }),
          runtime,
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

    if (searchProviderOptions.length === 0) {
      if (configureManagedProvider) {
        note(
          [
            "No web search providers are currently available under this plugin policy.",
            "Enable plugins or remove deny rules, then rerun configure.",
            "Docs: https://docs.openclaw.ai/tools/web",
          ].join("\n"),
          "Web search",
        );
      }
      if (nextSearch.openaiCodex?.enabled !== true) {
        nextSearch = {
          ...existingSearch,
          enabled: false,
        };
      }
    } else if (configureManagedProvider) {
      workingConfig = await setupSearch(workingConfig, runtime, prompter);
      nextSearch = {
        ...workingConfig.tools?.web?.search,
        enabled: workingConfig.tools?.web?.search?.provider ? true : existingSearch?.enabled,
        openaiCodex: {
          ...existingSearch?.openaiCodex,
          ...(nextSearch.openaiCodex as Record<string, unknown> | undefined),
        },
      };
    }
  }

  const enableFetch = guardCancel(
    await confirm({
      message: "Enable web_fetch (keyless HTTP fetch)?",
      initialValue: existingFetch?.enabled ?? true,
    }),
    runtime,
  );

  const nextFetch = {
    ...existingFetch,
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

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  try {
    intro(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
    const prompter = createClackPrompter();

    const snapshot = await readConfigFileSnapshot();
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

    const localUrl = "ws://127.0.0.1:18789";
    const baseLocalProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.token,
      path: "gateway.auth.token",
    });
    const baseLocalProbePassword = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
    });
    const localProbe = await probeGatewayReachable({
      url: localUrl,
      token: process.env.OPENCLAW_GATEWAY_TOKEN ?? baseLocalProbeToken,
      password: process.env.OPENCLAW_GATEWAY_PASSWORD ?? baseLocalProbePassword,
    });
    const remoteUrl = normalizeOptionalString(baseConfig.gateway?.remote?.url) ?? "";
    const baseRemoteProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.remote?.token,
      path: "gateway.remote.token",
    });
    const remoteProbe = remoteUrl
      ? await probeGatewayReachable({
          url: remoteUrl,
          token: baseRemoteProbeToken,
        })
      : null;

    const mode = guardCancel(
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
    );

    if (mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: opts.command,
        mode,
      });
      await replaceConfigFile({
        nextConfig: remoteConfig,
        ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
      });
      currentBaseHash = undefined;
      logConfigUpdated(runtime);
      outro("Remote gateway configured.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let mergeBaseConfig = structuredClone(baseConfig);
    let didSetGatewayMode = false;
    if (nextConfig.gateway?.mode !== "local") {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
      didSetGatewayMode = true;
    }
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPort(baseConfig);

    const persistConfig = async () => {
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode,
      });

      // Retry loop: if config was mutated by a plugin, re-read and merge before retry
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          await replaceConfigFile({
            nextConfig,
            ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
          });

          // After successful write, re-read the snapshot to get the new hash
          const freshSnapshot = await readConfigFileSnapshot();
          currentBaseHash = freshSnapshot.hash ?? undefined;
          mergeBaseConfig = structuredClone(nextConfig);

          logConfigUpdated(runtime);
          return;
        } catch (err) {
          if (err instanceof ConfigMutationConflictError && attempt < maxRetries - 1) {
            // Config was mutated externally (e.g. plugin wrote token during auth setup).
            // Re-read the on-disk config and merge plugin changes into nextConfig so
            // the retry won't silently overwrite them.
            const freshSnapshot = await readConfigFileSnapshot();
            currentBaseHash = freshSnapshot.hash ?? undefined;
            const diskConfig = freshSnapshot.valid
              ? (freshSnapshot.sourceConfig ?? freshSnapshot.config)
              : {};
            nextConfig = mergeWizardConfigOntoLatest(
              diskConfig,
              mergeBaseConfig,
              nextConfig,
            ) as OpenClawConfig;
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
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            workspace: workspaceDir,
          },
        },
      };
      await ensureWorkspaceAndSessions(workspaceDir, runtime);
    };

    const configureChannelsSection = async () => {
      const channelMode = await promptChannelMode(runtime);
      if (channelMode === "configure") {
        nextConfig = await setupChannels(nextConfig, runtime, prompter, {
          allowDisable: true,
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
          validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(portInput, 10);
    };

    if (opts.sections) {
      const selected = opts.sections;
      if (!selected || selected.length === 0) {
        outro("No changes selected.");
        return;
      }

      if (selected.includes("workspace")) {
        await configureWorkspace();
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
          workspaceDir: resolveUserPath(workspaceDir),
        });
      }

      if (selected.includes("skills")) {
        const wsDir = resolveUserPath(workspaceDir);
        nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
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
            workspaceDir: resolveUserPath(workspaceDir),
          });
          await persistConfig();
        }

        if (choice === "skills") {
          const wsDir = resolveUserPath(workspaceDir);
          nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
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
        outro("No changes selected.");
        return;
      }
    }

    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinks({
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
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
      url: links.wsUrl,
      token,
      password: newPassword,
    });
    if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) {
      gatewayProbe = await probeGatewayReachable({
        url: links.wsUrl,
        token,
        password: oldPassword,
      });
    }
    const gatewayStatusLine = gatewayProbe.ok
      ? "Gateway: reachable"
      : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;

    note(
      [
        `Web UI: ${links.httpUrl}`,
        `Gateway WS: ${links.wsUrl}`,
        gatewayStatusLine,
        "Docs: https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outro("Configure complete.");
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
