import type { Command } from "commander";

import { loadConfig } from "../config/config.js";
import { danger, info } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "../browser/bridge-server.js";
import { ensureChromeExtensionRelayServer } from "../browser/extension-relay.js";

function isLoopbackBindHost(host: string) {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function parsePort(raw: unknown): number | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return null;
  return n;
}

export function registerBrowserServeCommands(
  browser: Command,
  _parentOpts: (cmd: Command) => unknown,
) {
  browser
    .command("serve")
    .description("Run a standalone browser control server (for remote gateways)")
    .option("--bind <host>", "Bind host (default: 127.0.0.1)")
    .option("--port <port>", "Bind port (default: from browser.controlUrl)")
    .option(
      "--token <token>",
      "Require Authorization: Bearer <token> (required when binding non-loopback)",
    )
    .action(async (opts: { bind?: string; port?: string; token?: string }) => {
      const cfg = loadConfig();
      const resolved = resolveBrowserConfig(cfg.browser);
      if (!resolved.enabled) {
        defaultRuntime.error(
          danger("Browser control is disabled. Set browser.enabled=true and try again."),
        );
        defaultRuntime.exit(1);
      }

      const host = (opts.bind ?? "127.0.0.1").trim();
      const port = parsePort(opts.port) ?? resolved.controlPort;

      const envToken = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN?.trim();
      const authToken = (opts.token ?? envToken ?? resolved.controlToken)?.trim();
      if (!isLoopbackBindHost(host) && !authToken) {
        defaultRuntime.error(
          danger(
            `Refusing to bind browser control on ${host} without --token (or CLAWDBOT_BROWSER_CONTROL_TOKEN, or browser.controlToken).`,
          ),
        );
        defaultRuntime.exit(1);
      }

      const bridge = await startBrowserBridgeServer({
        resolved,
        host,
        port,
        ...(authToken ? { authToken } : {}),
      });

      // If any profile uses the Chrome extension relay, start the local relay server eagerly
      // so the extension can connect before the first browser action.
      for (const name of Object.keys(resolved.profiles)) {
        const profile = resolveProfile(resolved, name);
        if (!profile || profile.driver !== "extension") continue;
        await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
          defaultRuntime.error(
            danger(`Chrome extension relay init failed for profile "${name}": ${String(err)}`),
          );
        });
      }

      defaultRuntime.log(
        info(
          [
            `🦞 Browser control listening on ${bridge.baseUrl}/`,
            authToken ? "Auth: Bearer token required." : "Auth: off (loopback only).",
            "",
            "Paste on the Gateway (clawdbot.json):",
            JSON.stringify(
              {
                browser: {
                  enabled: true,
                  controlUrl: bridge.baseUrl,
                  ...(authToken ? { controlToken: authToken } : {}),
                },
              },
              null,
              2,
            ),
            ...(authToken
              ? [
                  "",
                  "Or use env on the Gateway (instead of controlToken in config):",
                  `export CLAWDBOT_BROWSER_CONTROL_TOKEN=${JSON.stringify(authToken)}`,
                ]
              : []),
          ].join("\n"),
        ),
      );

      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        defaultRuntime.log(info(`Shutting down (${signal})...`));
        await stopBrowserBridgeServer(bridge.server).catch(() => {});
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.once("SIGTERM", () => void shutdown("SIGTERM"));

      await new Promise(() => {});
    });
}
