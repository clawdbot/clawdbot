/**
 * `openclaw browser extension` CLI: locate the unpacked Chrome extension and
 * print the pairing string that connects it to this install's relay.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
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

/** Gateway route path for the remote extension relay (see gateway-relay-route.ts). */
const GATEWAY_EXTENSION_RELAY_PATH = "/browser/extension";

/** Resolve a safe direct-Gateway relay URL with an exact v2-bound route path. */
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
  if (url.pathname !== "/") {
    throw new Error(
      "--gateway-url must not include a path prefix; Browser Relay Authentication v2 binds the exact /browser/extension path",
    );
  }
  url.pathname = GATEWAY_EXTENSION_RELAY_PATH;
  return url.toString();
}

async function buildPairingString(gatewayUrl?: string): Promise<{
  pairing: string;
  relayPort: number;
  remote: boolean;
}> {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  // Create the host-local relay secret if this host has not used the extension
  // driver yet, so pairing works on a fresh gateway or node host before the
  // relay has started. Pairing must run on the machine that hosts the browser.
  const token = await ensureExtensionRelayToken();
  const profile = firstExtensionProfile(resolved);
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

/** Register `openclaw browser extension {path,pair,cdp}`. */
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
