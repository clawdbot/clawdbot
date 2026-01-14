import path from "node:path";

import {
  confirm as clackConfirm,
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { listChatChannels } from "../channels/registry.js";
import type { ClawdbotConfig, GatewayAuthConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import {
  stylePromptHint,
  stylePromptMessage,
  stylePromptTitle,
} from "../terminal/prompt-style.js";
import { resolveUserPath, sleep } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import {
  WizardCancelledError,
  type WizardPrompter,
} from "../wizard/prompts.js";
import {
  applyAuthChoice,
  resolvePreferredProviderForAuthChoice,
} from "./auth-choice.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { healthCommand } from "./health.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { applyPrimaryModel, promptDefaultModel } from "./model-picker.js";
import { setupChannels } from "./onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  printWizardHeader,
  probeGatewayReachable,
  randomToken,
  resolveControlUiLinks,
  summarizeExistingConfig,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "gateway",
  "daemon",
  "channels",
  "skills",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];

type ChannelsWizardMode = "configure" | "remove";

type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

const intro = (message: string) =>
  clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) =>
  clackOutro(stylePromptTitle(message) ?? message);
const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined
        ? opt
        : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

const CONFIGURE_SECTION_OPTIONS: {
  value: WizardSection;
  label: string;
  hint: string;
}[] = [
  {
    value: "workspace",
    label: "Workspace",
    hint: "Set default workspace + ensure sessions",
  },
  {
    value: "model",
    label: "Model/auth",
    hint: "Pick model + auth profile sources",
  },
  {
    value: "gateway",
    label: "Gateway config",
    hint: "Port/bind/auth/control UI settings",
  },
  {
    value: "daemon",
    label: "Gateway daemon",
    hint: "Install/manage the background service",
  },
  {
    value: "channels",
    label: "Channels",
    hint: "Link WhatsApp/Telegram/etc and defaults",
  },
  {
    value: "skills",
    label: "Skills",
    hint: "Install/enable workspace skills",
  },
  {
    value: "health",
    label: "Health check",
    hint: "Run gateway + channel checks",
  },
];

type ConfigureSectionChoice = WizardSection | "__continue";

type GatewayAuthChoice = "off" | "token" | "password";

export function buildGatewayAuthConfig(params: {
  existing?: GatewayAuthConfig;
  mode: GatewayAuthChoice;
  token?: string;
  password?: string;
}): GatewayAuthConfig | undefined {
  const allowTailscale = params.existing?.allowTailscale;
  const base: GatewayAuthConfig = {};
  if (typeof allowTailscale === "boolean") base.allowTailscale = allowTailscale;

  if (params.mode === "off") {
    return Object.keys(base).length > 0 ? base : undefined;
  }
  if (params.mode === "token") {
    return { ...base, mode: "token", token: params.token };
  }
  return { ...base, mode: "password", password: params.password };
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

async function promptGatewayConfig(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: ClawdbotConfig;
  port: number;
  token?: string;
}> {
  const portRaw = guardCancel(
    await text({
      message: "Gateway port",
      initialValue: String(resolveGatewayPort(cfg)),
      validate: (value) =>
        Number.isFinite(Number(value)) ? undefined : "Invalid port",
    }),
    runtime,
  );
  const port = Number.parseInt(String(portRaw), 10);

  let bind = guardCancel(
    await select({
      message: "Gateway bind mode",
      options: [
        {
          value: "auto",
          label: "Auto (Tailnet → LAN)",
          hint: "Prefer Tailnet IP, fall back to all interfaces if unavailable",
        },
        {
          value: "lan",
          label: "LAN (All interfaces)",
          hint: "Bind to 0.0.0.0 - accessible from anywhere on your network",
        },
        {
          value: "loopback",
          label: "Loopback (Local only)",
          hint: "Bind to 127.0.0.1 - secure, local-only access",
        },
        {
          value: "custom",
          label: "Custom IP",
          hint: "Specify a specific IP address, with 0.0.0.0 fallback if unavailable",
        },
      ],
    }),
    runtime,
  ) as "auto" | "lan" | "loopback" | "custom";

  let customBindHost: string | undefined;
  if (bind === "custom") {
    const input = guardCancel(
      await text({
        message: "Custom IP address",
        placeholder: "192.168.1.100",
        validate: (value) => {
          if (!value) return "IP address is required for custom bind mode";
          const trimmed = value.trim();
          const parts = trimmed.split(".");
          if (parts.length !== 4)
            return "Invalid IPv4 address (e.g., 192.168.1.100)";
          if (
            parts.every((part) => {
              const n = parseInt(part, 10);
              return (
                !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n)
              );
            })
          )
            return undefined;
          return "Invalid IPv4 address (each octet must be 0-255)";
        },
      }),
      runtime,
    );
    customBindHost = typeof input === "string" ? input : undefined;
  }

  let authMode = guardCancel(
    await select({
      message: "Gateway auth",
      options: [
        {
          value: "off",
          label: "Off (loopback only)",
          hint: "Not recommended unless you fully trust local processes",
        },
        { value: "token", label: "Token", hint: "Recommended default" },
        { value: "password", label: "Password" },
      ],
      initialValue: "token",
    }),
    runtime,
  ) as GatewayAuthChoice;

  const tailscaleMode = guardCancel(
    await select({
      message: "Tailscale exposure",
      options: [
        { value: "off", label: "Off", hint: "No Tailscale exposure" },
        {
          value: "serve",
          label: "Serve",
          hint: "Private HTTPS for your tailnet (devices on Tailscale)",
        },
        {
          value: "funnel",
          label: "Funnel",
          hint: "Public HTTPS via Tailscale Funnel (internet)",
        },
      ],
    }),
    runtime,
  ) as "off" | "serve" | "funnel";

  // Detect Tailscale binary before proceeding with serve/funnel setup
  if (tailscaleMode !== "off") {
    const tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      note(
        [
          "Tailscale binary not found in PATH or /Applications.",
          "Ensure Tailscale is installed from:",
          "  https://tailscale.com/download/mac",
          "",
          "You can continue setup, but serve/funnel will fail at runtime.",
        ].join("\n"),
        "Tailscale Warning",
      );
    }
  }

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    note(
      [
        "Docs:",
        "https://docs.clawd.bot/gateway/tailscale",
        "https://docs.clawd.bot/web",
      ].join("\n"),
      "Tailscale",
    );
    tailscaleResetOnExit = Boolean(
      guardCancel(
        await confirm({
          message: "Reset Tailscale serve/funnel on exit?",
          initialValue: false,
        }),
        runtime,
      ),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note(
      "Tailscale requires bind=loopback. Adjusting bind to loopback.",
      "Note",
    );
    bind = "loopback";
  }

  if (authMode === "off" && bind !== "loopback") {
    note("Non-loopback bind requires auth. Switching to token auth.", "Note");
    authMode = "token";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  let gatewayPassword: string | undefined;
  let next = cfg;

  if (authMode === "token") {
    const tokenInput = guardCancel(
      await text({
        message: "Gateway token (blank to generate)",
        initialValue: randomToken(),
      }),
      runtime,
    );
    gatewayToken = String(tokenInput).trim() || randomToken();
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "Gateway password",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    gatewayPassword = String(password).trim();
  }

  const authConfig = buildGatewayAuthConfig({
    existing: next.gateway?.auth,
    mode: authMode,
    token: gatewayToken,
    password: gatewayPassword,
  });

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      port,
      bind,
      auth: authConfig,
      ...(customBindHost && { customBindHost }),
      tailscale: {
        ...next.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return { config: next, port, token: gatewayToken };
}

async function promptAuthConfig(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<ClawdbotConfig> {
  const authChoice = await promptAuthChoiceGrouped({
    prompter,
    store: ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    }),
    includeSkip: true,
    includeClaudeCliIfMissing: true,
  });

  let next = cfg;
  if (authChoice !== "skip") {
    const applied = await applyAuthChoice({
      authChoice,
      config: next,
      prompter,
      runtime,
      setDefaultModel: true,
    });
    next = applied.config;
    // Auth choice already set a sensible default model; skip the model picker.
    return next;
  }

  const modelSelection = await promptDefaultModel({
    config: next,
    prompter,
    allowKeep: true,
    ignoreAllowlist: true,
    preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
  });
  if (modelSelection.model) {
    next = applyPrimaryModel(next, modelSelection.model);
  }

  return next;
}

async function maybeInstallDaemon(params: {
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
  daemonRuntime?: GatewayDaemonRuntime;
}) {
  const service = resolveGatewayService();
  const loaded = await service.isLoaded({
    env: process.env,
    profile: process.env.CLAWDBOT_PROFILE,
  });
  let shouldCheckLinger = false;
  let shouldInstall = true;
  let daemonRuntime = params.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (loaded) {
    const action = guardCancel(
      await select({
        message: "Gateway service already installed",
        options: [
          { value: "restart", label: "Restart" },
          { value: "reinstall", label: "Reinstall" },
          { value: "skip", label: "Skip" },
        ],
      }),
      params.runtime,
    );
    if (action === "restart") {
      await service.restart({
        env: process.env,
        profile: process.env.CLAWDBOT_PROFILE,
        stdout: process.stdout,
      });
      shouldCheckLinger = true;
      shouldInstall = false;
    }
    if (action === "skip") return;
    if (action === "reinstall") {
      await service.uninstall({ env: process.env, stdout: process.stdout });
    }
  }

  if (shouldInstall) {
    if (!params.daemonRuntime) {
      daemonRuntime = guardCancel(
        await select({
          message: "Gateway daemon runtime",
          options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
          initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
        }),
        params.runtime,
      ) as GatewayDaemonRuntime;
    }
    const devMode =
      process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
      process.argv[1]?.endsWith(".ts");
    const nodePath = await resolvePreferredNodePath({
      env: process.env,
      runtime: daemonRuntime,
    });
    const { programArguments, workingDirectory } =
      await resolveGatewayProgramArguments({
        port: params.port,
        dev: devMode,
        runtime: daemonRuntime,
        nodePath,
      });
    if (daemonRuntime === "node") {
      const systemNode = await resolveSystemNodeInfo({ env: process.env });
      const warning = renderSystemNodeWarning(systemNode, programArguments[0]);
      if (warning) note(warning, "Gateway runtime");
    }
    const environment = buildServiceEnvironment({
      env: process.env,
      port: params.port,
      token: params.gatewayToken,
      launchdLabel:
        process.platform === "darwin"
          ? resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE)
          : undefined,
    });
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
    shouldCheckLinger = true;
  }

  if (shouldCheckLinger) {
    await ensureSystemdUserLingerInteractive({
      runtime: params.runtime,
      prompter: {
        confirm: async (p) =>
          guardCancel(await confirm(p), params.runtime) === true,
        note,
      },
      reason:
        "Linux installs use a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
      requireConfirm: true,
    });
  }
}

async function removeChannelConfigWizard(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig> {
  let next = { ...cfg };

  const listConfiguredChannels = () =>
    listChatChannels().filter((meta) => next.channels?.[meta.id] !== undefined);

  while (true) {
    const configured = listConfiguredChannels();
    if (configured.length === 0) {
      note(
        [
          "No channel config found in clawdbot.json.",
          "Tip: `clawdbot channels status` shows what is configured and enabled.",
        ].join("\n"),
        "Remove channel",
      );
      return next;
    }

    const channel = guardCancel(
      await select({
        message: "Remove which channel config?",
        options: [
          ...configured.map((meta) => ({
            value: meta.id,
            label: meta.label,
            hint: "Deletes tokens + settings from config (credentials stay on disk)",
          })),
          { value: "done", label: "Done" },
        ],
      }),
      runtime,
    ) as string;

    if (channel === "done") return next;

    const label =
      listChatChannels().find((meta) => meta.id === channel)?.label ?? channel;
    const confirmed = guardCancel(
      await confirm({
        message: `Delete ${label} configuration from ${CONFIG_PATH_CLAWDBOT}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!confirmed) continue;

    const nextChannels: Record<string, unknown> = { ...next.channels };
    delete nextChannels[channel];
    next = {
      ...next,
      channels: Object.keys(nextChannels).length
        ? (nextChannels as ClawdbotConfig["channels"])
        : undefined,
    };

    note(
      [
        `${label} removed from config.`,
        "Note: credentials/sessions on disk are unchanged.",
      ].join("\n"),
      "Channel removed",
    );
  }
}

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  try {
    printWizardHeader(runtime);
    intro(
      opts.command === "update"
        ? "Clawdbot update wizard"
        : "Clawdbot configure",
    );
    const prompter = createClackPrompter();

    const snapshot = await readConfigFileSnapshot();
    const baseConfig: ClawdbotConfig = snapshot.valid ? snapshot.config : {};

    if (snapshot.exists) {
      const title = snapshot.valid
        ? "Existing config detected"
        : "Invalid config";
      note(summarizeExistingConfig(baseConfig), title);
      if (!snapshot.valid && snapshot.issues.length > 0) {
        note(
          [
            ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
            "",
            "Docs: https://docs.clawd.bot/gateway/configuration",
          ].join("\n"),
          "Config issues",
        );
      }
      if (!snapshot.valid) {
        outro(
          "Config invalid. Run `clawdbot doctor` to repair it, then re-run configure.",
        );
        runtime.exit(1);
        return;
      }
    }

    const localUrl = "ws://127.0.0.1:18789";
    const localProbe = await probeGatewayReachable({
      url: localUrl,
      token:
        baseConfig.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
      password:
        baseConfig.gateway?.auth?.password ??
        process.env.CLAWDBOT_GATEWAY_PASSWORD,
    });
    const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
    const remoteProbe = remoteUrl
      ? await probeGatewayReachable({
          url: remoteUrl,
          token: baseConfig.gateway?.remote?.token,
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
    ) as "local" | "remote";

    if (mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(remoteConfig);
      runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
      outro("Remote gateway configured.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPort(baseConfig);
    let gatewayToken: string | undefined =
      nextConfig.gateway?.auth?.token ??
      baseConfig.gateway?.auth?.token ??
      process.env.CLAWDBOT_GATEWAY_TOKEN;

    const persistConfig = async () => {
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(nextConfig);
      runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
    };

    if (opts.sections) {
      const selected = opts.sections;
      if (!selected || selected.length === 0) {
        outro("No changes selected.");
        return;
      }

      if (selected.includes("workspace")) {
        const workspaceInput = guardCancel(
          await text({
            message: "Workspace directory",
            initialValue: workspaceDir,
          }),
          runtime,
        );
        workspaceDir = resolveUserPath(
          String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE,
        );
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
      }

      if (selected.includes("model")) {
        nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("gateway")) {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
        gatewayToken = gateway.token;
      }

      if (selected.includes("channels")) {
        const channelMode = guardCancel(
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
                hint: "Delete channel tokens/settings from clawdbot.json",
              },
            ],
            initialValue: "configure",
          }),
          runtime,
        ) as ChannelsWizardMode;

        if (channelMode === "configure") {
          nextConfig = await setupChannels(nextConfig, runtime, prompter, {
            allowDisable: true,
            allowSignalInstall: true,
          });
        } else {
          nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
        }
      }

      if (selected.includes("skills")) {
        const wsDir = resolveUserPath(workspaceDir);
        nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
      }

      await persistConfig();

      if (selected.includes("daemon")) {
        if (!selected.includes("gateway")) {
          const portInput = guardCancel(
            await text({
              message: "Gateway port for daemon install",
              initialValue: String(gatewayPort),
              validate: (value) =>
                Number.isFinite(Number(value)) ? undefined : "Invalid port",
            }),
            runtime,
          );
          gatewayPort = Number.parseInt(String(portInput), 10);
        }

        await maybeInstallDaemon({
          runtime,
          port: gatewayPort,
          gatewayToken,
        });
      }

      if (selected.includes("health")) {
        await sleep(1000);
        try {
          await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
        } catch (err) {
          runtime.error(formatHealthCheckFailure(err));
          note(
            [
              "Docs:",
              "https://docs.clawd.bot/gateway/health",
              "https://docs.clawd.bot/gateway/troubleshooting",
            ].join("\n"),
            "Health check help",
          );
        }
      }
    } else {
      let ranSection = false;
      let didConfigureGateway = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection);
        if (choice === "__continue") break;
        ranSection = true;

        if (choice === "workspace") {
          const workspaceInput = guardCancel(
            await text({
              message: "Workspace directory",
              initialValue: workspaceDir,
            }),
            runtime,
          );
          workspaceDir = resolveUserPath(
            String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE,
          );
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
          await persistConfig();
        }

        if (choice === "model") {
          nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "gateway") {
          const gateway = await promptGatewayConfig(nextConfig, runtime);
          nextConfig = gateway.config;
          gatewayPort = gateway.port;
          gatewayToken = gateway.token;
          didConfigureGateway = true;
          await persistConfig();
        }

        if (choice === "channels") {
          const channelMode = guardCancel(
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
                  hint: "Delete channel tokens/settings from clawdbot.json",
                },
              ],
              initialValue: "configure",
            }),
            runtime,
          ) as ChannelsWizardMode;

          if (channelMode === "configure") {
            nextConfig = await setupChannels(nextConfig, runtime, prompter, {
              allowDisable: true,
              allowSignalInstall: true,
            });
          } else {
            nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
          }
          await persistConfig();
        }

        if (choice === "skills") {
          const wsDir = resolveUserPath(workspaceDir);
          nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
          await persistConfig();
        }

        if (choice === "daemon") {
          if (!didConfigureGateway) {
            const portInput = guardCancel(
              await text({
                message: "Gateway port for daemon install",
                initialValue: String(gatewayPort),
                validate: (value) =>
                  Number.isFinite(Number(value)) ? undefined : "Invalid port",
              }),
              runtime,
            );
            gatewayPort = Number.parseInt(String(portInput), 10);
          }

          await maybeInstallDaemon({
            runtime,
            port: gatewayPort,
            gatewayToken,
          });
        }

        if (choice === "health") {
          await sleep(1000);
          try {
            await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
          } catch (err) {
            runtime.error(formatHealthCheckFailure(err));
            note(
              [
                "Docs:",
                "https://docs.clawd.bot/gateway/health",
                "https://docs.clawd.bot/gateway/troubleshooting",
              ].join("\n"),
              "Health check help",
            );
          }
        }
      }

      if (!ranSection) {
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
    // Try both new and old passwords since gateway may still have old config
    const newPassword =
      nextConfig.gateway?.auth?.password ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD;
    const oldPassword =
      baseConfig.gateway?.auth?.password ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD;
    const token =
      nextConfig.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN;

    let gatewayProbe = await probeGatewayReachable({
      url: links.wsUrl,
      token,
      password: newPassword,
    });
    // If new password failed and it's different from old password, try old too
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
        "Docs: https://docs.clawd.bot/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outro("Configure complete.");
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(0);
      return;
    }
    throw err;
  }
}

export async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  await runConfigureWizard({ command: "configure" }, runtime);
}

export async function configureCommandWithSections(
  sections: WizardSection[],
  runtime: RuntimeEnv = defaultRuntime,
) {
  await runConfigureWizard({ command: "configure", sections }, runtime);
}
