/**
 * "Claude Sessions" Control UI tab — registers a plugin-served panel at
 * /plugins/claude/sessions, rendered by the Control UI in a sandboxed iframe
 * (registerControlUiDescriptor's `path` field), plus the JSON endpoints that
 * panel's vanilla JS calls.
 *
 * Deliberately NOT a native "bundled" Lit tab the way Codex Sessions is
 * (ui/src/pages/plugin/codex-sessions-{view,controller}.ts, wired into
 * BUNDLED_TAB_VIEWS in ui/src/pages/plugin/plugin-page.ts) — that requires
 * changing core Control UI source, not just plugin code. The `path`-based
 * embed is the sanctioned fallback for exactly this case (see
 * PluginControlUiDescriptor.path's doc comment) and needs zero core changes.
 * A native port is a reasonable later phase if pixel-parity with Codex
 * Sessions' UX is wanted; this delivers the same underlying capability
 * (list/search/archive/rename/preview) today.
 *
 * `auth: "gateway"` means the iframe — same-origin with the already-
 * authenticated Control UI page — carries the operator's existing session,
 * no separate token scheme needed (unlike a fully standalone dashboard
 * server on its own port).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  archiveClaudeSession,
  ClaudeSessionNotFoundError,
  getCatalogClient,
  listClaudeSessions,
  readClaudeSession,
  renameClaudeSession,
  unarchiveClaudeSession,
} from "./session-catalog.js";

export const CLAUDE_SESSIONS_PANEL_PATH = "/plugins/claude/sessions";

export function registerClaudeSessionsPanel(api: OpenClawPluginApi): void {
  api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: "sessions",
    label: "Claude Sessions",
    description: "Claude sessions managed by this Gateway's bridge.",
    icon: "terminal",
    group: "control",
    path: CLAUDE_SESSIONS_PANEL_PATH,
    requiredScopes: ["operator.write"],
  });
  api.registerHttpRoute({
    path: CLAUDE_SESSIONS_PANEL_PATH,
    auth: "gateway",
    match: "prefix",
    handler: handleSessionsPanelRequest,
  });
}

async function handleSessionsPanelRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  try {
    if (pathname === CLAUDE_SESSIONS_PANEL_PATH && method === "GET") {
      sendHtml(res, PANEL_HTML);
      return;
    }
    if (pathname === `${CLAUDE_SESSIONS_PANEL_PATH}/list.json` && method === "GET") {
      const client = await getCatalogClient();
      const page = await listClaudeSessions(client, {
        cursor: url.searchParams.get("cursor"),
        limit: numberParam(url, "limit"),
        archived: url.searchParams.get("archived") === "true",
        searchTerm: url.searchParams.get("searchTerm") ?? undefined,
      });
      sendJson(res, 200, page);
      return;
    }
    if (pathname === `${CLAUDE_SESSIONS_PANEL_PATH}/read.json` && method === "GET") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        sendJson(res, 400, { error: "Missing threadId" });
        return;
      }
      const client = await getCatalogClient();
      const result = await readClaudeSession(client, threadId);
      sendJson(res, 200, result);
      return;
    }
    if (pathname === `${CLAUDE_SESSIONS_PANEL_PATH}/rename.json` && method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.threadId !== "string" || typeof body.name !== "string") {
        sendJson(res, 400, { error: "Requires { threadId: string, name: string }" });
        return;
      }
      const client = await getCatalogClient();
      await renameClaudeSession(client, body.threadId, body.name);
      sendJson(res, 200, {});
      return;
    }
    if (pathname === `${CLAUDE_SESSIONS_PANEL_PATH}/archive.json` && method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.threadId !== "string") {
        sendJson(res, 400, { error: "Requires { threadId: string }" });
        return;
      }
      const client = await getCatalogClient();
      await archiveClaudeSession(client, body.threadId);
      sendJson(res, 200, {});
      return;
    }
    if (pathname === `${CLAUDE_SESSIONS_PANEL_PATH}/unarchive.json` && method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.threadId !== "string") {
        sendJson(res, 400, { error: "Requires { threadId: string }" });
        return;
      }
      const client = await getCatalogClient();
      const session = await unarchiveClaudeSession(client, body.threadId);
      sendJson(res, 200, { session });
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  } catch (err) {
    if (err instanceof ClaudeSessionNotFoundError) {
      sendJson(res, 404, { error: err.message });
      return;
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

const MAX_BODY_BYTES = 16_384;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// Vanilla JS/CSS, no build step — same pattern as the Understand-Anything
// plugin's Ask/Tours widgets. Runs inside the sandboxed iframe, talks only to
// the JSON endpoints registered above (same-origin, so no separate token).
const PANEL_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Claude Sessions</title>
<style>
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; }
  #toolbar { display: flex; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #30363d; align-items: center; }
  #toolbar input { flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; padding: 6px 10px; }
  #toolbar button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  #toolbar button.active { background: #1f6feb; border-color: #1f6feb; }
  #list { padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }
  .row { border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .row .meta { min-width: 0; flex: 1; }
  .row .name { font-weight: 600; }
  .row .sub { color: #8b949e; font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .actions { display: flex; gap: 6px; flex-shrink: 0; }
  .row button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  #empty, #error { padding: 20px; color: #8b949e; text-align: center; }
  #error { color: #f85149; }
  #transcript { position: fixed; inset: 0; background: #0d1117; display: none; flex-direction: column; }
  #transcript.open { display: flex; }
  #transcript-header { padding: 10px 14px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
  #transcript-body { flex: 1; overflow-y: auto; padding: 14px; white-space: pre-wrap; line-height: 1.5; }
  .item { margin-bottom: 12px; }
  .item .who { color: #8b949e; font-size: 11px; margin-bottom: 2px; }
</style>
</head>
<body>
  <div id="toolbar">
    <input id="search" type="text" placeholder="Search by name or cwd..." />
    <button id="tab-active" class="active">Active</button>
    <button id="tab-archived">Archived</button>
  </div>
  <div id="list"></div>
  <div id="transcript">
    <div id="transcript-header">
      <span id="transcript-title"></span>
      <button id="transcript-close">Close</button>
    </div>
    <div id="transcript-body"></div>
  </div>
<script>
(function () {
  "use strict";
  var state = { archived: false, search: "" };

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    (children || []).forEach(function (c) { e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }

  function fmtTime(ms) {
    if (!ms) return "";
    try { return new Date(ms * 1000).toLocaleString(); } catch (e) { return ""; }
  }

  function renderRow(session) {
    var row = el("div", { class: "row" });
    var meta = el("div", { class: "meta" });
    meta.appendChild(el("div", { class: "name" }, [session.name || session.threadId.slice(0, 12)]));
    var subParts = [session.cwd || "", session.status, fmtTime(session.updatedAt)].filter(Boolean);
    meta.appendChild(el("div", { class: "sub" }, [subParts.join(" · ") + (session.preview ? " — " + session.preview : "")]));
    row.appendChild(meta);

    var actions = el("div", { class: "actions" });
    var openBtn = el("button", {}, ["Open"]);
    openBtn.addEventListener("click", function () { openTranscript(session); });
    actions.appendChild(openBtn);

    var renameBtn = el("button", {}, ["Rename"]);
    renameBtn.addEventListener("click", function () {
      var name = window.prompt("New name", session.name || "");
      if (name === null) return;
      postJson("/rename.json", { threadId: session.threadId, name: name }).then(load);
    });
    actions.appendChild(renameBtn);

    var toggleBtn = el("button", {}, [state.archived ? "Unarchive" : "Archive"]);
    toggleBtn.addEventListener("click", function () {
      var path = state.archived ? "/unarchive.json" : "/archive.json";
      postJson(path, { threadId: session.threadId }).then(load);
    });
    actions.appendChild(toggleBtn);

    row.appendChild(actions);
    return row;
  }

  function openTranscript(session) {
    var panel = document.getElementById("transcript");
    var title = document.getElementById("transcript-title");
    var body = document.getElementById("transcript-body");
    title.textContent = session.name || session.threadId;
    body.textContent = "Loading…";
    panel.classList.add("open");
    fetch("/plugins/claude/sessions/read.json?threadId=" + encodeURIComponent(session.threadId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        body.innerHTML = "";
        (data.items || []).forEach(function (item) {
          if (!item.text) return;
          var block = el("div", { class: "item" });
          block.appendChild(el("div", { class: "who" }, [item.type === "agentMessage" ? "Claude" : item.type === "toolCall" ? "Tool: " + (item.name || "") : "User"]));
          block.appendChild(el("div", {}, [item.text]));
          body.appendChild(block);
        });
        if (!body.children.length) body.textContent = "(no transcript content)";
      })
      .catch(function (err) { body.textContent = "Error: " + err.message; });
  }

  function postJson(path, payload) {
    return fetch("/plugins/claude/sessions" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); });
  }

  function load() {
    var list = document.getElementById("list");
    list.innerHTML = "Loading…";
    var qs = new URLSearchParams({ archived: String(state.archived) });
    if (state.search) qs.set("searchTerm", state.search);
    fetch("/plugins/claude/sessions/list.json?" + qs.toString())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        list.innerHTML = "";
        var sessions = data.sessions || [];
        if (!sessions.length) {
          list.appendChild(el("div", { id: "empty" }, ["No " + (state.archived ? "archived" : "active") + " sessions."]));
          return;
        }
        sessions.forEach(function (s) { list.appendChild(renderRow(s)); });
      })
      .catch(function (err) {
        list.innerHTML = "";
        list.appendChild(el("div", { id: "error" }, ["Error: " + err.message]));
      });
  }

  document.getElementById("tab-active").addEventListener("click", function () {
    state.archived = false;
    this.classList.add("active");
    document.getElementById("tab-archived").classList.remove("active");
    load();
  });
  document.getElementById("tab-archived").addEventListener("click", function () {
    state.archived = true;
    this.classList.add("active");
    document.getElementById("tab-active").classList.remove("active");
    load();
  });
  var searchTimer = null;
  document.getElementById("search").addEventListener("input", function (e) {
    state.search = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 250);
  });
  document.getElementById("transcript-close").addEventListener("click", function () {
    document.getElementById("transcript").classList.remove("open");
  });

  load();
})();
</script>
</body>
</html>`;
