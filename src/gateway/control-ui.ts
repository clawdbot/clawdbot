import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_PREFIX = "/";
const AVATAR_PREFIX = "/avatar";

// === Assistant Identity Resolution ===

const DEFAULT_ASSISTANT_IDENTITY = {
  name: "Assistant",
  avatar: "A",
};

interface AssistantIdentity {
  name: string;
  avatar: string;
}

interface AssistantConfig {
  name?: string;
  avatar?: string;
}

function parseIdentityMd(content: string): Partial<AssistantIdentity> {
  const result: Partial<AssistantIdentity> = {};
  const nameMatch = content.match(/^-\s*Name:\s*(.+)$/im);
  if (nameMatch?.[1]) {
    const name = nameMatch[1].trim();
    if (name && name.length <= 50) {
      result.name = name;
    }
  }
  const emojiMatch = content.match(/^-\s*Emoji:\s*(.+)$/im);
  if (emojiMatch?.[1]) {
    const emoji = emojiMatch[1].trim();
    if (emoji) {
      result.avatar = emoji;
    }
  }
  return result;
}

function resolveAssistantIdentity(opts?: {
  configAssistant?: AssistantConfig;
  workspaceDir?: string;
}): AssistantIdentity {
  const { configAssistant, workspaceDir } = opts ?? {};
  let name = DEFAULT_ASSISTANT_IDENTITY.name;
  let avatar = DEFAULT_ASSISTANT_IDENTITY.avatar;

  // Try IDENTITY.md from workspace
  if (workspaceDir) {
    try {
      const identityPath = path.join(workspaceDir, "IDENTITY.md");
      if (fs.existsSync(identityPath)) {
        const identityMd = parseIdentityMd(fs.readFileSync(identityPath, "utf8"));
        if (identityMd.name) name = identityMd.name;
        if (identityMd.avatar) avatar = identityMd.avatar;
      }
    } catch {
      // Ignore errors reading IDENTITY.md
    }
  }

  // Config overrides IDENTITY.md
  if (configAssistant?.name?.trim()) name = configAssistant.name.trim();
  if (configAssistant?.avatar?.trim()) avatar = configAssistant.avatar.trim();

  return { name, avatar };
}

// === End Assistant Identity ===

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: {
    ui?: {
      assistant?: AssistantConfig;
    };
  };
  workspaceDir?: string;
};

export function normalizeControlUiBasePath(basePath?: string): string {
  if (!basePath) return "";
  let normalized = basePath.trim();
  if (!normalized) return "";
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized === "/") return "";
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function resolveControlUiRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const execDir = (() => {
    try {
      return path.dirname(fs.realpathSync(process.execPath));
    } catch {
      return null;
    }
  })();
  const candidates = [
    // Packaged app: control-ui lives alongside the executable.
    execDir ? path.resolve(execDir, "control-ui") : null,
    // Running from dist: dist/gateway/control-ui.js -> dist/control-ui
    path.resolve(here, "../control-ui"),
    // Running from source: src/gateway/control-ui.ts -> dist/control-ui
    path.resolve(here, "../../dist/control-ui"),
    // Fallback to cwd (dev)
    path.resolve(process.cwd(), "dist", "control-ui"),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function buildAvatarUrl(basePath: string, agentId: string): string {
  return basePath ? `${basePath}${AVATAR_PREFIX}/${agentId}` : `${AVATAR_PREFIX}/${agentId}`;
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath ? `${basePath}${AVATAR_PREFIX}/` : `${AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) return false;

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondNotFound(res);
    return true;
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeForExt(path.extname(resolved.filePath).toLowerCase()));
    res.setHeader("Cache-Control", "no-cache");
    res.end();
    return true;
  }

  serveFile(res, resolved.filePath);
  return true;
}

function respondNotFound(res: ServerResponse) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function serveFile(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(filePath));
}

interface ControlUiInjectionOpts {
  basePath: string;
  assistantName?: string;
  assistantAvatar?: string;
}

function injectControlUiConfig(html: string, opts: ControlUiInjectionOpts): string {
  const { basePath, assistantName, assistantAvatar } = opts;
  const script =
    `<script>` +
    `window.__CLAWDBOT_CONTROL_UI_BASE_PATH__=${JSON.stringify(basePath)};` +
    `window.__CLAWDBOT_ASSISTANT_NAME__=${JSON.stringify(assistantName ?? "Assistant")};` +
    `window.__CLAWDBOT_ASSISTANT_AVATAR__=${JSON.stringify(assistantAvatar ?? "A")};` +
    `</script>`;
  // Check if already injected
  if (html.includes("__CLAWDBOT_ASSISTANT_NAME__")) return html;
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return `${html.slice(0, headClose)}${script}${html.slice(headClose)}`;
  }
  return `${script}${html}`;
}

interface ServeIndexHtmlOpts {
  basePath: string;
  config?: ControlUiRequestOptions["config"];
  workspaceDir?: string;
}

function serveIndexHtml(res: ServerResponse, indexPath: string, opts: ServeIndexHtmlOpts) {
  const { basePath, config, workspaceDir } = opts;
  const identity = resolveAssistantIdentity({
    configAssistant: config?.ui?.assistant,
    workspaceDir,
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const raw = fs.readFileSync(indexPath, "utf8");
  res.end(
    injectControlUiConfig(raw, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: identity.avatar,
    }),
  );
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) return false;
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") return false;
  if (normalized.includes("\0")) return false;
  return true;
}

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;

  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      respondNotFound(res);
      return true;
    }
  }

  if (basePath) {
    if (pathname === basePath) {
      res.statusCode = 302;
      res.setHeader("Location", `${basePath}/${url.search}`);
      res.end();
      return true;
    }
    if (!pathname.startsWith(`${basePath}/`)) return false;
  }

  const root = resolveControlUiRoot();
  if (!root) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    );
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) return "";
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) return uiPath.slice(assetsIndex + 1);
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondNotFound(res);
    return true;
  }

  const filePath = path.join(root, fileRel);
  if (!filePath.startsWith(root)) {
    respondNotFound(res);
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (path.basename(filePath) === "index.html") {
      serveIndexHtml(res, filePath, { basePath, config: opts?.config, workspaceDir: opts?.workspaceDir });
      return true;
    }
    serveFile(res, filePath);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    serveIndexHtml(res, indexPath, { basePath, config: opts?.config, workspaceDir: opts?.workspaceDir });
    return true;
  }

  respondNotFound(res);
  return true;
}
