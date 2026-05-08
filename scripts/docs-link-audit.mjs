#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveClawHubRepoPath, syncClawHubDocsTree } from "./docs-sync-publish.mjs";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const DOCS_JSON_PATH = path.join(DOCS_DIR, "docs.json");
const MINTLIFY_BROKEN_LINKS_ARGS = ["dlx", "mint", "broken-links", "--check-anchors"];
const NODE_25_UNSUPPORTED_BY_MINTLIFY = 25;

if (!fs.existsSync(DOCS_DIR) || !fs.statSync(DOCS_DIR).isDirectory()) {
  console.error("docs:check-links: missing docs directory; run from repo root.");
  process.exit(1);
}

if (!fs.existsSync(DOCS_JSON_PATH)) {
  console.error("docs:check-links: missing docs/docs.json.");
  process.exit(1);
}

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** @param {string} p */
function normalizeSlashes(p) {
  return p.replace(/\\/g, "/");
}

/** @param {string} p */
export function normalizeRoute(p) {
  const [withoutFragment] = p.split("#");
  const [withoutQuery] = withoutFragment.split("?");
  const stripped = withoutQuery.replace(/^\/+|\/+$/g, "");
  return stripped ? `/${stripped}` : "/";
}

/** @param {string} text */
function stripInlineCode(text) {
  return text.replace(/`[^`]+`/g, "");
}

function isLocalizedDocPath(p) {
  return /^\/?[a-z]{2}(?:-[A-Za-z]{2,8})+\//.test(p);
}

function isGeneratedTranslatedDoc(relPath) {
  return isLocalizedDocPath(relPath);
}

function addRoute(routes, slug) {
  const route = normalizeRoute(slug);
  routes.add(route);
  if (slug.endsWith("/index")) {
    routes.add(normalizeRoute(slug.slice(0, -"/index".length)));
  }
}

function createRedirectMap(docsConfig) {
  const redirects = new Map();
  for (const item of docsConfig.redirects || []) {
    const source = normalizeRoute(item.source || "");
    const destination = normalizeRoute(item.destination || "");
    redirects.set(source, destination);
  }
  return redirects;
}

function buildAuditIndex(docsDir = DOCS_DIR, options = {}) {
  const docsJsonPath = path.join(docsDir, "docs.json");
  const docsConfig = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
  const redirects = createRedirectMap(docsConfig);
  const allFiles = walk(docsDir);
  const relAllFiles = new Set(allFiles.map((abs) => normalizeSlashes(path.relative(docsDir, abs))));
  const markdownFiles = allFiles.filter((abs) => {
    if (!/\.(md|mdx)$/i.test(abs)) {
      return false;
    }
    const rel = normalizeSlashes(path.relative(docsDir, abs));
    return !isGeneratedTranslatedDoc(rel);
  });
  const routes = new Set();

  for (const abs of markdownFiles) {
    const rel = normalizeSlashes(path.relative(docsDir, abs));
    const text = fs.readFileSync(abs, "utf8");
    const slug = rel.replace(/\.(md|mdx)$/i, "");
    addRoute(routes, slug);

    if (!text.startsWith("---")) {
      continue;
    }

    const end = text.indexOf("\n---", 3);
    if (end === -1) {
      continue;
    }
    const frontMatter = text.slice(3, end);
    const match = frontMatter.match(/^permalink:\s*(.+)\s*$/m);
    if (!match) {
      continue;
    }
    const permalink = match[1].trim().replace(/^['"]|['"]$/g, "");
    routes.add(normalizeRoute(permalink));
  }

  if (options.allowExternalClawHubRoutes === true) {
    for (const page of collectNavPageEntries(docsConfig.navigation || [])) {
      if (isGeneratedTranslatedDoc(page)) {
        continue;
      }
      const route = normalizeRoute(page);
      if (route === "/clawhub" || route.startsWith("/clawhub/")) {
        addRoute(routes, page);
      }
    }
  }

  return { docsDir, docsConfig, redirects, allFiles, relAllFiles, markdownFiles, routes };
}

let defaultAuditIndex;

function getDefaultAuditIndex() {
  defaultAuditIndex ??= buildAuditIndex(DOCS_DIR);
  return defaultAuditIndex;
}

/**
 * @param {string} route
 * @param {{redirects?: Map<string, string>, routes?: Set<string>}} [options]
 */
export function resolveRoute(route, options = {}) {
  const defaultIndex = options.redirects && options.routes ? undefined : getDefaultAuditIndex();
  const redirectMap = options.redirects ?? defaultIndex.redirects;
  const publishedRoutes = options.routes ?? defaultIndex.routes;
  let current = normalizeRoute(route);
  if (current === "/") {
    return { ok: true, terminal: "/" };
  }

  const seen = new Set([current]);
  while (redirectMap.has(current)) {
    current = normalizeRoute(redirectMap.get(current));
    if (seen.has(current)) {
      return { ok: false, terminal: current, loop: true };
    }
    seen.add(current);
  }
  return { ok: publishedRoutes.has(current), terminal: current };
}

/** @param {unknown} node */
function collectNavPageEntries(node) {
  /** @type {string[]} */
  const entries = [];
  if (Array.isArray(node)) {
    for (const item of node) {
      entries.push(...collectNavPageEntries(item));
    }
    return entries;
  }

  if (!node || typeof node !== "object") {
    return entries;
  }

  const record = /** @type {Record<string, unknown>} */ (node);
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) {
      if (typeof page === "string") {
        entries.push(page);
      } else {
        entries.push(...collectNavPageEntries(page));
      }
    }
  }

  for (const value of Object.values(record)) {
    if (value !== record.pages) {
      entries.push(...collectNavPageEntries(value));
    }
  }

  return entries;
}

const markdownLinkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;

export function sanitizeDocsConfigForEnglishOnly(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeDocsConfigForEnglishOnly(item))
      .filter((item) => item !== undefined);
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "string" && isLocalizedDocPath(value)) {
      return undefined;
    }
    return value;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.language === "string" && record.language !== "en") {
    return undefined;
  }

  /** @type {Record<string, unknown>} */
  const sanitized = {};
  for (const [key, child] of Object.entries(record)) {
    const next = sanitizeDocsConfigForEnglishOnly(child);
    if (next === undefined) {
      continue;
    }
    if (Array.isArray(next) && next.length === 0) {
      continue;
    }
    if (
      next &&
      typeof next === "object" &&
      !Array.isArray(next) &&
      Object.keys(next).length === 0
    ) {
      continue;
    }
    sanitized[key] = next;
  }

  if (record.pages && !Array.isArray(sanitized.pages)) {
    return undefined;
  }
  if (record.groups && !Array.isArray(sanitized.groups)) {
    return undefined;
  }
  if (record.tabs && !Array.isArray(sanitized.tabs)) {
    return undefined;
  }
  if (
    "source" in record &&
    typeof record.source === "string" &&
    typeof sanitized.source !== "string"
  ) {
    return undefined;
  }
  if (
    "destination" in record &&
    typeof record.destination === "string" &&
    typeof sanitized.destination !== "string"
  ) {
    return undefined;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function prepareMirroredDocsDir(sourceDir = DOCS_DIR) {
  const sourceRoot = path.resolve(sourceDir);
  if (sourceRoot !== path.resolve(DOCS_DIR)) {
    return { dir: sourceRoot, mirroredClawHub: false, cleanup: () => {} };
  }

  const clawhubRepo = resolveClawHubRepoPath("", { required: false });
  if (!clawhubRepo) {
    return { dir: sourceRoot, mirroredClawHub: false, cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-link-audit-"));
  fs.cpSync(sourceRoot, tempDir, { recursive: true });
  syncClawHubDocsTree(tempDir, { repoPath: clawhubRepo, required: false });
  return {
    dir: tempDir,
    mirroredClawHub: true,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

export function prepareAnchorAuditDocsDir(sourceDir = DOCS_DIR) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-anchor-audit-"));
  fs.cpSync(sourceDir, tempDir, { recursive: true });

  for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!isGeneratedTranslatedDoc(`${entry.name}/`)) {
      continue;
    }
    fs.rmSync(path.join(tempDir, entry.name), { recursive: true, force: true });
  }

  const docsJsonPath = path.join(tempDir, "docs.json");
  const docsConfig = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
  const sanitized = sanitizeDocsConfigForEnglishOnly(docsConfig);
  fs.writeFileSync(docsJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");

  return tempDir;
}

/** @param {string} version */
function parseNodeMajor(version) {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

/**
 * Mintlify currently rejects Node 25+. If the repo script itself is running
 * under a too-new experimental Node, probe common local version managers and
 * use their Node 22 wrapper for only the Mintlify child process.
 *
 * @param {{
 *   cwd: string;
 *   nodeVersion?: string;
 *   spawnSyncImpl: typeof spawnSync;
 * }} params
 */
export function resolveMintlifyAnchorAuditInvocation(params) {
  const nodeVersion = params.nodeVersion ?? process.versions.node;
  if (parseNodeMajor(nodeVersion) < NODE_25_UNSUPPORTED_BY_MINTLIFY) {
    return { command: "pnpm", args: MINTLIFY_BROKEN_LINKS_ARGS };
  }

  const node22Probe = "process.exit(Number(process.versions.node.split('.')[0]) === 22 ? 0 : 1)";
  const candidates = [
    {
      command: "fnm",
      probeArgs: ["exec", "--using=22", "node", "-e", node22Probe],
      args: ["exec", "--using=22", "pnpm", ...MINTLIFY_BROKEN_LINKS_ARGS],
    },
    {
      command: "mise",
      probeArgs: ["exec", "node@22", "--", "node", "-e", node22Probe],
      args: ["exec", "node@22", "--", "pnpm", ...MINTLIFY_BROKEN_LINKS_ARGS],
    },
  ];

  for (const candidate of candidates) {
    const probe = params.spawnSyncImpl(candidate.command, candidate.probeArgs, {
      cwd: params.cwd,
      stdio: "ignore",
    });
    if (probe.status === 0) {
      return { command: candidate.command, args: candidate.args };
    }
  }

  return { command: "pnpm", args: MINTLIFY_BROKEN_LINKS_ARGS };
}

export function auditDocsLinks(options = {}) {
  const docsDir = options.docsDir ?? DOCS_DIR;
  const index = buildAuditIndex(docsDir, {
    allowExternalClawHubRoutes: options.allowExternalClawHubRoutes === true,
  });
  /** @type {{file: string; line: number; link: string; reason: string}[]} */
  const broken = [];
  let checked = 0;

  for (const abs of index.markdownFiles) {
    const rel = normalizeSlashes(path.relative(index.docsDir, abs));
    const baseDir = normalizeSlashes(path.dirname(rel));
    const rawText = fs.readFileSync(abs, "utf8");
    const lines = rawText.split("\n");

    let inCodeFence = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      let line = lines[lineNum];

      if (line.trim().startsWith("```")) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) {
        continue;
      }

      line = stripInlineCode(line);

      for (const match of line.matchAll(markdownLinkRegex)) {
        const raw = match[1]?.trim();
        if (!raw) {
          continue;
        }
        if (/^(https?:|mailto:|tel:|data:|#)/i.test(raw)) {
          continue;
        }

        const [pathPart] = raw.split("#");
        const clean = pathPart.split("?")[0];
        if (!clean) {
          continue;
        }
        checked++;

        if (clean.startsWith("/")) {
          const route = normalizeRoute(clean);
          const resolvedRoute = resolveRoute(route, {
            redirects: index.redirects,
            routes: index.routes,
          });
          if (!resolvedRoute.ok) {
            const staticRel = route.replace(/^\//, "");
            if (!index.relAllFiles.has(staticRel)) {
              broken.push({
                file: rel,
                line: lineNum + 1,
                link: raw,
                reason: `route/file not found (terminal: ${resolvedRoute.terminal})`,
              });
              continue;
            }
          }
          continue;
        }

        if (!clean.startsWith(".") && !clean.includes("/")) {
          continue;
        }

        const normalizedRel = normalizeSlashes(path.normalize(path.join(baseDir, clean)));

        if (/\.[a-zA-Z0-9]+$/.test(normalizedRel)) {
          if (!index.relAllFiles.has(normalizedRel)) {
            broken.push({
              file: rel,
              line: lineNum + 1,
              link: raw,
              reason: "relative file not found",
            });
          }
          continue;
        }

        const candidates = [
          normalizedRel,
          `${normalizedRel}.md`,
          `${normalizedRel}.mdx`,
          `${normalizedRel}/index.md`,
          `${normalizedRel}/index.mdx`,
        ];

        if (!candidates.some((candidate) => index.relAllFiles.has(candidate))) {
          broken.push({
            file: rel,
            line: lineNum + 1,
            link: raw,
            reason: "relative doc target not found",
          });
        }
      }
    }
  }

  for (const page of collectNavPageEntries(index.docsConfig.navigation || [])) {
    if (isGeneratedTranslatedDoc(page)) {
      continue;
    }
    checked++;
    const route = normalizeRoute(page);
    const resolvedRoute = resolveRoute(route, {
      redirects: index.redirects,
      routes: index.routes,
    });
    if (resolvedRoute.ok) {
      continue;
    }

    broken.push({
      file: "docs.json",
      line: 0,
      link: page,
      reason: `navigation page not published (terminal: ${resolvedRoute.terminal})`,
    });
  }

  return { checked, broken };
}

/**
 * @param {{
 *   args?: string[];
 *   nodeVersion?: string;
 *   spawnSyncImpl?: typeof spawnSync;
 *   prepareAnchorAuditDocsDirImpl?: (sourceDir?: string) => string;
 *   cleanupAnchorAuditDocsDirImpl?: (dir: string) => void;
 * }} [options]
 */
export function runDocsLinkAuditCli(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  if (args.includes("--anchors")) {
    const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
    const prepareAnchorAuditDocsDirImpl =
      options.prepareAnchorAuditDocsDirImpl ?? prepareAnchorAuditDocsDir;
    const cleanupAnchorAuditDocsDirImpl =
      options.cleanupAnchorAuditDocsDirImpl ??
      ((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    const mirroredDocsDir = prepareMirroredDocsDir(DOCS_DIR);
    const anchorDocsDir = prepareAnchorAuditDocsDirImpl(mirroredDocsDir.dir);

    try {
      // Use the npm Mintlify package explicitly. Some developer machines also
      // have the Swift Package Manager tool named `mint` on PATH, and that
      // binary exits with "command 'broken-links' not found".
      const invocation = resolveMintlifyAnchorAuditInvocation({
        cwd: anchorDocsDir,
        nodeVersion: options.nodeVersion,
        spawnSyncImpl,
      });
      const result = spawnSyncImpl(invocation.command, invocation.args, {
        cwd: anchorDocsDir,
        stdio: "inherit",
      });

      return result.status ?? 1;
    } finally {
      cleanupAnchorAuditDocsDirImpl(anchorDocsDir);
      mirroredDocsDir.cleanup();
    }
  }

  const mirroredDocsDir = prepareMirroredDocsDir(DOCS_DIR);
  try {
    const { checked, broken } = auditDocsLinks({
      docsDir: mirroredDocsDir.dir,
      allowExternalClawHubRoutes: !mirroredDocsDir.mirroredClawHub,
    });
    console.log(`checked_internal_links=${checked}`);
    console.log(`broken_links=${broken.length}`);

    for (const item of broken) {
      console.log(`${item.file}:${item.line} :: ${item.link} :: ${item.reason}`);
    }

    return broken.length > 0 ? 1 : 0;
  } finally {
    mirroredDocsDir.cleanup();
  }
}

function isCliEntry() {
  const cliArg = process.argv[1];
  return cliArg ? import.meta.url === pathToFileURL(cliArg).href : false;
}

if (isCliEntry()) {
  process.exit(runDocsLinkAuditCli());
}
