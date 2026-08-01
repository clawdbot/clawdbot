// Telegram Mini App bootstrap page.
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";

export const TELEGRAM_MINIAPP_EXPIRED_MESSAGE =
  "This link expired. Reopen the dashboard from your bot chat.";

const TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS = 15_000;

export function renderTelegramMiniAppPage(params: {
  accountId: string;
  scriptNonce: string;
}): string {
  const accountId = JSON.stringify(params.accountId);
  const nonce = escapeHtml(params.scriptNonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>OpenClaw</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(28rem, calc(100vw - 2rem)); }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { margin: 0; line-height: 1.5; }
  </style>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
  <main>
    <h1>OpenClaw</h1>
    <p id="status">Opening dashboard...</p>
  </main>
  <script nonce="${nonce}">
    const accountId = ${accountId};
    const status = document.getElementById("status");
    const showExpired = () => {
      status.textContent = ${JSON.stringify(TELEGRAM_MINIAPP_EXPIRED_MESSAGE)};
    };
    const webApp = window.Telegram && window.Telegram.WebApp;
    const initData = webApp && typeof webApp.initData === "string" ? webApp.initData : "";
    if (!initData) {
      showExpired();
    } else {
      webApp.ready();
      // AbortController works in WebViews that predate AbortSignal.timeout.
      // Clear the timer after either outcome so a successful handoff is not aborted later.
      const authController = new AbortController();
      const authTimeout = setTimeout(function () {
        authController.abort();
      }, ${TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS});
      fetch("auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData, accountId }),
        credentials: "same-origin",
        signal: authController.signal
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error("auth failed");
        }
        return await response.json();
      }).then((payload) => {
        const next = new URL(payload.controlUiUrl);
        next.hash = "gatewayUrl=" + encodeURIComponent(payload.gatewayUrl) +
          "&bootstrapToken=" + encodeURIComponent(payload.bootstrapToken);
        location.replace(next.toString());
      }).catch(showExpired).then(function () {
        clearTimeout(authTimeout);
      });
    }
  </script>
</body>
</html>`;
}
