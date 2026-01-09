import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
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
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { applyGoogleGeminiModelDefault } from "./google-gemini-model-default.js";
import { healthCommand } from "./health.js";
import {
  applyAuthProfileConfig,
  applyMinimaxConfig,
  applyMinimaxHostedConfig,
  setAnthropicApiKey,
  setGeminiApiKey,
  setMinimaxApiKey,
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

export async function runNonInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const snapshot = await readConfigFileSnapshot();
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
  if (authChoice === "apiKey") {
    const key = opts.anthropicApiKey?.trim();
    if (!key) {
      runtime.error("Missing --anthropic-api-key");
      runtime.exit(1);
      return;
    }
    await setAnthropicApiKey(key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  } else if (authChoice === "gemini-api-key") {
    const key = opts.geminiApiKey?.trim();
    if (!key) {
      runtime.error("Missing --gemini-api-key");
      runtime.exit(1);
      return;
    }
    await setGeminiApiKey(key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    nextConfig = applyGoogleGeminiModelDefault(nextConfig).next;
  } else if (authChoice === "openai-api-key") {
    const key = opts.openaiApiKey?.trim() || resolveEnvApiKey("openai")?.apiKey;
    if (!key) {
      runtime.error("Missing --openai-api-key (or OPENAI_API_KEY in env).");
      runtime.exit(1);
      return;
    }
    const result = upsertSharedEnvVar({
      key: "OPENAI_API_KEY",
      value: key,
    });
    process.env.OPENAI_API_KEY = key;
    runtime.log(`Saved OPENAI_API_KEY to ${result.path}`);
  } else if (authChoice === "minimax-cloud") {
    const key = opts.minimaxApiKey?.trim();
    if (!key) {
      runtime.error("Missing --minimax-api-key");
      runtime.exit(1);
      return;
    }
    await setMinimaxApiKey(key);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    nextConfig = applyMinimaxHostedConfig(nextConfig);
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
  } else if (authChoice === "setup-token" || authChoice === "oauth") {
    if (!process.stdin.isTTY) {
      runtime.error("`claude setup-token` requires an interactive TTY.");
      runtime.exit(1);
      return;
    }

    const res = spawnSync("claude", ["setup-token"], { stdio: "inherit" });
    if (res.error) throw res.error;
    if (typeof res.status === "number" && res.status !== 0) {
      runtime.error(`claude setup-token failed (exit ${res.status})`);
      runtime.exit(1);
      return;
    }

    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: true,
    });
    if (!store.profiles[CLAUDE_CLI_PROFILE_ID]) {
      runtime.error(
        `No Claude CLI credentials found after setup-token. Expected auth profile ${CLAUDE_CLI_PROFILE_ID}.`,
      );
      runtime.exit(1);
      return;
    }

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "token",
    });
  } else if (authChoice === "token") {
    const providerRaw = opts.tokenProvider?.trim();
    const tokenRaw = opts.token?.trim();
    if (!providerRaw) {
      runtime.error(
        "Missing --token-provider (required for --auth-choice token).",
      );
      runtime.exit(1);
      return;
    }
    if (!tokenRaw) {
      runtime.error("Missing --token (required for --auth-choice token).");
      runtime.exit(1);
      return;
    }

    const provider = normalizeProviderId(providerRaw);
    const profileId = (
      opts.tokenProfileId?.trim() || `${provider}:manual`
    ).trim();
    const expires =
      opts.tokenExpiresIn?.trim() && opts.tokenExpiresIn.trim().length > 0
        ? Date.now() +
          parseDurationMs(String(opts.tokenExpiresIn).trim(), {
            defaultUnit: "d",
          })
        : undefined;

    upsertAuthProfile({
      profileId,
      credential: {
        type: "token",
        provider,
        token: tokenRaw,
        ...(expires ? { expires } : {}),
      },
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider,
      mode: "token",
    });
  } else if (authChoice === "openai-codex" || authChoice === "antigravity") {
    const label =
      authChoice === "antigravity" ? "Antigravity" : "OpenAI Codex OAuth";
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
  let authMode = opts.gatewayAuth ?? "off";
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
        auth: { ...nextConfig.gateway?.auth, mode: "token" },
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
    const environment = buildServiceEnvironment({
      env: process.env,
      port,
      token: gatewayToken,
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
    await ensureSystemdUserLingerNonInteractive({ runtime });
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
