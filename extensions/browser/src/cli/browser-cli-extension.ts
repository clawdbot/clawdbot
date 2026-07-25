/**
 * `openclaw browser extension` CLI: locate the unpacked Chrome extension and
 * print the pairing string that connects it to this install's relay.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { ensureExtensionRelayToken } from "../browser/extension-relay/relay-auth.js";
import { isLoopbackHost } from "../gateway/net.js";
import { resolveGatewayPort } from "../sdk-config.js";
import { resolveLocalPairingGatewayUrl } from "./browser-cli-extension-pairing.js";
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

function firstExtensionProfile(): { name: string; relayPort: number } | null {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  for (const [name, profile] of Object.entries(resolved.profiles)) {
    if (profile.driver === "extension") {
      return { name, relayPort: profile.cdpPort ?? resolved.extensionRelayDefaultPort };
    }
  }
  return null;
}

/** Gateway route path for the remote extension relay (see gateway-relay-route.ts). */
const GATEWAY_EXTENSION_RELAY_PATH = "/browser/extension";

/** Resolve a safe direct-Gateway relay URL, preserving an optional proxy base path. */
function buildRemoteGatewayRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("--gateway-url must be a valid ws:// or wss:// URL");
  }
  const secure = url.protocol === "wss:";
  const localPlaintext = url.protocol === "ws:" && isLoopbackHost(url.hostname);
  if (!secure && !localPlaintext) {
    throw new Error("--gateway-url must use wss:// (ws:// is allowed only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--gateway-url must not include credentials, a query, or a fragment");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${GATEWAY_EXTENSION_RELAY_PATH}`;
  return url.toString();
}

function buildPairingString(gatewayUrl?: string): {
  pairing: string;
  relayPort: number;
  remote: boolean;
} {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  // Create the host-local relay secret if this host has not used the extension
  // driver yet, so pairing works on a fresh gateway or node host before the
  // relay has started. Pairing must run on the machine that hosts the browser.
  const token = ensureExtensionRelayToken();
  const profile = firstExtensionProfile();
  const relayPort = profile?.relayPort ?? resolved.extensionRelayDefaultPort;

  const gateway = gatewayUrl?.trim();
  if (gateway) {
    // Remote: the extension connects straight to this gateway over wss:// — no
    // node host on the browser machine. The gateway route self-validates the
    // same host-local secret.
    const relayUrl = new URL(buildRemoteGatewayRelayUrl(gateway));
    relayUrl.searchParams.set("gateway", gateway);
    return {
      pairing: `${relayUrl.toString()}#${token}`,
      relayPort,
      remote: true,
    };
  }
  const configuredRemote = cfg.gateway?.mode === "remote" ? cfg.gateway.remote?.url?.trim() : "";
  const directGatewayUrl = resolveLocalPairingGatewayUrl({
    configuredRemote,
    gatewayPort: resolveGatewayPort(cfg),
    tlsEnabled: cfg.gateway?.tls?.enabled === true,
  });
  const relayUrl = new URL(`ws://127.0.0.1:${relayPort}/extension`);
  relayUrl.searchParams.set("gateway", directGatewayUrl);
  return {
    pairing: `${relayUrl.toString()}#${token}`,
    relayPort,
    remote: false,
  };
}

/** Register `openclaw browser extension {path,pair}`. */
export function registerBrowserExtensionCommands(
  browser: Command,
  _parentOpts: (cmd: Command) => BrowserParentOpts,
  pluginRoot?: string,
) {
  const extension = browser
    .command("extension")
    .description("Chrome extension: print the load path and pairing string");

  extension
    .command("path")
    .description("Print the unpacked Chrome extension directory (Load unpacked)")
    .action(() => {
      defaultRuntime.log(resolveChromeExtensionDir(pluginRoot));
    });

  extension
    .command("pair")
    .description("Print the pairing string to paste into the OpenClaw extension popup")
    .option("--json", "Print the pairing string as JSON")
    .option(
      "--gateway-url <url>",
      "Print a remote pairing string for a Chrome on another machine (e.g. wss://gateway.example.com)",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const result = buildPairingString(opts.gatewayUrl);
          if (opts.json === true) {
            defaultRuntime.log(
              JSON.stringify({
                pairingString: result.pairing,
                relayPort: result.relayPort,
                remote: result.remote,
              }),
            );
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
              info("The token is a host-local secret; keep it private."),
            ].join("\n"),
          );
        },
        (err: unknown) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });
}
