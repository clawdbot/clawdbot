// Custom-widget scaffolding: creates the on-disk widget directory an agent (or an
// operator) authors against. Kept as a leaf module so both the agent tools and the
// gateway method can create a widget through the identical code path — the CLI must
// not be able to author a widget any way the agent cannot, and vice versa.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { validateWidgetManifest } from "./manifest.js";

export type WorkspaceScaffoldOptions = {
  name: string;
  title?: string;
  stateDir?: string;
  /** Provenance stamped into the scaffold's "built by" footer. */
  createdBy?: string;
};

export type WorkspaceScaffoldResult = {
  name: string;
  title: string;
  dir: string;
  manifestPath: string;
  htmlPath: string;
  readmePath: string;
};

const CUSTOM_WIDGET_NAME_PATTERN = /^(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;

function scaffoldTitle(name: string, title: string | undefined): string {
  if (title?.trim()) {
    return title.trim();
  }
  return name
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function widgetManifest(name: string, title: string) {
  return {
    schemaVersion: 1,
    name,
    title,
    entrypoint: "index.html",
    bindings: [{ id: "value", source: "static", value: "Hello from your workspace widget." }],
    capabilities: ["data:read"],
    preferredSize: { w: 6, h: 4 },
  };
}

function widgetHtml(title: string, createdBy: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --wg-bg: Canvas; --wg-text: CanvasText; --wg-accent: #ff5c5c; }
    body { margin: 0; padding: 16px; font-family: var(--font-sans, system-ui, sans-serif);
      background: var(--wg-bg); color: var(--wg-text); }
    h1 { margin: 0 0 12px; font-size: 1.1rem; }
    #value { white-space: pre-wrap; overflow-wrap: anywhere; }
    footer { margin-top: 16px; font-size: 0.75rem; color: var(--wg-accent); }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre id="value">Waiting for workspace data...</pre>
  <footer>Built by ${escapeHtml(createdBy)}</footer>
  <script>
    const valueNode = document.getElementById("value");
    const bridge = window.openclawWorkspaceBridge;
    function post(type, payload = {}) {
      bridge.postMessage({ v: 1, type, ...payload });
    }
    function render(data) {
      valueNode.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    function onData(message) {
      render(message.data);
    }
    function applyTheme(tokens) {
      const root = document.documentElement.style;
      if (tokens["--bg"]) root.setProperty("--wg-bg", tokens["--bg"]);
      if (tokens["--text"]) root.setProperty("--wg-text", tokens["--text"]);
      if (tokens["--accent"]) root.setProperty("--wg-accent", tokens["--accent"]);
    }
    bridge.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.v !== 1) return;
      if (message.type === "workspace:data" || message.type === "workspace:push") onData(message);
      else if (message.type === "workspace:theme") applyTheme(message.tokens || {});
      else if (message.type === "workspace:error") render({ error: message.message });
    });
    post("workspace:ready");
    post("workspace:getData", { requestId: "initial", bindingId: "value" });
    post("workspace:getTheme", { requestId: "theme" });
  </script>
</body>
</html>
`;
}

function widgetReadme(name: string): string {
  return `# ${name}

This workspace widget runs inside a sandboxed iframe and talks to the parent
Control UI through the document-bound workspace message bridge exposed as
\`window.openclawWorkspaceBridge\`.

- Send messages with \`window.openclawWorkspaceBridge.postMessage(...)\`.
- Listen with \`window.openclawWorkspaceBridge.addEventListener("message", ...)\`.
- Send \`{ "v": 1, "type": "workspace:ready" }\` when loaded.
- Send \`workspace:getData\` with a \`requestId\` and \`bindingId\` to read a declared binding.
- Re-render on \`workspace:data\` and \`workspace:push\`.
- Do not fetch gateway data directly; the authenticated parent resolves bindings.
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function scaffoldWorkspaceWidget(
  options: WorkspaceScaffoldOptions,
): Promise<WorkspaceScaffoldResult> {
  const name = options.name.trim();
  if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    throw new Error("widget name is invalid");
  }
  const widgetsRoot = path.resolve(options.stateDir ?? resolveStateDir(), "workspaces", "widgets");
  const widgetDir = path.resolve(widgetsRoot, name);
  // The charset pattern permits dots, so `.` and `..` pass it — containment is what
  // actually keeps the directory inside the widgets root. Check it before anything
  // else can report a different reason for rejecting the name.
  if (widgetDir === widgetsRoot || !widgetDir.startsWith(`${widgetsRoot}${path.sep}`)) {
    throw new Error("widget name is invalid");
  }
  const title = scaffoldTitle(name, options.title);
  // Validate what we are about to write: `loadWidgetManifest` enforces the same
  // schema at mount time, and a scaffold that cannot load is worse than a clear
  // error at creation time.
  validateWidgetManifest(widgetManifest(name, title), name);
  await fs.mkdir(widgetsRoot, { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(widgetDir, { mode: 0o700 });
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new Error("widget already exists", { cause: error });
    }
    throw error;
  }
  const manifestPath = path.join(widgetDir, "widget.json");
  const htmlPath = path.join(widgetDir, "index.html");
  const readmePath = path.join(widgetDir, "README.md");
  await Promise.all([
    fs.writeFile(
      `${manifestPath}.tmp`,
      `${JSON.stringify(widgetManifest(name, title), null, 2)}\n`,
      {
        mode: 0o600,
      },
    ),
    fs.writeFile(`${htmlPath}.tmp`, widgetHtml(title, options.createdBy ?? "an agent"), {
      mode: 0o600,
    }),
    fs.writeFile(`${readmePath}.tmp`, widgetReadme(name), { mode: 0o600 }),
  ]);
  await Promise.all([
    fs.rename(`${manifestPath}.tmp`, manifestPath),
    fs.rename(`${htmlPath}.tmp`, htmlPath),
    fs.rename(`${readmePath}.tmp`, readmePath),
  ]);
  return { name, title, dir: widgetDir, manifestPath, htmlPath, readmePath };
}
