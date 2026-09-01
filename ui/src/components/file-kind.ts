// Control UI module implements file kind classification.

// Canonical extension/name -> presentation kind mapping for workspace files.
// Both file-facing surfaces resolve their glyph through this one map: the file
// preview modal picks a Lit icon, chat markdown picks a CSS mask (see
// styles/chat/text.css). Adding a kind here is the only place a new file glyph
// starts, so the two surfaces cannot drift apart.
export type FileKind =
  | "markdown"
  | "component"
  | "package"
  | "data"
  | "shell"
  | "image"
  | "code"
  | "file";

// Well-known filenames outrank their extension: package.json is a manifest
// first and JSON second, and lockfiles carry no useful extension at all.
const FILE_KIND_BY_NAME: Record<string, FileKind> = {
  "bun.lock": "package",
  "package-lock.json": "package",
  "package.json": "package",
  "pnpm-lock.yaml": "package",
  "yarn.lock": "package",
};

const FILE_KIND_BY_EXTENSION: Record<string, FileKind> = {
  astro: "component",
  avif: "image",
  bash: "shell",
  c: "code",
  cc: "code",
  cfg: "data",
  cjs: "code",
  conf: "data",
  cpp: "code",
  cs: "code",
  css: "code",
  cts: "code",
  fish: "shell",
  gif: "image",
  go: "code",
  h: "code",
  hpp: "code",
  htm: "code",
  html: "code",
  ico: "image",
  ini: "data",
  java: "code",
  jpeg: "image",
  jpg: "image",
  js: "code",
  json: "data",
  jsonc: "data",
  jsx: "component",
  kt: "code",
  kts: "code",
  less: "code",
  lock: "data",
  markdown: "markdown",
  md: "markdown",
  mdx: "markdown",
  mjs: "code",
  mts: "code",
  php: "code",
  plist: "data",
  png: "image",
  proto: "data",
  py: "code",
  rb: "code",
  rs: "code",
  scss: "code",
  sh: "shell",
  sql: "code",
  svelte: "component",
  svg: "image",
  swift: "code",
  toml: "data",
  ts: "code",
  tsx: "component",
  vue: "component",
  webp: "image",
  xml: "data",
  yaml: "data",
  yml: "data",
  zsh: "shell",
};

// Windows paths reach chat verbatim, so both separators split segments.
const PATH_SEPARATOR_RE = /[\\/]/;

function fileBaseName(path: string): string {
  const segments = path.split(PATH_SEPARATOR_RE);
  return segments[segments.length - 1] ?? path;
}

export function fileKindForPath(path: string): FileKind {
  const name = fileBaseName(path).toLowerCase();
  const named = FILE_KIND_BY_NAME[name];
  if (named) {
    return named;
  }
  // Index 0 means a dotfile (".gitignore"), which has a leading dot rather than
  // an extension; it falls through to the generic document kind.
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return FILE_KIND_BY_EXTENSION[extension] ?? "file";
}

type SuffixTrieNode = {
  pathCount: number;
  children: Map<string, SuffixTrieNode>;
};

// One reversed-segment trie indexes every path's suffixes together, so the
// per-path depth search below never rescans the other paths: it descends one
// child lookup per depth instead of comparing against every other path at
// every depth. Model-controlled Markdown can carry thousands of distinct
// paths, so this keeps label derivation near-linear in total path length
// rather than quadratic in path count.
function insertReversedSegments(root: SuffixTrieNode, segments: readonly string[]): void {
  let node = root;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    let child = node.children.get(segment);
    if (!child) {
      child = { pathCount: 0, children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
    node.pathCount += 1;
  }
}

function shortestUniqueSuffixDepth(root: SuffixTrieNode, segments: readonly string[]): number {
  let node = root;
  for (let depth = 1; depth <= segments.length; depth++) {
    node = node.children.get(segments[segments.length - depth]!) ?? node;
    if (node.pathCount === 1 || depth === segments.length) {
      return depth;
    }
  }
  return segments.length;
}

/**
 * Shortest unambiguous label per path: the basename alone when it is unique
 * among the supplied paths, otherwise the smallest trailing run of segments
 * that no other path shares. Callers pass every path rendered together so two
 * `Button.tsx` links from different directories stay distinguishable.
 */
export function shortestFileLabels(paths: readonly string[]): Map<string, string> {
  const unique = [...new Set(paths)];
  const segmentsByPath = new Map(
    unique.map((path) => [path, path.split(PATH_SEPARATOR_RE).filter(Boolean)]),
  );
  const suffixTrie: SuffixTrieNode = { pathCount: 0, children: new Map() };
  for (const segments of segmentsByPath.values()) {
    insertReversedSegments(suffixTrie, segments);
  }
  const labels = new Map<string, string>();
  for (const path of unique) {
    const segments = segmentsByPath.get(path) ?? [];
    const depth = shortestUniqueSuffixDepth(suffixTrie, segments);
    // Render the suffix with the separator the path itself used so a Windows
    // path never reads as a POSIX one.
    labels.set(path, segments.slice(-depth).join(path.includes("\\") ? "\\" : "/"));
  }
  return labels;
}
