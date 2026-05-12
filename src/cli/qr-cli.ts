import type { Command } from "commander";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { trimToUndefined } from "../gateway/credentials.js";
import { resolveRequiredConfiguredSecretRefInputString } from "../gateway/resolve-configured-secret-input-string.js";
import { renderQrTerminal } from "../media/qr-terminal.ts";
import { resolvePairingSetupFromConfig, encodePairingSetupCode } from "../pairing/setup-code.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";
import { getQrRemoteCommandSecretTargetIds } from "./command-secret-targets.js";

type QrCliOptions = {
  json?: boolean;
  setupCodeOnly?: boolean;
  ascii?: boolean;
  remote?: boolean;
  url?: string;
  publicUrl?: string;
  token?: string;
  password?: string;
};

function renderQrAscii(data: string): Promise<string> {
  return renderQrTerminal(data);
}
function readDevicePairPublicUrlFromConfig(cfg: OpenClawConfig): string | undefined {
  const value = cfg.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shouldResolveLocalGatewayPasswordSecret(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD)) {
    return false;
  }
  const authMode = cfg.gateway?.auth?.mode;
  if (authMode === "password") {
    return true;
  }
  if (authMode === "token" || authMode === "none" || authMode === "trusted-proxy") {
    return false;
  }
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const configTokenConfigured = hasConfiguredSecretInput(
    cfg.gateway?.auth?.token,
    cfg.secrets?.defaults,
  );
  return !envToken && !configTokenConfigured;
}

async function resolveLocalGatewayPasswordSecretIfNeeded(cfg: OpenClawConfig): Promise<void> {
  const resolvedPassword = await resolveRequiredConfiguredSecretRefInputString({
    config: cfg,
    env: process.env,
    value: cfg.gateway?.auth?.password,
    path: "gateway.auth.password",
  });
  if (!resolvedPassword) {
    return;
  }
  if (!cfg.gateway?.auth) {
    return;
  }
  cfg.gateway.auth.password = resolvedPassword;
}

function emitQrSecretResolveDiagnostics(diagnostics: string[], opts: QrCliOptions): void {
  if (diagnostics.length === 0) {
    return;
  }
  const toStderr = opts.json === true || opts.setupCodeOnly === true;
  for (const entry of diagnostics) {
    const message = theme.warn(`[secrets] ${entry}`);
    if (toStderr) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(message);
    }
  }
}

export function registerQrCli(program: Command) {
  program
    .command("qr")
    .description("Generate a mobile pairing QR code and setup code")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/qr", "docs.openclaw.ai/cli/qr")}\n`,
    )
    .option(
      "--remote",
      "Use gateway.remote.url and gateway.remote token/password (ignores device-pair publicUrl)",
      false,
    )
    .option("--url <url>", "Override gateway URL used in the setup payload")
    .option("--public-url <url>", "Override gateway public URL used in the setup payload")
    .option("--token <token>", "Override gateway token for setup payload")
    .option("--password <password>", "Override gateway password for setup payload")
    .option("--setup-code-only", "Print only the setup code", false)
    .option("--no-ascii", "Skip ASCII QR rendering")
    .option("--json", "Output JSON", false)
    .action(async (opts: QrCliOptions) => {
      try {
        if (opts.token && opts.password) {
          throw new Error("Use either --token or --password, not both.");
        }

        const token = trimToUndefined(opts.token) ?? "";
        const password = trimToUndefined(opts.password) ?? "";
        const wantsRemote = opts.remote === true;

        const loadedRaw = getRuntimeConfig();
        if (wantsRemote && !opts.url && !opts.publicUrl) {
          const tailscaleMode = loadedRaw.gateway?.tailscale?.mode ?? "off";
          const remoteUrl = loadedRaw.gateway?.remote?.url;
          const hasRemoteUrl = Boolean(trimToUndefined(remoteUrl));
          const hasTailscaleServe = tailscaleMode === "serve" || tailscaleMode === "funnel";
          if (!hasRemoteUrl && !hasTailscaleServe) {
            throw new Error(
              "qr --remote requires gateway.remote.url (or gateway.tailscale.mode=serve/funnel).",
            );
          }
        }
        let loaded = loadedRaw;
        let remoteDiagnostics: string[] = [];
        if (wantsRemote && !token && !password) {
          const resolvedRemote = await resolveCommandSecretRefsViaGateway({
            config: loadedRaw,
            commandName: "qr --remote",
            targetIds: getQrRemoteCommandSecretTargetIds(),
          });
          loaded = resolvedRemote.resolvedConfig;
          remoteDiagnostics = resolvedRemote.diagnostics;
        }
        const cfg = {
          ...loaded,
          gateway: {
            ...loaded.gateway,
            auth: {
              ...loaded.gateway?.auth,
            },
          },
        };
        emitQrSecretResolveDiagnostics(remoteDiagnostics, opts);

        if (token) {
          cfg.gateway.auth.mode = "token";
          cfg.gateway.auth.token = token;
          cfg.gateway.auth.password = undefined;
        }
        if (password) {
          cfg.gateway.auth.mode = "password";
          cfg.gateway.auth.password = password;
          cfg.gateway.auth.token = undefined;
        }
        if (wantsRemote && !token && !password) {
          const remoteToken = trimToUndefined(cfg.gateway?.remote?.token) ?? "";
          const remotePassword = trimToUndefined(cfg.gateway?.remote?.password) ?? "";
          if (remoteToken) {
            cfg.gateway.auth.mode = "token";
            cfg.gateway.auth.token = remoteToken;
            cfg.gateway.auth.password = undefined;
          } else if (remotePassword) {
            cfg.gateway.auth.mode = "password";
            cfg.gateway.auth.password = remotePassword;
            cfg.gateway.auth.token = undefined;
          }
        }
        if (
          !wantsRemote &&
          !password &&
          !token &&
          shouldResolveLocalGatewayPasswordSecret(cfg, process.env)
        ) {
          await resolveLocalGatewayPasswordSecretIfNeeded(cfg);
        }

        const explicitUrl =
          typeof opts.url === "string" && opts.url.trim()
            ? opts.url.trim()
            : typeof opts.publicUrl === "string" && opts.publicUrl.trim()
              ? opts.publicUrl.trim()
              : undefined;
        const publicUrl =
          explicitUrl ?? (wantsRemote ? undefined : readDevicePairPublicUrlFromConfig(cfg));

        const resolved = await resolvePairingSetupFromConfig(cfg, {
          publicUrl,
          preferRemoteUrl: wantsRemote,
          runCommandWithTimeout: async (argv, runOpts) =>
            await runCommandWithTimeout(argv, {
              timeoutMs: runOpts.timeoutMs,
            }),
        });

        if (!resolved.ok) {
          throw new Error(resolved.error);
        }

        const setupCode = encodePairingSetupCode(resolved.payload);

        if (opts.setupCodeOnly) {
          defaultRuntime.log(setupCode);
          return;
        }

        if (opts.json) {
          defaultRuntime.writeJson({
            setupCode,
            gatewayUrl: resolved.payload.url,
            auth: resolved.authLabel,
            urlSource: resolved.urlSource,
          });
          return;
        }

        const lines: string[] = [
          theme.heading("Pairing QR"),
          "Scan this with the OpenClaw mobile app (Onboarding -> Scan QR).",
          "",
        ];

        if (opts.ascii !== false) {
          const qrAscii = await renderQrAscii(setupCode);
          lines.push(qrAscii.trimEnd(), "");
        }

        lines.push(
          `${theme.muted("Setup code:")} ${setupCode}`,
          `${theme.muted("Gateway:")} ${resolved.payload.url}`,
          `${theme.muted("Auth:")} ${resolved.authLabel}`,
          `${theme.muted("Source:")} ${resolved.urlSource}`,
          "",
          "Approve after scan with:",
          `  ${theme.command("openclaw devices list")}`,
          `  ${theme.command("openclaw devices approve <requestId>")}`,
        );

        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
