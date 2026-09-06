import fs from "node:fs";
import path from "node:path";
import slugify, { slugifyWithCounter } from "@sindresorhus/slugify";
import { Parser } from "htmlparser2";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import { parse } from "yaml";

/** @public Consumed by openclaw/docs mdx-ish.mjs through the docs-sync support contract. */
export const markerPrefix = "OPENCLAW_DOCS_MARKER";
/** @public Consumed by openclaw/docs mdx-ish.mjs through the docs-sync support contract. */
export const inlineMarkerPrefix = "OPENCLAW_DOCS_INLINE";
const knownBlocks = new Map([
  ["AccordionGroup", ["accordion-group", ""]],
  ["Tabs", ["tabs", ""]],
  ["CodeGroup", ["code-group", ""]],
  ["TileGroup", ["tile-group", ""]],
  ["CTAGroup", ["cta-grid", ""]],
  ["StatGrid", ["stat-grid", ""]],
]);
const callouts = new Map([
  ["Note", "Note"],
  ["Warning", "Warning"],
  ["Tip", "Tip"],
  ["Info", "Info"],
  ["Check", "Check"],
  ["Say", "Say"],
  ["Banner", "Banner"],
  ["Update", "Update"],
]);

const components = new Map([
  ["Card", ["cardOpen", "cardClose", "cardSelf"]],
  ["CTA", ["ctaOpen", "ctaClose"]],
  ["CTACard", ["ctaCardOpen", "ctaCardClose", "ctaCardSelf"]],
  ["Lead", ["leadOpen", "leadClose"]],
  ["PullQuote", ["pullQuoteOpen", "pullQuoteClose"]],
  ["Stat", ["statOpen", "statClose", "statSelf"]],
  ["Steps", ["stepsOpen", "stepsClose"]],
  ["Step", ["stepOpen", "stepClose"]],
  ["Tab", ["tabOpen", "tabClose"]],
  ["Accordion", ["accordionOpen", "accordionClose"]],
  ["Expandable", ["accordionOpen", "accordionClose"]],
  ["Frame", ["frameOpen", "frameClose"]],
  ["Panel", ["panelOpen", "panelClose"]],
  ["Prompt", ["promptOpen", "promptClose"]],
  ["ParamField", ["paramOpen", "paramClose"]],
  ["Param", ["paramOpen", "paramClose"]],
  ["Field", ["paramOpen", "paramClose"]],
  ["Property", ["paramOpen", "paramClose"]],
  ["ResponseField", ["paramOpen", "paramClose"]],
  ["Tile", ["tileOpen", "tileClose", "tileSelf"]],
  ["Badge", ["badgeOpen", "badgeClose", "badgeSelf"]],
  ["Tooltip", ["tooltipOpen", "tooltipClose"]],
]);
const inlineComponents = new Set(["Badge", "Tooltip"]);
const gridComponents = new Set(["CardGroup", "Columns"]);
const componentTag = /<(\/)?([A-Z][A-Za-z0-9_.-]*)\b([^>]*)>/g;

// Track source lines through the existing rewrites; inserted snippet content has
// no location in the including file. This metadata never enters rendered tokens.
class DocsSource {
  constructor(text, firstLine) {
    this.text = text;
    if (firstLine === undefined) {
      this.origins = [];
      return;
    }
    let line = firstLine;
    this.origins = Array.from({ length: text.length }, (_, index) => {
      const origin = line;
      if (text[index] === "\n") {
        line++;
      }
      return origin;
    });
  }

  replace(pattern, replacement, mapped = true) {
    if (!this.origins.length) {
      this.text = this.text.replace(pattern, replacement);
      return this;
    }
    const origins = [];
    let end = 0;
    this.text = this.text.replace(pattern, (...args) => {
      const offset = args.at(-2);
      const value = typeof replacement === "function" ? replacement(...args) : replacement;
      for (let i = end; i < offset; i++) {
        origins.push(this.origins[i]);
      }
      for (let i = 0; i < value.length; i++) {
        origins.push(
          value === args[0] ? this.origins[offset + i] : mapped ? this.origins[offset] : undefined,
        );
      }
      end = offset + args[0].length;
      return value;
    });
    for (let i = end; i < this.origins.length; i++) {
      origins.push(this.origins[i]);
    }
    this.origins = origins;
    return this;
  }

  lines() {
    if (!this.origins.length) {
      return [];
    }
    let offset = 0;
    return this.text.split("\n").map((line) => {
      const origins = new Set(
        this.origins.slice(offset, offset + line.length).filter((origin) => origin !== undefined),
      );
      offset += line.length + 1;
      return origins.size === 1 ? origins.values().next().value : undefined;
    });
  }
}

function preprocess(input) {
  let out = input.replace(/\r\n/g, "\n").replace(/^import\s+.+?;?\s*$/gm, "");
  out = out.replace(
    /<Mermaid\b[^>]*>([\s\S]*?)<\/Mermaid>/g,
    (_, body) => `\n${marker("mermaidBlock", body)}\n`,
  );
  out = out.replace(
    /<Chart\b([^>]*)\/>/g,
    (_, attrs) => `\n${marker("chart", JSON.stringify({ attrs, body: "" }))}\n`,
  );
  out = out.replace(
    /<Chart\b([^>]*)>([\s\S]*?)<\/Chart>/g,
    (_, attrs, body) => `\n${marker("chart", JSON.stringify({ attrs, body }))}\n`,
  );
  out = out.replace(/<br\s*\/?>/gi, "\n");
  return out.replace(componentTag, (tag, closing, name, attrs) => {
    let kind;
    let value = closing ? "" : attrs;
    if (gridComponents.has(name) || knownBlocks.has(name)) {
      kind = closing ? "blockClose" : "blockOpen";
      value = gridComponents.has(name) ? cardGridClass(attrs) : knownBlocks.get(name)[0];
    } else if (callouts.has(name)) {
      kind = closing ? "calloutClose" : "calloutOpen";
      value = callouts.get(name);
    } else {
      const definition = components.get(name);
      if (!definition) {
        return escapeHtml(tag);
      }
      kind = closing
        ? definition[1]
        : attrs.endsWith("/") && definition[2]
          ? definition[2]
          : definition[0];
    }
    // Block boundaries stay separate even for adjacent components on one line.
    return inlineComponents.has(name)
      ? inlineMarker(kind, value)
      : `\n\n${marker(kind, value)}\n\n`;
  });
}

function marker(kind, payload = "") {
  return `${markerPrefix}:${kind}:${Buffer.from(payload, "utf8").toString("base64url")}`;
}

function inlineMarker(kind, payload = "") {
  return `${inlineMarkerPrefix}:${kind}:${Buffer.from(payload, "utf8").toString("base64url")}:`;
}

function cardGridClass(rawAttrs) {
  const attrs = parseAttrs(rawAttrs);
  const cols = Math.max(1, Math.min(4, Number.parseInt(attrs.cols ?? "", 10) || 2));
  return `card-grid oc-card-cols-${cols}`;
}

/** @public Consumed by openclaw/docs mdx-ish.mjs through the docs-sync support contract. */
export function parseAttrs(raw) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const match of raw.matchAll(
    /([A-Za-z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g,
  )) {
    attrs[match[1]] = codeParser.utils.unescapeAll(
      match[2] ?? match[3] ?? match[4]?.replace(/^['"]|['"]$/g, "") ?? match[5] ?? "",
    );
  }
  return attrs;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

// Inline tokens lack block maps. Capture the parser cursor before link rules
// normalize hrefs or replace reference metadata, only for diagnostic projections.
const inlineLines = new WeakMap();

/** @public Consumed by openclaw/docs mdx-ish.mjs through the docs-sync support contract. */
export function createDocsMarkdown(options = {}) {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false, ...options }).use(
    anchor,
  );
  md.inline.State = class extends md.inline.State {
    push(type, tag, nesting) {
      const token = super.push(type, tag, nesting);
      if (this.env.trackSourceLines && ["link_open", "image", "html_inline"].includes(type)) {
        inlineLines.set(token, this.src.slice(0, this.pos).split("\n").length - 1);
      }
      return token;
    }
  };
  return md;
}

const codeParser = new MarkdownIt({ html: false });

// Normalize the renderer's component indentation before CommonMark identifies code.
// Literal regions are restored only after preprocessing, so examples cannot become components.
function prepareDocument(input, { sourceFile, root, seen = new Set() }, firstLine) {
  const saved = [];
  let prefix = "OPENCLAWVERBATIM";
  while (input.includes(prefix)) {
    prefix += "X";
  }
  const placeholder = new RegExp(`${prefix}(\\d+)END`, "g");
  const restore = (text) => text.replace(placeholder, (_, index) => saved[Number(index)]);
  const hold = (value) => {
    const key = `${prefix}${saved.length}END`;
    saved.push(restore(value));
    return key;
  };
  const jsxComments = new Set();
  let text = new DocsSource(input, firstLine).replace(
    /<!--[^]*?-->|\{\/\*[^]*?\*\/\}|<(pre|code|script|style|textarea)\b[^>]*>[^]*?<\/\1\s*>/g,
    (value) => {
      if (value.startsWith("{/*")) {
        jsxComments.add(saved.length);
      }
      return hold(value);
    },
  );
  let depth = 0;
  let fence;
  // Keep split("\n") semantics: CRLF must not create extra code-line entries.
  text = text.replace(/(?<=^|\n)[^\n]*/g, (line) => {
    const normalized = depth ? line.replace(new RegExp(`^ {1,${depth * 2}}`), "") : line;
    const match = normalized.match(/^\s*(?:[-*+] |\d+[.)] )?(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        match &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length &&
        !match[2].trim()
      ) {
        fence = undefined;
      }
      return normalized;
    }
    if (match) {
      fence = match[1];
      return normalized;
    }
    for (const [, closing, name, attrs] of normalized
      .replace(/(`+)[^\n]*?\1/g, "")
      .matchAll(componentTag)) {
      if (
        inlineComponents.has(name) ||
        !(
          components.has(name) ||
          knownBlocks.has(name) ||
          callouts.has(name) ||
          gridComponents.has(name)
        )
      ) {
        continue;
      }
      if (closing) {
        depth = Math.max(0, depth - 1);
      } else if (!attrs.endsWith("/")) {
        depth++;
      }
    }
    return normalized;
  });
  const codeLines = new Set();
  for (const token of codeParser.parse(text.text, {})) {
    if ((token.type === "fence" || token.type === "code_block") && token.map) {
      for (let i = token.map[0]; i < token.map[1]; i++) {
        codeLines.add(i);
      }
    }
  }
  let sourceLine = 0;
  text = text
    .replace(/(?<=^|\n)[^\n]*/g, (line) => (codeLines.has(sourceLine++) ? hold(line) : line))
    .replace(/(`+)([^]*?)\1/g, hold);
  // Code captures have already restored their inner comment bytes. Remove only
  // standalone JSX comments, never comment syntax inside a protected literal.
  text = text.replace(placeholder, (key, index) =>
    jsxComments.has(Number(index)) ? saved[Number(index)].replace(/[^\n]/g, " ") : key,
  );
  if (sourceFile) {
    text = text.replace(
      /<Snippet\b([^>]*)\/>/g,
      (_, rawAttrs) => {
        const attrs = parseAttrs(rawAttrs);
        const ref = attrs.file ?? attrs.src;
        if (!ref) {
          return "";
        }
        const target = path.resolve(path.dirname(sourceFile), ref);
        const relative = path.relative(root, target);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          seen.has(target) ||
          !fs.existsSync(target)
        ) {
          return "";
        }
        const content = parseFrontmatter(fs.readFileSync(target, "utf8")).content;
        return `\n${prepareDocument(content, { sourceFile: target, root, seen: new Set([...seen, target]) }).text.trim()}\n`;
      },
      false,
    );
  }
  text = preprocess(text);
  return text.replace(placeholder, (_, index) => saved[Number(index)], false);
}

// mint@4.2.808/common@1.0.1096 published these suffixes before counting.
// Keep apostrophes as separators so slugify 2.2.1 cannot join them early
// and change existing heading or component links.
function mintBaseSlug(title, options) {
  return slugify(title, { ...options, customReplacements: [["'", "-"]] }).replace(
    /([a-zA-Z\d]+)-([ts])(-|$)/g,
    "$1$2$3",
  );
}
function mintSlug(title, counter = slugifyWithCounter()) {
  const encoded = anchor.defaults.slugify(title);
  const options = /%[0-9A-F]{2}/.test(encoded)
    ? { decamelize: false, preserveCharacters: ["%", "_"], lowercase: false }
    : { decamelize: false, preserveCharacters: ["_"] };
  const base = mintBaseSlug(encoded, options);
  return counter(base, options);
}
function cleanMintId(id) {
  return decodeURIComponent(id.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"))
    .replace(/[?,;:!'"()[\]{}]/g, "")
    .replace(
      /\p{Emoji_Modifier}|\p{Emoji_Modifier_Base}|\p{Emoji_Presentation}|\p{Extended_Pictographic}|\u200D|\uFE0E|\uFE0F/gu,
      "",
    );
}
function deduplicateMintId(id, seen) {
  const count = seen.get(id) ?? 0;
  seen.set(id, count + 1);
  if (!count) {
    return id;
  }
  let suffix = count + 1;
  while (seen.has(`${id}-${suffix}`)) {
    suffix++;
  }
  const result = `${id}-${suffix}`;
  seen.set(result, 1);
  return result;
}

function readHtmlTargets(chunks) {
  const ids = [];
  const links = [];
  let verbatim = 0;
  let chunk;
  let offset = 0;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (attrs.id) {
        ids.push(attrs.id);
      }
      if (["pre", "code", "script", "style", "textarea"].includes(name)) {
        verbatim++;
      }
      if (!verbatim) {
        for (const key of ["href", "src", "data-href"]) {
          if (attrs[key]) {
            const line = chunk.lineAt?.(
              chunk.html.slice(0, parser.startIndex - offset).split("\n").length - 1,
            );
            links.push({ href: attrs[key], line });
          }
        }
      }
    },
    onclosetag(name) {
      if (["pre", "code", "script", "style", "textarea"].includes(name)) {
        verbatim--;
      }
    },
  });
  for (chunk of chunks) {
    parser.write(chunk.html);
    offset += chunk.html.length;
  }
  parser.end();
  return { ids, links };
}

/** @public Consumed by openclaw/docs assets.mjs through the docs-sync support contract. */
export function resolveDocsFragment(hash, ids) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (ids.has(raw)) {
    return raw;
  }
  try {
    const decoded = decodeURIComponent(raw);
    return ids.has(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** @public Consumed by openclaw/docs mdx-ish.mjs through the docs-sync support contract. */
export function parseDocsDocument(markdown, md = createDocsMarkdown(), options = {}) {
  const env = options.mapLink ? { trackSourceLines: true } : {};
  const parsed = parseFrontmatter(markdown);
  const firstLine = options.mapLink
    ? markdown.slice(0, markdown.length - parsed.content.length).split("\n").length
    : undefined;
  const source = prepareDocument(parsed.content, options, firstLine);
  const sourceLines = source.lines();
  const tokens = md.parse(source.text, env);
  const reserved = new Set();
  const ids = [];
  const links = [];
  const collisions = [];
  const componentTargets = [];
  const candidates = [];
  const headings = slugifyWithCounter();
  const tabs = slugifyWithCounter();
  const toc = new Map();
  /** @type {Map<string, number>} */
  const componentCounts = new Map();
  const stack = [];
  const reserve = (id) => {
    if (id) {
      if (reserved.has(id)) {
        collisions.push({ id, reason: "duplicate authored/canonical ID" });
      }
      reserved.add(id);
      ids.push(id);
    }
  };
  const scanHtml = (chunks) => {
    const found = readHtmlTargets(chunks);
    found.ids.forEach(reserve);
    links.push(...found.links);
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lineAt =
      options.mapLink && token.map ? (offset) => sourceLines[token.map[0] + offset] : undefined;
    if (token.type === "heading_open") {
      const id = token.attrGet("id");
      reserve(id);
      if (
        !["custom", "frame"].includes(parsed.data.mode) &&
        Number(token.tag.slice(1)) <= 4 &&
        !/\{[^}]*\}/.test(tokens[i + 1].content)
      ) {
        let alias = mintSlug(
          tokens[i + 1].children
            .map((child) =>
              child.type === "softbreak"
                ? "\n"
                : ["text", "code_inline"].includes(child.type)
                  ? child.content
                  : "",
            )
            .join(""),
          headings,
        );
        if (
          !stack.some(({ kind }) =>
            ["accordionOpen", "accordion-group", "Update", "promptOpen"].includes(kind),
          )
        ) {
          alias = deduplicateMintId(cleanMintId(alias), toc);
        }
        candidates.push({ token, id, alias });
      }
    }
    if (token.type === "html_block") {
      const original = token.content;
      token.content = token.content.replace(
        /(<div class="maturity-category-docs">)([\s\S]*?)(<\/div>)/g,
        (_, open, body, close) => `${open}${normalizeEmbeddedMarkdownLinks(body)}${close}`,
      );
      scanHtml([{ html: token.content, lineAt: token.content === original ? lineAt : undefined }]);
    }
    if (token.type !== "inline") {
      continue;
    }
    const match = token.content.match(new RegExp(`^${markerPrefix}:([^:]+):([A-Za-z0-9_-]*)$`));
    if (
      match &&
      tokens[i - 1]?.type === "paragraph_open" &&
      tokens[i + 1]?.type === "paragraph_close"
    ) {
      const kind = match[1];
      const value = Buffer.from(match[2], "base64url").toString("utf8");
      const attrs = parseAttrs(value);
      /** @type {{ token: typeof token, kind: string, attrs: Record<string, string>, id?: string, alias?: string }} */
      const component = { token, kind, attrs, id: attrs.id, alias: undefined };
      if (kind.endsWith("Close")) {
        stack.pop();
      } else if (kind.endsWith("Open")) {
        stack.push({ kind: kind === "blockOpen" || kind === "calloutOpen" ? value : kind, attrs });
      }
      if (["accordionOpen", "stepOpen", "tabOpen", "paramOpen"].includes(kind)) {
        reserve(attrs.id);
        if (!attrs.id) {
          const title = attrs.title;
          if (kind === "tabOpen" && title) {
            component.alias = mintSlug(title, tabs);
          } else if (kind === "stepOpen" && title && !["", "true"].includes(attrs.noAnchor)) {
            const parent = stack.at(-2);
            const size =
              attrs.titleSize ??
              (parent?.kind === "stepsOpen" ? parent.attrs.titleSize : undefined);
            component.alias = ["h2", "h3"].includes(size)
              ? deduplicateMintId(mintSlug(title), toc)
              : mintSlug(title);
          } else if (kind === "accordionOpen" && title) {
            component.alias = mintBaseSlug(title.replace(":", "-"), { decamelize: false });
          } else if (kind === "paramOpen") {
            const name = attrs.query ?? attrs.path ?? attrs.body ?? attrs.header ?? attrs.name;
            if (name) {
              component.alias = mintBaseSlug(`param-${name}`, { decamelize: true });
            }
          }
        }
        componentTargets.push(component);
      }
      for (const key of ["href", "primaryHref", "secondaryHref"]) {
        if (attrs[key]) {
          links.push({ href: md.utils.unescapeAll(attrs[key]), line: lineAt?.(0) });
        }
      }
      continue;
    }
    const children = token.children ?? [];
    scanHtml(
      children.map((child, index) => ({
        html: md.renderer.rules[child.type]
          ? md.renderer.rules[child.type](children, index, md.options, env, md.renderer)
          : md.renderer.renderToken(children, index, md.options),
        lineAt:
          lineAt && inlineLines.has(child)
            ? (offset) => lineAt(inlineLines.get(child) + offset)
            : undefined,
      })),
    );
  }
  // Published headings and authored HTML/component IDs win regardless of order.
  // Aliases never steal them; ambiguous aliases are omitted and reported.
  const aliasOwners = new Map();
  for (const candidate of candidates) {
    if (candidate.alias === candidate.id || !candidate.alias) {
      continue;
    }
    const owners = aliasOwners.get(candidate.alias) ?? [];
    owners.push(candidate);
    aliasOwners.set(candidate.alias, owners);
  }
  for (const [alias, owners] of aliasOwners) {
    if (reserved.has(alias) || owners.length !== 1) {
      collisions.push({ id: alias, reason: "compatibility alias collision" });
      continue;
    }
    reserve(alias);
    const token = owners[0].token;
    token.meta = { ...token.meta, anchorAlias: alias };
  }
  for (const component of componentTargets) {
    if (!component.id && component.alias) {
      const base = component.alias;
      let count = componentCounts.get(base) ?? 0;
      let id = count ? `${base}-${count}` : base;
      while (reserved.has(id)) {
        id = `${base}-${++count}`;
      }
      componentCounts.set(base, count + 1);
      component.id = id;
      reserve(id);
    }
    if (component.id) {
      const encoded = Buffer.from(component.id).toString("base64url");
      component.token.content += `:${encoded}`;
      component.token.children[0].content = component.token.content;
    }
  }
  return {
    tokens,
    env,
    ids,
    // The publisher consumes href strings. Audits project each occurrence here,
    // before its source location is discarded, without a parallel return field.
    links: links.map(({ href, line }) => {
      const target = relativeDocsHref(href, options);
      return options.mapLink ? options.mapLink(target, line) : target;
    }),
    collisions,
  };
}

const openingDelimiter = /^---[ \t]*\r?\n/u;
const closingDelimiter = /\r?\n---[ \t]*(?:\r?\n|$)/u;

/** @public Consumed by openclaw/docs build.mjs and smoke.mjs through docs sync. */
export function parseFrontmatter(source) {
  const input = String(source).replace(/^\uFEFF/u, "");
  const opening = input.match(openingDelimiter);
  if (!opening) {
    return { data: {}, content: input };
  }

  const frontmatterStart = opening[0].length;
  const closing = closingDelimiter.exec(input.slice(frontmatterStart));
  if (!closing || closing.index === undefined) {
    return { data: {}, content: input };
  }

  const data = parse(input.slice(frontmatterStart, frontmatterStart + closing.index)) ?? {};
  const contentStart = frontmatterStart + closing.index + closing[0].length;
  return { data, content: input.slice(contentStart) };
}

function normalizeEmbeddedMarkdownLinks(body) {
  return body.replace(
    /\[([^\]]+)\]\(((?:\/|https?:\/\/)[^)\s]+)\)/g,
    (_, label, href) => `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`,
  );
}

function relativeDocsHref(href, { pageRoute } = {}) {
  if (!pageRoute || /^(?:[#/?]|[a-z][a-z0-9+.-]*:)/i.test(href)) {
    return href;
  }
  const url = new URL(href, `https://docs.openclaw.ai${pageRoute}`);
  if (/\.[^/]+$/.test(url.pathname) && !/\.mdx?$/.test(url.pathname)) {
    return href;
  }
  const target = url.pathname.replace(/\.mdx?$/, "").replace(/\/index$/, "") || "/";
  return `${target}${url.search}${url.hash}`;
}

/** @public Consumed by openclaw/docs mdx-ish.mjs through docs sync. */
export function rewriteDocsRelativeLinks(html, options) {
  return html.replace(/<(?:a|span)\b[^>]*>/g, (tag) =>
    tag.replace(/\b(href|data-href)=(['"])(.*?)\2/g, (_, attr, quote, href) => {
      const target = relativeDocsHref(codeParser.utils.unescapeAll(href), options);
      return `${attr}=${quote}${escapeAttr(target)}${quote}`;
    }),
  );
}
