const HOST_LOCAL_FILE_HREF_RE =
  /^(?:~\/|\/(?:Users|home|tmp|private\/tmp|var\/folders|private\/var\/folders)\/|\/[A-Za-z]:\/|[A-Za-z]:[\\/])/;
const FILE_SEGMENT_SOURCE = "[A-Za-z0-9_.@#+-]+";
const FILE_EXTENSION_SOURCE = "[A-Za-z0-9]{1,8}";
const FILE_LINE_SUFFIX_SOURCE = ":\\d{1,6}(?::\\d{1,6})?";
const FILE_NAME_SOURCE = `${FILE_SEGMENT_SOURCE}\\.${FILE_EXTENSION_SOURCE}`;
const PREFIXED_FILE_SOURCE = `(?:~\\/|\\.\\.\\/|\\.\\/|\\/)(?:${FILE_SEGMENT_SOURCE}\\/)*${FILE_NAME_SOURCE}`;
const UNPREFIXED_FILE_SOURCE = `${FILE_SEGMENT_SOURCE}(?:\\/${FILE_SEGMENT_SOURCE})*\\/${FILE_NAME_SOURCE}`;
const WINDOWS_ABSOLUTE_FILE_SOURCE = `[A-Za-z]:[\\\\/](?:${FILE_SEGMENT_SOURCE}[\\\\/])*${FILE_NAME_SOURCE}`;
const MULTI_SEGMENT_FILE_SOURCE = `(?:${PREFIXED_FILE_SOURCE}|${WINDOWS_ABSOLUTE_FILE_SOURCE}|${UNPREFIXED_FILE_SOURCE})(?:${FILE_LINE_SUFFIX_SOURCE})?`;
const BARE_FILE_WITH_LINE_SOURCE = `${FILE_SEGMENT_SOURCE}\\.${FILE_EXTENSION_SOURCE}${FILE_LINE_SUFFIX_SOURCE}`;
const MULTI_SEGMENT_FILE_RE = new RegExp(`^${MULTI_SEGMENT_FILE_SOURCE}$`);
const BARE_FILE_WITH_LINE_RE = new RegExp(`^${BARE_FILE_WITH_LINE_SOURCE}$`);
const BARE_FILENAME_RE = new RegExp(`^${FILE_SEGMENT_SOURCE}\\.(${FILE_EXTENSION_SOURCE})$`, "i");
export const MARKDOWN_FILE_LINK_SCAN_RE = new RegExp(
  `${MULTI_SEGMENT_FILE_SOURCE}|${BARE_FILE_WITH_LINE_SOURCE}`,
  "g",
);
const FILE_LINE_SUFFIX_RE = /:(\d{1,6})(?::\d{1,6})?$/;
const BARE_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cfg",
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "diff",
  "fish",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "log",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "patch",
  "plist",
  "proto",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

export function markdownFileLinkFromEvent(
  event: Event,
): { path: string; line: number | null } | null {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const link = target.closest<HTMLAnchorElement>("a[data-file-path]");
  const path = link?.dataset.filePath;
  if (!path) {
    return null;
  }
  const line = link.dataset.fileLine;
  return { path, line: line ? Number.parseInt(line, 10) : null };
}

export function splitMarkdownFileLineSuffix(raw: string): { path: string; line: number | null } {
  const match = FILE_LINE_SUFFIX_RE.exec(raw);
  const line = match?.[1];
  return match && line
    ? { path: raw.slice(0, match.index), line: Number.parseInt(line, 10) }
    : { path: raw, line: null };
}

function isAllowlistedBareFilename(raw: string): boolean {
  if (raw.includes("/") || raw.includes("\\")) {
    return false;
  }
  const match = BARE_FILENAME_RE.exec(raw);
  return Boolean(match?.[1] && BARE_FILE_EXTENSIONS.has(match[1].toLowerCase()));
}

export function parseMarkdownFileLinkTarget(
  raw: string,
): { path: string; line: number | null } | null {
  const target = raw.trim();
  if (
    !MULTI_SEGMENT_FILE_RE.test(target) &&
    !BARE_FILE_WITH_LINE_RE.test(target) &&
    !isAllowlistedBareFilename(target)
  ) {
    return null;
  }
  return splitMarkdownFileLineSuffix(target);
}

export function isHostLocalMarkdownFileHref(href: string): boolean {
  return HOST_LOCAL_FILE_HREF_RE.test(href.trim());
}
