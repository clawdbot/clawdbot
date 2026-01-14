import path from "node:path";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  upsertAuthProfile,
} from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  type ClawdbotConfig,
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
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import {
  buildTokenProfileId,
  validateAnthropicSetupToken,
} from "./auth-token.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { applyGoogleGeminiModelDefault } from "./google-gemini-model-default.js";
import { healthCommand } from "./health.js";
import {
  applyAuthProfileConfig,
  applyMinimaxApiConfig,
  applyMinimaxConfig,
  applyMoonshotConfig,
  applyOpencodeZenConfig,
  applyOpenrouterConfig,
  applySyntheticConfig,
  applyZaiConfig,
  setAnthropicApiKey,
  setGeminiApiKey,
  setMinimaxApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setOpenrouterApiKey,
  setSyntheticApiKey,
  setZaiApiKey,
} from "./onboard-auth.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  randomToken,
} from "./onboard-helpers.js";
import type { AuthChoice, OnboardOptions } from "./onboard-types.js";
import { applyOpenAICodexModelDefault } from "./openai-codex-model-default.js";
import { ensureSystemdUserLingerNonInteractive } from "./systemd-linger.js";

type NonInteractiveApiKeySource = "flag" | "env" | "profile";

async function resolveApiKeyFromProfiles(params: {
  provider: string;
  cfg: ClawdbotConfig;
  agentDir?: string;
}): Promise<string | null> {
  const store = ensureAuthProfileStore(params.agentDir);
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  for (const profileId of order) {
    const cred = store.profiles[profileId];
    if (cred?.type !== "api_key") continue;
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (resolved?.apiKey) return resolved.apiKey;
  }
  return null;
}

async function resolveNonInteractiveApiKey(params: {
  provider: string;
  cfg: ClawdbotConfig;
  flagValue?: string;
  flagName: string;
  envVar: string;
  runtime: RuntimeEnv;
  agentDir?: string;
  allowProfile?: boolean;
}): Promise<{ key: string; source: NonInteractiveApiKeySource } | null> {
  const flagKey = params.flagValue?.trim();
  if (flagKey) return { key: flagKey, source: "flag" };

  const envResolved = resolveEnvApiKey(params.provider);
  if (envResolved?.apiKey) return { key: envResolved.apiKey, source: "env" };

  if (params.allowProfile ?? true) {
    const profileKey = await resolveApiKeyFromProfiles({
      provider: params.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    if (profileKey) return { key: profileKey, source: "profile" };
  }

  const profileHint =
    params.allowProfile === false
      ? ""
      : `, or existing ${params.provider} API-key profile`;
  params.runtime.error(
    `Missing ${params.flagName} (or ${params.envVar} in env${profileHint}).`,
  );
  params.runtime.exit(1);
  return null;
}

export async function runNonInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    runtime.error(
      "Config invalid. Run `clawdbot doctor` to repair it, then re-run onboarding.",
    );
    runtime.exit(1);
    return;
  }
  const baseConfig: ClawdbotConfig = snapshot.valid ? snapshot.config : {};
  const mode = opts.mode ?? "local";
  if (mode !== "local" && mode !== "remote") {
    runtime.error(`Invalid --mode "${String(mode)}" (use local|remote).`);
    runtime.exit(1);
    return;
  }

  if (mode === "remote") {
    const remoteUrl = opts.remoteUrl?.trim();
    if (!remoteUrl) {
      runtime.error("Missing --remote-url for remote mode.");
      runtime.exit(1);
      return;
    }

    let nextConfig: ClawdbotConfig = {
      ...baseConfig,
      gateway: {
        ...baseConfig.gateway,
        mode: "remote",
        remote: {
          url: remoteUrl,
          token: opts.remoteToken?.trim() || undefined,
        },
      },
    };
    nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

    const payload = {
      mode,
      remoteUrl,
      auth: opts.remoteToken ? "token" : "none",
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    } else {
      runtime.log(`Remote gateway: ${remoteUrl}`);
      runtime.log(`Auth: ${payload.auth}`);
    }
    return;
  }

  const workspaceDir = resolveUserPath(
    (
      opts.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE
    ).trim(),
  );

  let nextConfig: ClawdbotConfig = {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };

  const authChoice: AuthChoice = opts.authChoice ?? "skip";
  if (authChoice === "token") {
    const providerRaw = opts.tokenProvider?.trim();
    if (!providerRaw) {
      runtime.error("Missing --token-provider for --auth-choice token.");
      runtime.exit(1);
      return;
    }
    const provider = normalizeProviderId(providerRaw);
    if (provider !== "anthropic") {
      runtime.error(
        "Only --token-provider anthropic is supported for --auth-choice token.",
      );
      runtime.exit(1);
      return;
    }
    const tokenRaw = opts.token?.trim();
    if (!tokenRaw) {
      runtime.error("Missing --token for --auth-choice token.");
      runtime.exit(1);
      return;
    }
    const tokenError = validateAnthropicSetupToken(tokenRaw);
    if (tokenError) {
      runtime.error(tokenError);
      runtime.exit(1);
      return;
    }

    let expires: number | undefined;
    const expiresInRaw = opts.tokenExpiresIn?.trim();
    if (expiresInRaw) {
      try {
        expires =
          Date.now() + parseDurationMs(expiresInRaw, { defaultUnit: "d" });
      } catch (err) {
        runtime.error(`Invalid --token-expires-in: ${String(err)}`);
        runtime.exit(1);
        return;
      }
    }

    const profileId =
      opts.tokenProfileId?.trim() ||
      buildTokenProfileId({ provider, name: "" });
    upsertAuthProfile({
      profileId,
      credential: {
        type: "token",
        provider,
        token: tokenRaw.trim(),
        ...(expires ? { expires } : {}),
      },
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider,
      mode: "token",
    });
  } else if (authChoice === "apiKey") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "anthropic",
      cfg: baseConfig,
      flagValue: opts.anthropicApiKey,
      flagName: "--anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setAnthropicApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  } else if (authChoice === "gemini-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "google",
      cfg: baseConfig,
      flagValue: opts.geminiApiKey,
      flagName: "--gemini-api-key",
      envVar: "GEMINI_API_KEY",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setGeminiApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    nextConfig = applyGoogleGeminiModelDefault(nextConfig).next;
  } else if (authChoice === "zai-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "zai",
      cfg: baseConfig,
      flagValue: opts.zaiApiKey,
      flagName: "--zai-api-key",
      envVar: "ZAI_API_KEY",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setZaiApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "zai:default",
      provider: "zai",
      mode: "api_key",
    });
    nextConfig = applyZaiConfig(nextConfig);
  } else if (authChoice === "openai-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "openai",
      cfg: baseConfig,
      flagValue: opts.openaiApiKey,
      flagName: "--openai-api-key",
      envVar: "OPENAI_API_KEY",
      runtime,
      allowProfile: false,
    });
    if (!resolved) return;
    const key = resolved.key;
    const result = upsertSharedEnvVar({
      key: "OPENAI_API_KEY",
      value: key,
    });
    process.env.OPENAI_API_KEY = key;
    runtime.log(`Saved OPENAI_API_KEY to ${result.path}`);
  } else if (authChoice === "openrouter-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "openrouter",
      cfg: baseConfig,
      flagValue: opts.openrouterApiKey,
      flagName: "--openrouter-api-key",
      envVar: "OPENROUTER_API_KEY",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setOpenrouterApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "openrouter:default",
      provider: "openrouter",
      mode: "api_key",
    });
    nextConfig = applyOpenrouterConfig(nextConfig);
  } else if (authChoice === "moonshot-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "moonshot",
      cfg: baseConfig,
      flagValue: opts.moonshotApiKey,
      flagName: "--moonshot-api-key",
      envVar: "MOONSHOT_API_KEY",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setMoonshotApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "moonshot:default",
      provider: "moonshot",
      mode: "api_key",
    });
    nextConfig = applyMoonshotConfig(nextConfig);
  } else if (authChoice === "synthetic-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "synthetic",
      cfg: baseConfig,
      flagValue: opts.syntheticApiKey,
      flagName: "--synthetic-api-key",
      envVar: "SYNTHETIC_API_KEY",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setSyntheticApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "synthetic:default",
      provider: "synthetic",
      mode: "api_key",
    });
    nextConfig = applySyntheticConfig(nextConfig);
  } else if (
    authChoice === "minimax-cloud" ||
    authChoice === "minimax-api" ||
    authChoice === "minimax-api-lightning"
  ) {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "minimax",
      cfg: baseConfig,
      flagValue: opts.minimaxApiKey,
      flagName: "--minimax-api-key",
      envVar: "MINIMAX_API_KEY",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setMinimaxApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    const modelId =
      authChoice === "minimax-api-lightning"
        ? "MiniMax-M2.1-lightning"
        : "MiniMax-M2.1";
    nextConfig = applyMinimaxApiConfig(nextConfig, modelId);
  } else if (authChoice === "claude-cli") {
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    if (!store.profiles[CLAUDE_CLI_PROFILE_ID]) {
      runtime.error(
        process.platform === "darwin"
          ? 'No Claude CLI credentials found. Run interactive onboarding to approve Keychain access for "Claude Code-credentials".'
          : "No Claude CLI credentials found at ~/.claude/.credentials.json",
      );
      runtime.exit(1);
      return;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "token",
    });
  } else if (authChoice === "codex-cli") {
    const store = ensureAuthProfileStore();
    if (!store.profiles[CODEX_CLI_PROFILE_ID]) {
      runtime.error("No Codex CLI credentials found at ~/.codex/auth.json");
      runtime.exit(1);
      return;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CODEX_CLI_PROFILE_ID,
      provider: "openai-codex",
      mode: "oauth",
    });
    nextConfig = applyOpenAICodexModelDefault(nextConfig).next;
  } else if (authChoice === "minimax") {
    nextConfig = applyMinimaxConfig(nextConfig);
  } else if (authChoice === "opencode-zen") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "opencode",
      cfg: baseConfig,
      flagValue: opts.opencodeZenApiKey,
      flagName: "--opencode-zen-api-key",
      envVar: "OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY)",
      runtime,
    });
    if (!resolved) return;
    if (resolved.source !== "profile") {
      await setOpencodeZenApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "opencode:default",
      provider: "opencode",
      mode: "api_key",
    });
    nextConfig = applyOpencodeZenConfig(nextConfig);
  } else if (
    authChoice === "oauth" ||
    authChoice === "chutes" ||
    authChoice === "openai-codex" ||
    authChoice === "antigravity"
  ) {
    const label = authChoice === "antigravity" ? "Antigravity" : "OAuth";
    runtime.error(`${label} requires interactive mode.`);
    runtime.exit(1);
    return;
  }

  const hasGatewayPort = opts.gatewayPort !== undefined;
  if (
    hasGatewayPort &&
    (!Number.isFinite(opts.gatewayPort) || (opts.gatewayPort ?? 0) <= 0)
  ) {
    runtime.error("Invalid --gateway-port");
    runtime.exit(1);
    return;
  }
  const port = hasGatewayPort
    ? (opts.gatewayPort as number)
    : resolveGatewayPort(baseConfig);
  let bind = opts.gatewayBind ?? "loopback";
  let authMode = opts.gatewayAuth ?? "token";
  const tailscaleMode = opts.tailscale ?? "off";
  const tailscaleResetOnExit = Boolean(opts.tailscaleResetOnExit);

  if (tailscaleMode !== "off" && bind !== "loopback") {
    bind = "loopback";
  }
  if (authMode === "off" && bind !== "loopback") {
    authMode = "token";
  }
  if (tailscaleMode === "funnel" && authMode !== "password") {
    authMode = "password";
  }

  let gatewayToken = opts.gatewayToken?.trim() || undefined;
  if (authMode === "token") {
    if (!gatewayToken) gatewayToken = randomToken();
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayToken,
        },
      },
    };
  }
  if (authMode === "password") {
    const password = opts.gatewayPassword?.trim();
    if (!password) {
      runtime.error("Missing --gateway-password for password auth.");
      runtime.exit(1);
      return;
    }
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind,
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  if (!opts.skipSkills) {
    const nodeManager = opts.nodeManager ?? "npm";
    if (!["npm", "pnpm", "bun"].includes(nodeManager)) {
      runtime.error("Invalid --node-manager (use npm, pnpm, or bun)");
      runtime.exit(1);
      return;
    }
    nextConfig = {
      ...nextConfig,
      skills: {
        ...nextConfig.skills,
        install: {
          ...nextConfig.skills?.install,
          nodeManager,
        },
      },
    };
  }

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;

  if (opts.installDaemon) {
    const systemdAvailable =
      process.platform === "linux"
        ? await isSystemdUserServiceAvailable()
        : true;
    if (process.platform === "linux" && !systemdAvailable) {
      runtime.log(
        "Systemd user services are unavailable; skipping daemon install.",
      );
    } else {
      if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
        runtime.error("Invalid --daemon-runtime (use node or bun)");
        runtime.exit(1);
        return;
      }
      const service = resolveGatewayService();
      const devMode =
        process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
        process.argv[1]?.endsWith(".ts");
      const nodePath = await resolvePreferredNodePath({
        env: process.env,
        runtime: daemonRuntimeRaw,
      });
      const { programArguments, workingDirectory } =
        await resolveGatewayProgramArguments({
          port,
          dev: devMode,
          runtime: daemonRuntimeRaw,
          nodePath,
        });
      if (daemonRuntimeRaw === "node") {
        const systemNode = await resolveSystemNodeInfo({ env: process.env });
        const warning = renderSystemNodeWarning(
          systemNode,
          programArguments[0],
        );
        if (warning) runtime.log(warning);
      }
      const environment = buildServiceEnvironment({
        env: process.env,
        port,
        token: gatewayToken,
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
      await ensureSystemdUserLingerNonInteractive({ runtime });
    }
  }

  if (!opts.skipHealth) {
    await sleep(1000);
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  }

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          mode,
          workspace: workspaceDir,
          authChoice,
          gateway: { port, bind, authMode, tailscaleMode },
          installDaemon: Boolean(opts.installDaemon),
          daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
          skipSkills: Boolean(opts.skipSkills),
          skipHealth: Boolean(opts.skipHealth),
        },
        null,
        2,
      ),
    );
  }
}
