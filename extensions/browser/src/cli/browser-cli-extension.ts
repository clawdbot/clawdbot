/**
 * `openclaw browser extension` CLI: register the Store and development extension
 * native bootstrap host, and retain advanced manual pairing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  browserExtensionStatus,
  FOUNDATION_CHROME_WEB_STORE_URL,
  installChromeExtensionBootstrap,
  normalizeExtensionInstallWaitMs,
  resolveChromeExtensionLoadPath,
  uninstallChromeExtensionNativeHosts,
} from "../browser/extension-install.js";
import { buildBrowserExtensionPairing } from "../browser/extension-pairing.js";
import {
  BROWSER_RELAY_AUTH_LABEL,
  BROWSER_RELAY_AUTH_VERSION,
  relayKeyIdFromHex,
} from "../browser/extension-relay/auth-v2-crypto.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
} from "../browser/extension-relay/auth-v2.js";
import { ensureExtensionRelayToken } from "../browser/extension-relay/relay-auth.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import {
  danger,
  defaultRuntime,
  getRuntimeConfig,
  info,
  resolveBrowserConfig,
  runCommandWithRuntime,
  theme,
} from "./core-api.js";

/** Absolute path to the bundled unpacked Chrome extension directory. */
function resolveChromeExtensionDir(pluginRoot?: string): string {
  if (pluginRoot) {
    return path.join(pluginRoot, "chrome-extension");
  }
  // extensions/browser/dist/cli/ -> extensions/browser/chrome-extension
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "chrome-extension");
}

function resolveBrowserPluginRoot(pluginRoot?: string): string {
  return pluginRoot ?? path.resolve(resolveChromeExtensionDir(), "..");
}

function firstExtensionProfile(
  resolved: ReturnType<typeof resolveBrowserConfig>,
): { name: string; relayPort: number } | null {
  for (const [name, profile] of Object.entries(resolved.profiles)) {
    if (profile.driver === "extension") {
      return {
        name,
        relayPort:
          profile.cdpPort ??
          resolved.extensionRelayPorts[name] ??
          resolved.extensionRelayDefaultPort,
      };
    }
  }
  return null;
}

async function buildPairingString(gatewayUrl?: string): Promise<{
  pairing: string;
  relayPort: number;
  remote: boolean;
}> {
  const cfg = getRuntimeConfig();
  const result = await buildBrowserExtensionPairing({ cfg, gatewayUrl });
  return {
    pairing: result.pairingString,
    relayPort: result.relayPort,
    remote: result.topology === "direct-remote",
  };
}

type BrowserRelayCdpEndpoint = {
  browserUrl: string;
  wsEndpoint: string;
  auth: {
    label: typeof BROWSER_RELAY_AUTH_LABEL;
    version: typeof BROWSER_RELAY_AUTH_VERSION;
    keyId: string;
    challengeUrl: string;
    completeUrl: string;
    role: "cdp";
    transport: "connection";
    method: "SEQUENCE";
    resource: "/json/version -> /cdp";
    flow: "cdp";
  };
  headers?: { Authorization: string };
};

/** Resolve safe v2 metadata, with an explicit gated legacy credential escape hatch. */
async function buildCdpEndpoint(options: {
  legacyBearer: boolean;
}): Promise<BrowserRelayCdpEndpoint> {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const token = await ensureExtensionRelayToken();
  const profile = firstExtensionProfile(resolved);
  const relayPort = profile?.relayPort ?? resolved.extensionRelayDefaultPort;
  const browserUrl = `http://127.0.0.1:${relayPort}`;
  const metadata = {
    browserUrl,
    wsEndpoint: `ws://127.0.0.1:${relayPort}/cdp`,
    auth: {
      label: BROWSER_RELAY_AUTH_LABEL,
      version: BROWSER_RELAY_AUTH_VERSION,
      keyId: relayKeyIdFromHex(token),
      challengeUrl: new URL(BROWSER_RELAY_AUTH_CHALLENGE_PATH, browserUrl).toString(),
      completeUrl: new URL(BROWSER_RELAY_AUTH_COMPLETE_PATH, browserUrl).toString(),
      role: "cdp" as const,
      transport: "connection" as const,
      method: "SEQUENCE" as const,
      resource: "/json/version -> /cdp" as const,
      flow: "cdp" as const,
    },
  };
  if (!options.legacyBearer) {
    return metadata;
  }
  if (!resolved.extensionRelay.allowLegacyAuth) {
    throw new Error(
      "Legacy browser relay auth is disabled; remove --legacy-bearer and use Browser Relay Authentication v2.",
    );
  }
  return {
    ...metadata,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/** Register `openclaw browser extension` lifecycle and compatibility commands. */
export function registerBrowserExtensionCommands(
  browser: Command,
  _parentOpts: (cmd: Command) => BrowserParentOpts,
  pluginRoot?: string,
) {
  const extension = browser
    .command("extension")
    .description("Install and inspect the OpenClaw Chrome extension bootstrap");

  extension
    .command("path")
    .description("Print the unpacked Chrome extension directory (Load unpacked)")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        defaultRuntime.log(
          await resolveChromeExtensionLoadPath(resolveChromeExtensionDir(pluginRoot)),
        );
      });
    });

  extension
    .command("install")
    .description("Register the native bootstrap host for Store and development installs")
    .option("--json", "Print a machine-readable status report")
    .option(
      "--wait-ms <ms>",
      "How long to wait after pre-registration for Chrome to verify the extension",
      String(30_000),
    )
    .action(async (opts) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const waitMs = normalizeExtensionInstallWaitMs(opts.waitMs);
          const bundledDir = resolveChromeExtensionDir(pluginRoot);
          if (opts.json !== true) {
            defaultRuntime.log(
              info("Preparing the OpenClaw Chrome native bootstrap. Keep Chrome running…"),
            );
          }
          const status = await installChromeExtensionBootstrap({
            bundledDir,
            pluginRoot: resolveBrowserPluginRoot(pluginRoot),
            waitMs,
            onProgress:
              opts.json === true ? undefined : (message) => defaultRuntime.log(info(message)),
          });
          if (opts.json === true) {
            defaultRuntime.writeJson(status);
          } else {
            for (const issue of status.issues) {
              defaultRuntime.error(theme.warn(issue));
            }
            defaultRuntime.log(
              status.manualSetupRequired
                ? theme.warn(
                    status.platformSupport === "manual_required"
                      ? "Automatic native bootstrap is not supported on this platform; use Settings for manual pairing."
                      : `Automatic setup was not verified. Run install before adding OpenClaw from ${FOUNDATION_CHROME_WEB_STORE_URL}. Use Load unpacked only as a development fallback after pre-registration. If this extension already attempted setup before the host existed, restart Chrome once before retrying.`,
                  )
                : info(
                    `Native host and extension identity verified for ${status.discovered.length + status.storeDiscovered.length} profile registration(s). The extension connects automatically.`,
                  ),
            );
          }
          if (status.manualSetupRequired) {
            defaultRuntime.exit(1);
          }
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });

  extension
    .command("status")
    .description("Inspect extension copies, Chrome IDs, and native-host registrations")
    .option("--json", "Print a machine-readable status report")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const status = await browserExtensionStatus({
          bundledDir: resolveChromeExtensionDir(pluginRoot),
        });
        if (opts.json === true) {
          defaultRuntime.writeJson(status);
          return;
        }
        defaultRuntime.log(
          [
            `Extension copy: ${status.installedCopy.owned ? "installed" : "bundled fallback"}`,
            `Store:          ${status.storeDiscovered.length > 0 ? status.storeDiscovered.map((entry) => `${entry.extensionId} (${entry.browser}/${entry.profile})`).join(", ") : "not detected"}`,
            `Development:    ${status.discovered.length > 0 ? status.discovered.map((entry) => `${entry.extensionId} (${entry.browser}/${entry.profile})`).join(", ") : "none detected"}`,
            `Load unpacked:  ${status.installedCopy.owned ? status.installedCopy.path : status.bundledPath}`,
            `Native hosts:   ${status.registrations.filter((entry) => entry.state === "owned").length} owned`,
            `Setup:          ${status.manualSetupRequired ? "manual action required" : "automatic bootstrap ready"}`,
          ].join("\n"),
        );
      });
    });

  extension
    .command("uninstall-host")
    .description("Remove only OpenClaw-owned Chrome native-host registrations")
    .option("--json", "Print a machine-readable removal report")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await uninstallChromeExtensionNativeHosts();
        if (opts.json === true) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.log(
          result.manualRequired
            ? theme.warn("Windows native-host removal is manual; no registry key was changed.")
            : info(`Removed ${result.removed.length} owned native-host artifact(s).`),
        );
        for (const refused of result.refused) {
          defaultRuntime.error(theme.warn(`Refused foreign registration: ${refused}`));
        }
      });
    });

  extension
    .command("pair")
    .description("Print an advanced manual pairing string")
    .option("--json", "Print the pairing string as JSON")
    .option(
      "--gateway-url <url>",
      "Print a remote pairing string for a Chrome on another machine (e.g. wss://gateway.example.com)",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const result = await buildPairingString(opts.gatewayUrl);
          if (opts.json === true) {
            defaultRuntime.writeJson({
              pairingString: result.pairing,
              relayPort: result.relayPort,
              remote: result.remote,
            });
            return;
          }
          const setupLine = result.remote
            ? info(
                "Remote pairing: load and pair the extension on the machine running Chrome; it connects to this gateway over wss://.",
              )
            : info(
                "Run this on the machine that hosts the browser (gateway host or browser node).",
              );
          defaultRuntime.log(
            [
              setupLine,
              info("1. Load the extension: chrome://extensions → Developer mode → Load unpacked →"),
              `   ${resolveChromeExtensionDir(pluginRoot)}`,
              info("2. Open the OpenClaw popup and paste this pairing string:"),
              "",
              theme.heading(result.pairing),
              "",
              info("The relay key is a host-local secret; keep it private."),
            ].join("\n"),
          );
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });

  extension
    .command("cdp")
    .description("Print non-secret Browser Relay Authentication v2 CDP metadata")
    .option("--json", "Print the endpoint as JSON")
    .option(
      "--legacy-bearer",
      "Print the legacy Bearer header while browser.extensionRelay.allowLegacyAuth is enabled",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const legacyBearer = opts.legacyBearer === true;
          const endpoint = await buildCdpEndpoint({ legacyBearer });
          if (legacyBearer) {
            defaultRuntime.error(
              theme.warn(
                "Warning: --legacy-bearer reveals the relay key in an authorization header. Migrate this client to Browser Relay Authentication v2.",
              ),
            );
          }
          if (opts.json === true) {
            defaultRuntime.writeJson(endpoint);
            return;
          }
          const lines = [
            info("Relay CDP endpoint (pair the extension first):"),
            `browserUrl: ${endpoint.browserUrl}`,
            `wsEndpoint: ${endpoint.wsEndpoint}`,
            `auth:       ${endpoint.auth.label} v${endpoint.auth.version}`,
            `keyId:      ${endpoint.auth.keyId}`,
            `challenge:  POST ${endpoint.auth.challengeUrl}`,
            `complete:   POST ${endpoint.auth.completeUrl}`,
            `sequence:   ${endpoint.auth.resource}`,
          ];
          if (endpoint.headers) {
            lines.push(`legacy:     Authorization: ${endpoint.headers.Authorization}`);
          } else {
            lines.push("", info("No relay key or authorization header is printed."));
          }
          defaultRuntime.log(lines.join("\n"));
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });
}
