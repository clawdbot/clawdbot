import path from "node:path";

import {
  confirm as clackConfirm,
  intro as clackIntro,
  multiselect as clackMultiselect,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { listChatProviders } from "../providers/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
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
import { buildAuthChoiceOptions } from "./auth-choice-options.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { healthCommand } from "./health.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { applyPrimaryModel, promptDefaultModel } from "./model-picker.js";
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
import { setupProviders } from "./onboard-providers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";
import type { AuthChoice } from "./onboard-types.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "gateway",
  "daemon",
  "providers",
  "skills",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];

type ProvidersWizardMode = "configure" | "remove";

type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

const intro = (message: string) =>
  clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) =>
  clackOutro(stylePromptTitle(message) ?? message);
const note = (message: string, title?: string) =>
  clackNote(message, stylePromptTitle(title));
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
const multiselect = <T>(params: Parameters<typeof clackMultiselect<T>>[0]) =>
  clackMultiselect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined
        ? opt
        : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

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
      message: "Gateway bind",
      options: [
        { value: "loopback", label: "Loopback (127.0.0.1)" },
        { value: "lan", label: "LAN" },
        { value: "tailnet", label: "Tailnet" },
        { value: "auto", label: "Auto" },
      ],
    }),
    runtime,
  ) as "loopback" | "lan" | "tailnet" | "auto";

  let authMode = guardCancel(
    await select({
      message: "Gateway auth",
      options: [
        { value: "off", label: "Off (loopback only)" },
        { value: "token", label: "Token" },
        { value: "password", label: "Password" },
      ],
    }),
    runtime,
  ) as "off" | "token" | "password";

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
    next = {
      ...next,
      gateway: {
        ...next.gateway,
        auth: { ...next.gateway?.auth, mode: "token", token: gatewayToken },
      },
    };
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "Gateway password",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    next = {
      ...next,
      gateway: {
        ...next.gateway,
        auth: {
          ...next.gateway?.auth,
          mode: "password",
          password: String(password).trim(),
        },
      },
    };
  }

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      port,
      bind,
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
  const authChoice: AuthChoice = await prompter.select({
    message: "Model/auth choice",
    options: buildAuthChoiceOptions({
      store: ensureAuthProfileStore(undefined, {
        allowKeychainPrompt: false,
      }),
      includeSkip: true,
      includeClaudeCliIfMissing: true,
    }),
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
  const loaded = await service.isLoaded({ env: process.env });
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
      await service.restart({ stdout: process.stdout });
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
    const environment = buildServiceEnvironment({
      env: process.env,
      port: params.port,
      token: params.gatewayToken,
      launchdLabel:
        process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
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

async function removeProviderConfigWizard(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig> {
  let next = { ...cfg };

  const listConfiguredProviders = () =>
    listChatProviders().filter((meta) => {
      const value = (next as Record<string, unknown>)[meta.id];
      return value !== undefined;
    });

  while (true) {
    const configured = listConfiguredProviders();
    if (configured.length === 0) {
      note(
        [
          "No provider config found in clawdbot.json.",
          "Tip: `clawdbot providers status` shows what is configured and enabled.",
        ].join("\n"),
        "Remove provider",
      );
      return next;
    }

    const provider = guardCancel(
      await select({
        message: "Remove which provider config?",
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

    if (provider === "done") return next;

    const label =
      listChatProviders().find((meta) => meta.id === provider)?.label ??
      provider;
    const confirmed = guardCancel(
      await confirm({
        message: `Delete ${label} configuration from ${CONFIG_PATH_CLAWDBOT}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!confirmed) continue;

    const clone = { ...next } as Record<string, unknown>;
    delete clone[provider];
    next = clone as ClawdbotConfig;

    note(
      [
        `${label} removed from config.`,
        "Note: credentials/sessions on disk are unchanged.",
      ].join("\n"),
      "Provider removed",
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
    let baseConfig: ClawdbotConfig = snapshot.valid ? snapshot.config : {};

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
        const reset = guardCancel(
          await confirm({
            message: "Config invalid. Start fresh?",
            initialValue: true,
          }),
          runtime,
        );
        if (reset) baseConfig = {};
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

    const selected = opts.sections
      ? opts.sections
      : (guardCancel(
          await multiselect({
            message: "Select sections to configure",
            options: [
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
                value: "providers",
                label: "Providers",
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
                hint: "Run gateway + provider checks",
              },
            ],
          }),
          runtime,
        ) as WizardSection[]);

    if (!selected || selected.length === 0) {
      outro("No changes selected.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPort(baseConfig);
    let gatewayToken: string | undefined;

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

    if (selected.includes("providers")) {
      const providerMode = guardCancel(
        await select({
          message: "Providers",
          options: [
            {
              value: "configure",
              label: "Configure/link",
              hint: "Add/update providers; disable unselected accounts",
            },
            {
              value: "remove",
              label: "Remove provider config",
              hint: "Delete provider tokens/settings from clawdbot.json",
            },
          ],
          initialValue: "configure",
        }),
        runtime,
      ) as ProvidersWizardMode;

      if (providerMode === "configure") {
        nextConfig = await setupProviders(nextConfig, runtime, prompter, {
          allowDisable: true,
          allowSignalInstall: true,
        });
      } else {
        nextConfig = await removeProviderConfigWizard(nextConfig, runtime);
      }
    }

    if (selected.includes("skills")) {
      const wsDir = resolveUserPath(workspaceDir);
      nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
    }

    nextConfig = applyWizardMetadata(nextConfig, {
      command: opts.command,
      mode,
    });
    await writeConfigFile(nextConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

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

    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinks({
      bind,
      port: gatewayPort,
      basePath: nextConfig.gateway?.controlUi?.basePath,
    });
    const gatewayProbe = await probeGatewayReachable({
      url: links.wsUrl,
      token:
        nextConfig.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
      password:
        nextConfig.gateway?.auth?.password ??
        process.env.CLAWDBOT_GATEWAY_PASSWORD,
    });
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
