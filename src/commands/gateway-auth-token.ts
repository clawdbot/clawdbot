import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { defaultRuntime, type OutputRuntimeEnv } from "../runtime.js";

type GatewayAuthTokenOptions = {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
};

/** Reveal the configured shared Gateway token only to an explicitly interactive operator. */
export async function gatewayAuthTokenCommand(
  runtime: OutputRuntimeEnv = defaultRuntime,
  options: GatewayAuthTokenOptions = {},
): Promise<void> {
  // Keep bearer credentials out of pipes and captured command logs. Operators must
  // explicitly own both sides of the terminal before the token reaches stdout.
  if (!(options.interactive ?? isTerminalInteractive())) {
    throw new Error(
      "Refusing to print the Gateway token outside an interactive terminal. Run `openclaw gateway auth-token --show` directly in a terminal on the Gateway host.",
    );
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Gateway config is invalid. Run `openclaw doctor --fix`, then try again.");
  }

  const cfg = snapshot.sourceConfig ?? snapshot.config;
  if (cfg.gateway?.mode === "remote") {
    throw new Error(
      "This command must run on the Gateway host; the current config is in remote mode.",
    );
  }
  const env = options.env ?? process.env;
  assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
  const configuredAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    env,
    tailscaleMode: cfg.gateway?.tailscale?.mode,
  });
  if (configuredAuth.mode !== "token") {
    throw new Error(
      `Gateway auth mode is ${configuredAuth.mode}; there is no active shared token to reveal.`,
    );
  }

  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    config: cfg,
    commandName: "gateway auth-token",
    targetIds: new Set(["gateway.auth.token"]),
    mode: "enforce_resolved",
    allowedPaths: new Set(["gateway.auth.token"]),
  });
  const resolvedAuth = resolveGatewayAuth({
    authConfig: resolvedConfig.gateway?.auth,
    env,
    tailscaleMode: resolvedConfig.gateway?.tailscale?.mode,
  });
  if (resolvedAuth.mode !== "token" || !resolvedAuth.token) {
    throw new Error(
      "No configured Gateway token is available. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then try again.",
    );
  }

  runtime.writeStdout(`${resolvedAuth.token}\n`);
}
