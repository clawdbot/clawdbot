import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
};

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const token = cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN ?? "";

  const links = resolveControlUiLinks({
    port,
    bind,
    customBindHost,
    basePath,
  });
  const authedUrl = token ? `${links.httpUrl}?token=${encodeURIComponent(token)}` : links.httpUrl;

  runtime.log(`Dashboard URL: ${authedUrl}`);

  const copied = await copyToClipboard(authedUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(authedUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
        token: token || undefined,
      });
    }
  } else {
    hint = "Browser launch disabled (--no-open). Use the URL above.";
  }

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control Moltbot.");
  } else if (hint) {
    runtime.log(hint);
  }
}
