export const DISCORD_ACTIVITY_ROUTE_PREFIX = "/discord/activity";

export const DISCORD_ACTIVITY_SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
  "connect-src 'self'; frame-src 'self'; img-src data:; base-uri 'none'; frame-ancestors *";

export const DISCORD_ACTIVITY_SHELL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw widget</title><style>
:root{color-scheme:dark;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#1e1f22;color:#dbdee1}
*{box-sizing:border-box}html,body,#app{height:100%;margin:0}#app{display:grid;place-items:center}main{max-width:560px;padding:32px;text-align:center}
h1{font-size:18px;margin:0 0 8px;color:#f2f3f5}p{margin:0;color:#b5bac1;line-height:1.5}.widget{display:grid;grid-template-rows:42px 1fr;width:100%;height:100%;background:#111214}
.bar{display:flex;align-items:center;padding:0 14px;border-bottom:1px solid #2b2d31;font-weight:600;color:#f2f3f5}.widget iframe{border:0;width:100%;height:100%;background:#111214}
</style></head><body><div id="app"><main><h1>Opening widget</h1><p>Connecting to Discord…</p></main></div>
<script type="module" src="./shell.js"></script></body></html>`;

export const DISCORD_ACTIVITY_SHELL_JS = `import { DiscordSDK } from "./vendor/embedded-app-sdk.mjs";

const app = document.querySelector("#app");
function show(message, detail) {
  app.className = "";
  app.innerHTML = "";
  const main = document.createElement("main");
  const heading = document.createElement("h1");
  const paragraph = document.createElement("p");
  heading.textContent = message;
  paragraph.textContent = detail;
  main.append(heading, paragraph);
  app.append(main);
}
function proxiedDocUrl(value) {
  const url = new URL(value, window.location.origin);
  if (window.location.hostname.endsWith(".discordsays.com")) {
    // The ROOT mapping target already includes this prefix; strip it before proxying.
    const gatewayPrefix = "/discord/activity";
    const mappedPath = url.pathname.startsWith(gatewayPrefix + "/")
      ? url.pathname.slice(gatewayPrefix.length)
      : url.pathname;
    return "/.proxy" + mappedPath + url.search;
  }
  return url.pathname + url.search;
}
async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof body.error === "string" ? body.error : "request failed");
    error.status = response.status;
    throw error;
  }
  return body;
}
async function run() {
  const match = window.location.hostname.match(/^(\\d+)\\.discordsays\\.com$/i);
  if (!match) {
    show("Open inside Discord", "This widget must be launched from its Discord button.");
    return;
  }
  const clientId = match[1];
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });
  const auth = await readJson(await fetch("./api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  }));
  await sdk.commands.authenticate({ access_token: auth.access_token });
  const query = new URLSearchParams({
    custom_id: sdk.customId ?? "",
    instance_id: sdk.instanceId,
  });
  const widget = await readJson(await fetch("./api/widget?" + query, {
    headers: { Authorization: "Bearer " + auth.session_token },
  }));
  app.className = "widget";
  app.innerHTML = "";
  const bar = document.createElement("div");
  const frame = document.createElement("iframe");
  bar.className = "bar";
  bar.textContent = widget.title;
  frame.title = widget.title;
  // Intentionally minimal: no top-navigation, popups, or same-origin access.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.src = proxiedDocUrl(widget.docUrl);
  app.append(bar, frame);
}
run().catch((error) => {
  if (error?.status === 403) {
    show("Not authorized", "This Discord account is not allowed to open this widget.");
  } else if (error?.status === 404) {
    show("Widget unavailable", "No widget could be resolved for this channel.");
  } else {
    show("Gateway offline", "The OpenClaw gateway could not load this widget. Try again shortly.");
  }
});
`;
