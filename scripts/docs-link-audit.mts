#!/usr/bin/env node

// Audits docs links against the shared publishing parser and route contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProcessor } from "@mdx-js/mdx";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import MarkdownIt from "markdown-it";
import type { Nodes } from "mdast";
import { resolveClawHubRepoPath, syncClawHubDocsTree } from "./docs-sync-publish.mjs";
import { parseDocsDocument, resolveDocsFragment } from "./lib/docs-markdown.mjs";
import {
  addRoute,
  collectMirroredDocsRoutes,
  collectNavPageEntries,
  normalizeRoute,
} from "./lib/docs-published-routes.mts";
import { resolveRedirects } from "./lib/docs-redirects.mjs";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const DOCS_JSON_PATH = path.join(DOCS_DIR, "docs.json");
const ROOT_MARKDOWN_FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
const MDX_PROCESSOR = createProcessor({ format: "mdx" });
const MARKDOWN_PARSER = new MarkdownIt({ html: false });
const HTML_MARKDOWN_PARSER = new MarkdownIt({ html: true });
type MarkdownToken = ReturnType<typeof MARKDOWN_PARSER.parse>[number];
const VERBATIM_MDX_ELEMENTS = new Set(["code", "pre", "script", "style", "textarea"]);
if (!fs.existsSync(DOCS_DIR) || !fs.statSync(DOCS_DIR).isDirectory()) {
  console.error("docs:check-links: missing docs directory; run from repo root.");
  process.exit(1);
}

if (!fs.existsSync(DOCS_JSON_PATH)) {
  console.error("docs:check-links: missing docs/docs.json.");
  process.exit(1);
}

function walk(dir: string): string[] {
  const out: string[] = [];
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

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function collectMarkdownCodeLines(tokens: MarkdownToken[]): Set<number> {
  const lines = new Set<number>();
  for (const token of tokens) {
    if ((token.type === "fence" || token.type === "code_block") && token.map) {
      for (let line = token.map[0]; line < token.map[1]; line++) {
        lines.add(line);
      }
    }
  }
  return lines;
}

/**
 * Projects parsed Markdown links onto their source lines. MDX parsing owns the
 * normal path; markdown-it is a tolerant fallback for legacy malformed pages.
 */
function projectExternalLinkMarkdown(raw: string) {
  // Lychee also receives every original source file for HTML attributes and bare URLs.
  // This line-stable companion contains only parsed Markdown links hidden by MDX blocks.
  const projected: string[] = raw.split("\n").map((line) => (line.endsWith("\r") ? "\r" : ""));
  let projectedLinks = 0;
  const appendLink = (line: number | undefined, url: string | null | undefined) => {
    if (
      line === undefined ||
      !Number.isInteger(line) ||
      line < 1 ||
      line > projected.length ||
      !url
    ) {
      return;
    }
    const index = line - 1;
    const projectedLine = projected[index];
    if (projectedLine === undefined) {
      return;
    }
    const suffix = projectedLine.endsWith("\r") ? "\r" : "";
    const existing = suffix ? projectedLine.slice(0, -1) : projectedLine;
    const separator = existing ? " " : "";
    projected[index] =
      `${existing}${separator}<a href="${escapeHtmlAttribute(url)}">link</a>${suffix}`;
    projectedLinks += 1;
  };

  try {
    const tree = MDX_PROCESSOR.parse(raw);
    const definitions = new Map<string, string>();
    const collectDefinitions = (node: Nodes): void => {
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
      if ("children" in node) {
        for (const child of node.children) {
          collectDefinitions(child);
        }
      }
    };
    collectDefinitions(tree);

    const collectLinks = (node: Nodes, verbatim = false): void => {
      const nextVerbatim =
        verbatim ||
        ((node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
          node.name !== null &&
          VERBATIM_MDX_ELEMENTS.has(node.name));
      if (!nextVerbatim) {
        if (node.type === "link" || node.type === "image") {
          appendLink(node.position?.start.line, node.url);
        } else if (node.type === "linkReference" || node.type === "imageReference") {
          appendLink(node.position?.start.line, definitions.get(node.identifier));
        }
      }
      if ("children" in node) {
        for (const child of node.children) {
          collectLinks(child, nextVerbatim);
        }
      }
    };
    collectLinks(tree);
  } catch {
    const rawLines = raw.split("\n");
    const inlineVerbatimLinks = new Map<string, number>();
    const transparentEnv: Record<string, unknown> = {};
    const transparentTokens = MARKDOWN_PARSER.parse(raw, transparentEnv);
    const fallbackCodeLines = collectMarkdownCodeLines(transparentTokens);
    const childUrl = (child: MarkdownToken): string | undefined => {
      const value =
        child.type === "link_open"
          ? child.attrGet("href")
          : child.type === "image"
            ? child.attrGet("src")
            : undefined;
      return typeof value === "string" ? value : undefined;
    };
    const sourceLineForUrl = (token: MarkdownToken, url: string): number => {
      if (!token.map) {
        return 0;
      }
      const escapedUrl = url.replaceAll("&", "&amp;");
      for (let line = token.map[0]; line < token.map[1]; line += 1) {
        if (rawLines[line]?.includes(url) || rawLines[line]?.includes(escapedUrl)) {
          return line;
        }
        for (const inlineToken of MARKDOWN_PARSER.parseInline(
          rawLines[line] ?? "",
          transparentEnv,
        )) {
          if ((inlineToken.children ?? []).some((child) => childUrl(child) === url)) {
            return line;
          }
        }
      }
      return token.map[0];
    };
    const inlineVerbatimStack: string[] = [];
    for (const [line, rawLine] of rawLines.entries()) {
      if (inlineVerbatimStack.length === 0 && fallbackCodeLines.has(line)) {
        continue;
      }
      for (const token of HTML_MARKDOWN_PARSER.parseInline(rawLine, transparentEnv)) {
        for (const child of token.children ?? []) {
          if (child.type === "html_inline") {
            const closingTag = child.content.match(/^<\/([a-z][A-Za-z0-9.:_-]*)[\t ]*>$/u)?.[1];
            if (closingTag) {
              const openingIndex = inlineVerbatimStack.lastIndexOf(closingTag);
              if (openingIndex >= 0) {
                inlineVerbatimStack.length = openingIndex;
              }
              continue;
            }
            const openingTag = child.content.match(
              /^<([a-z][A-Za-z0-9.:_-]*)(?:[\t ][^<>]*?)?(\/?)>$/u,
            );
            const openingName = openingTag?.[1];
            if (openingName && !openingTag[2] && VERBATIM_MDX_ELEMENTS.has(openingName)) {
              inlineVerbatimStack.push(openingName);
            }
            continue;
          }
          const url = childUrl(child);
          if (inlineVerbatimStack.length > 0 && url) {
            const key = `${line}\0${url}`;
            inlineVerbatimLinks.set(key, (inlineVerbatimLinks.get(key) ?? 0) + 1);
          }
        }
      }
    }
    for (const token of transparentTokens) {
      if (token.type !== "inline" || !token.map) {
        continue;
      }
      for (const child of token.children ?? []) {
        const url = childUrl(child);
        if (!url) {
          continue;
        }
        const sourceLine = sourceLineForUrl(token, url);
        const key = `${sourceLine}\0${url}`;
        const hiddenOccurrences = inlineVerbatimLinks.get(key) ?? 0;
        if (hiddenOccurrences > 0) {
          inlineVerbatimLinks.set(key, hiddenOccurrences - 1);
          continue;
        }
        appendLink(sourceLine + 1, url);
      }
    }
  }

  return { text: projected.join("\n"), projectedLinks };
}

/**
 * Writes a parallel docs tree that exposes Markdown nested in HTML/MDX blocks.
 * Original inputs still cover tag attributes; projected inputs cover children.
 */
export function prepareExternalLinkAuditTree(repoRoot: string, outputDir: string) {
  const root = path.resolve(repoRoot);
  const docsRoot = path.join(root, "docs");
  const outputRoot = path.resolve(outputDir);
  if (fs.existsSync(outputRoot)) {
    throw new Error(`external-link audit input already exists: ${outputRoot}`);
  }
  const outputFromDocs = path.relative(docsRoot, outputRoot);
  if (
    outputFromDocs === "" ||
    (!outputFromDocs.startsWith(`..${path.sep}`) &&
      outputFromDocs !== ".." &&
      !path.isAbsolute(outputFromDocs))
  ) {
    throw new Error("external-link audit output must be outside docs");
  }

  const sourcePaths = [
    ...walk(docsRoot).filter((filePath) => /\.mdx?$/iu.test(filePath)),
    ...ROOT_MARKDOWN_FILES.map((filename) => path.join(root, filename)),
  ];
  let projectedLinks = 0;
  for (const sourcePath of sourcePaths) {
    const targetPath = path.join(outputRoot, path.relative(root, sourcePath));
    const raw = fs.readFileSync(sourcePath, "utf8");
    const projected = projectExternalLinkMarkdown(raw);
    projectedLinks += projected.projectedLinks;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, projected.text, "utf8");
  }

  return { files: sourcePaths.length, projectedLinks };
}

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, "/");
}

function isLocalizedDocPath(p: string) {
  return /^\/?[a-z]{2}(?:-[A-Za-z]{2,8})+\//.test(p);
}

function isGeneratedTranslatedDoc(relPath: string) {
  return isLocalizedDocPath(relPath);
}

function createRedirectMap(docsConfig: Record<string, unknown>): Map<string, string> {
  const redirects = new Map<string, string>();
  const redirectEntries = Array.isArray(docsConfig.redirects) ? docsConfig.redirects : [];
  for (const item of redirectEntries) {
    if (!isRecord(item)) {
      continue;
    }
    const source = normalizeRoute(typeof item.source === "string" ? item.source : "");
    const destination = normalizeRoute(
      typeof item.destination === "string" ? item.destination : "",
    );
    redirects.set(source, destination);
  }
  return redirects;
}

function buildAuditIndex(
  docsDir = DOCS_DIR,
  options: { allowExternalClawHubRoutes?: boolean } = {},
) {
  const docsJsonPath = path.join(docsDir, "docs.json");
  const parsedConfig: unknown = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
  if (!isRecord(parsedConfig)) {
    throw new Error(`${docsJsonPath} must contain an object`);
  }
  const docsConfig = parsedConfig;
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
  const routes = new Set<string>();

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
    const permalink = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    routes.add(normalizeRoute(permalink));
  }

  if (options.allowExternalClawHubRoutes === true) {
    for (const route of collectMirroredDocsRoutes(docsConfig.navigation)) {
      routes.add(route);
    }
  }

  return { docsDir, docsConfig, redirects, allFiles, relAllFiles, markdownFiles, routes };
}

let defaultAuditIndex: ReturnType<typeof buildAuditIndex> | undefined;

function getDefaultAuditIndex() {
  defaultAuditIndex ??= buildAuditIndex(DOCS_DIR);
  return defaultAuditIndex;
}

export function resolveRoute(
  route: string,
  options: { redirects?: Map<string, string>; routes?: Set<string> } = {},
) {
  const redirectMap = options.redirects ?? getDefaultAuditIndex().redirects;
  const publishedRoutes = options.routes ?? getDefaultAuditIndex().routes;
  let current = normalizeRoute(route);
  if (current === "/") {
    return { ok: true, terminal: "/" };
  }

  const seen = new Set([current]);
  while (redirectMap.has(current)) {
    current = normalizeRoute(redirectMap.get(current) ?? "");
    if (seen.has(current)) {
      return { ok: false, terminal: current, loop: true };
    }
    seen.add(current);
  }
  return { ok: publishedRoutes.has(current), terminal: current };
}

/** Prepares a docs directory, mirroring ClawHub docs when available. */
export function prepareMirroredDocsDir(
  sourceDir = DOCS_DIR,
  options: {
    resolveClawHubRepoPathImpl?: (
      value?: string,
      options?: { required?: boolean },
    ) => string | undefined;
    syncClawHubDocsTreeImpl?: (
      targetDocsDir: string,
      options?: { repoPath?: string; required?: boolean },
    ) => unknown;
  } = {},
) {
  const sourceRoot = path.resolve(sourceDir);
  if (sourceRoot !== path.resolve(DOCS_DIR)) {
    return { dir: sourceRoot, mirroredClawHub: false, cleanup: () => {} };
  }

  const resolveClawHubRepoPathImpl = options.resolveClawHubRepoPathImpl ?? resolveClawHubRepoPath;
  const syncClawHubDocsTreeImpl = options.syncClawHubDocsTreeImpl ?? syncClawHubDocsTree;
  const clawhubRepo = resolveClawHubRepoPathImpl("", { required: false });
  if (!clawhubRepo) {
    return { dir: sourceRoot, mirroredClawHub: false, cleanup: () => {} };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-link-audit-"));
  const tempDir = path.join(tempRoot, "docs");
  try {
    fs.cpSync(sourceRoot, tempDir, { recursive: true });
    syncClawHubDocsTreeImpl(tempDir, { repoPath: clawhubRepo, required: false });
    return {
      dir: tempDir,
      mirroredClawHub: true,
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseAuditUrl(
  href: string,
  base = "https://docs.openclaw.ai",
): Result<{ hostname: string; pathname: string; hash: string }, string> {
  try {
    const url = new URL(href, base);
    return ok({
      hostname: url.hostname,
      pathname:
        url.hostname === "docs.openclaw.ai" ? decodeURIComponent(url.pathname) : url.pathname,
      hash: url.hash,
    });
  } catch (error) {
    return err(error instanceof URIError ? "malformed URL path" : "malformed URL");
  }
}

/**
 * Audits local docs links against route, file, and redirect indexes.
 */
function auditDocsLinks(
  options: { docsDir?: string; allowExternalClawHubRoutes?: boolean; anchors?: boolean } = {},
) {
  const docsDir = options.docsDir ?? DOCS_DIR;
  const index = buildAuditIndex(docsDir, {
    allowExternalClawHubRoutes: options.allowExternalClawHubRoutes === true,
  });
  const broken: Array<{ file: string; line: number; link: string; reason: string }> = [];
  let checked = 0;

  // The publisher writes physical/index routes; frontmatter permalinks do not
  // create pages. Only emitted pages and configured redirects can prove fragments.
  const pages = new Map<string, ReturnType<typeof parseDocsDocument>>();
  const pageRoute = (rel: string) =>
    normalizeRoute(rel.replace(/\.mdx?$/i, "").replace(/(?:^|\/)index$/, ""));
  for (const abs of index.markdownFiles) {
    const rel = normalizeSlashes(path.relative(index.docsDir, abs));
    pages.set(
      pageRoute(rel),
      parseDocsDocument(fs.readFileSync(abs, "utf8"), undefined, {
        sourceFile: abs,
        root: path.dirname(index.docsDir),
        pageRoute: pageRoute(rel),
        mapLink: (href: string, line: number | undefined) => ({ href, line: line ?? 0 }),
      }),
    );
  }
  const collisions = [...pages].flatMap(([route, document]) =>
    document.collisions.map((collision) => ({ route, ...collision })),
  );
  if (options.anchors) {
    for (const collision of collisions) {
      if (collision.reason === "duplicate authored/canonical ID") {
        broken.push({
          file: collision.route,
          line: 0,
          link: `#${collision.id}`,
          reason: collision.reason,
        });
      }
    }
  }
  const redirectTargets = new Map<string, ReturnType<typeof parseAuditUrl>>();
  if (options.anchors) {
    const records = resolveRedirects({
      redirects: index.docsConfig.redirects ?? [],
      pages: [...pages.keys()].map((route) => ({ route, markdownRoute: `${route}.md` })),
      localeCodes: ["en"],
      prefixes: [],
      publicPath: (route: string) => route,
      onError: (source: string, error: Error) =>
        broken.push({ file: "docs.json", line: 0, link: source, reason: error.message }),
    });
    for (const record of records) {
      const destinationResult = parseAuditUrl(record.destination);
      redirectTargets.set(record.source, destinationResult);
      if (!destinationResult.ok) {
        broken.push({
          file: "docs.json",
          line: 0,
          link: record.source,
          reason: destinationResult.error,
        });
        continue;
      }
      const destination = destinationResult.value;
      if (destination.hostname !== "docs.openclaw.ai") {
        continue;
      }
      const page = pages.get(destination.pathname);
      if (page && destination.hash && !resolveDocsFragment(destination.hash, new Set(page.ids))) {
        broken.push({
          file: "docs.json",
          line: 0,
          link: record.source,
          reason: `redirect fragment not found: ${record.destination}`,
        });
      }
    }
  }
  for (const abs of index.markdownFiles) {
    const rel = normalizeSlashes(path.relative(index.docsDir, abs));
    const document = pages.get(pageRoute(rel))!;
    for (const { href: raw, line } of document.links) {
      const local = !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw);
      if (!options.anchors && (!local || raw.startsWith("#"))) {
        continue;
      }
      const urlResult = parseAuditUrl(raw, `https://docs.openclaw.ai${pageRoute(rel)}`);
      if (urlResult.ok && urlResult.value.hostname !== "docs.openclaw.ai") {
        continue;
      }
      checked++;
      if (!urlResult.ok) {
        broken.push({ file: rel, line, link: raw, reason: urlResult.error });
        continue;
      }
      const url = urlResult.value;
      const route = pageRoute(url.pathname).replace(/^\/en(?:\/|$)/, "/");
      const destinationResult =
        options.anchors && !pages.has(route) && redirectTargets.has(route)
          ? redirectTargets.get(route)!
          : urlResult;
      if (!destinationResult.ok) {
        broken.push({ file: rel, line, link: raw, reason: destinationResult.error });
        continue;
      }
      const destination = destinationResult.value;
      if (destination.hostname !== "docs.openclaw.ai") {
        continue;
      }
      const terminal = pageRoute(destination.pathname).replace(/^\/en(?:\/|$)/, "/");
      const page = pages.get(terminal);
      const resolved = resolveRoute(route, { redirects: index.redirects, routes: index.routes });
      if (
        !page &&
        (options.anchors || !resolved.ok) &&
        !index.relAllFiles.has(url.pathname.slice(1))
      ) {
        broken.push({
          file: rel,
          line,
          link: raw,
          reason: `route/file not found (terminal: ${resolved.terminal})`,
        });
      } else if (
        options.anchors &&
        destination.hash &&
        page &&
        (/\.mdx?$/.test(destination.pathname) ||
          !resolveDocsFragment(destination.hash, new Set(page.ids)))
      ) {
        broken.push({
          file: rel,
          line,
          link: raw,
          reason: /\.mdx?$/.test(destination.pathname)
            ? "fragment requires an HTML page, not raw Markdown"
            : `fragment not found (terminal: ${terminal}${destination.hash})`,
        });
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

  return { checked, broken, collisions };
}

/** Runs the docs link audit CLI. */
function runDocsLinkAuditCli() {
  const args = process.argv.slice(2);
  if (args[0] === "--prepare-external-links") {
    if (args.length !== 2 || !args[1]) {
      console.error("usage: docs-link-audit.mjs --prepare-external-links <output-dir>");
      return 1;
    }
    const result = prepareExternalLinkAuditTree(ROOT, path.resolve(ROOT, args[1]));
    console.log(`prepared_external_link_files=${result.files}`);
    console.log(`projected_markdown_links=${result.projectedLinks}`);
    return 0;
  }

  const mirroredDocsDir = prepareMirroredDocsDir(DOCS_DIR);
  try {
    const { checked, broken, collisions } = auditDocsLinks({
      docsDir: mirroredDocsDir.dir,
      allowExternalClawHubRoutes: !mirroredDocsDir.mirroredClawHub,
      anchors: args.includes("--anchors"),
    });
    console.log(`checked_internal_links=${checked}`);
    console.log(`broken_links=${broken.length}`);
    if (args.includes("--anchors")) {
      console.log(
        `omitted_compatibility_aliases=${collisions.filter((item) => item.reason === "compatibility alias collision").length}`,
      );
    }

    for (const item of broken) {
      console.log(`${item.file}:${item.line || "unknown"} :: ${item.link} :: ${item.reason}`);
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
