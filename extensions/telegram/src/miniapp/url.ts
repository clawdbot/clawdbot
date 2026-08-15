// Telegram Mini App published URL resolution.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveTailnetHostWithRunner,
  resolveTailscalePublishedHost,
  type TailscaleStatusCommandRunner,
} from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";

export const TELEGRAM_MINIAPP_PATH_PREFIX = "/__openclaw_tg_miniapp/";
export const TELEGRAM_MINIAPP_URL_ERROR =
  "Mini App needs an HTTPS gateway URL. Set `gateway.tailscale.mode: serve` or `funnel`, then retry.";

type TelegramMiniAppUrls = {
  pageUrl: string;
  controlUiUrl: string;
  gatewayUrl: string;
};

export async function resolveTelegramMiniAppUrls(params: {
  cfg: OpenClawConfig;
  runCommand?: TailscaleStatusCommandRunner;
}): Promise<TelegramMiniAppUrls> {
  const mode = params.cfg.gateway?.tailscale?.mode ?? "off";
  if (mode !== "serve" && mode !== "funnel") {
    throw new Error(TELEGRAM_MINIAPP_URL_ERROR);
  }

  const tailnetHost = await resolveTailnetHostWithRunner(
    params.runCommand ?? runCommandWithTimeout,
  );
  const publishedHost = resolveTailscalePublishedHost({
    tailscaleMode: mode,
    tailnetHost,
    serviceName: params.cfg.gateway?.tailscale?.serviceName,
  });
  if (!publishedHost) {
    throw new Error(TELEGRAM_MINIAPP_URL_ERROR);
  }

  const controlUiPath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
  const controlUiUrl = `https://${publishedHost}${controlUiPath}`;
  return {
    pageUrl: `https://${publishedHost}${TELEGRAM_MINIAPP_PATH_PREFIX}`,
    controlUiUrl,
    // The Control UI serves its WebSocket endpoint under the same base path as
    // the HTTP app (ui/src/app/settings.ts deriveDefaultGatewayUrl); a bare
    // host URL breaks gateway.controlUi.basePath installs.
    gatewayUrl: `wss://${publishedHost}${controlUiPath}`,
  };
}

function normalizeControlUiBasePath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw === "/") {
    return "";
  }
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.replace(/\/+$/, "");
}
