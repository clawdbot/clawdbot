const HOST_LOCAL_FILE_HREF_RE =
  /^(?:~\/|\/(?:Users|home|tmp|private\/tmp|var\/folders|private\/var\/folders)\/|\/[A-Za-z]:\/|[A-Za-z]:[\\/])/;
const FILE_SEGMENT_SOURCE = "[A-Za-z0-9_.@#+-]+";
// Scanned prose and code spans require a letter-led extension so version numbers ("1.1/1.2") are not
// files; explicitly authored Markdown links keep digit-led extensions. ":a-b" ranges target line a.
const SCANNED_EXTENSION_SOURCE = "[A-Za-z][A-Za-z0-9]{0,7}";
const AUTHORED_EXTENSION_SOURCE = "[A-Za-z0-9]{1,8}";
const FILE_LINE_SUFFIX_SOURCE = ":\\d{1,6}(?:[-:]\\d{1,6})?";
function fileGrammar(extension: string) {
  const name = `${FILE_SEGMENT_SOURCE}\\.${extension}`;
  const prefixed = `(?:~\\/|\\.\\.\\/|\\.\\/|\\/)(?:${FILE_SEGMENT_SOURCE}\\/)*${name}`;
  const unprefixed = `${FILE_SEGMENT_SOURCE}(?:\\/${FILE_SEGMENT_SOURCE})*\\/${name}`;
  const windowsAbsolute = `[A-Za-z]:[\\\\/](?:${FILE_SEGMENT_SOURCE}[\\\\/])*${name}`;
  // A reference may not stop early inside a longer token ("logs/app.log.1" must not link "logs/app.log").
  const end = "(?!\\.?[A-Za-z0-9_])";
  const multiSegment = `(?:${prefixed}|${windowsAbsolute}|${unprefixed})(?:${FILE_LINE_SUFFIX_SOURCE})?${end}`;
  const bareWithLine = `${name}${FILE_LINE_SUFFIX_SOURCE}${end}`;
  return {
    scan: new RegExp(`${multiSegment}|${bareWithLine}`, "g"),
    exact: new RegExp(`^(?:${multiSegment}|${bareWithLine})$`),
  };
}
const SCANNED_FILE = fileGrammar(SCANNED_EXTENSION_SOURCE);
const AUTHORED_FILE = fileGrammar(AUTHORED_EXTENSION_SOURCE);
const BARE_FILENAME_RE = new RegExp(
  `^${FILE_SEGMENT_SOURCE}\\.(${SCANNED_EXTENSION_SOURCE})$`,
  "i",
);
export const MARKDOWN_FILE_LINK_SCAN_RE = SCANNED_FILE.scan;
const FILE_LINE_SUFFIX_RE = /:(\d{1,6})(?:[-:]\d{1,6})?$/;
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

export function markdownFileLinkFromKeyboardEvent(
  event: KeyboardEvent,
): { path: string; line: number | null } | null {
  if (event.key !== "Enter" && event.key !== " ") {
    return null;
  }
  const target = markdownFileLinkFromEvent(event);
  if (target) {
    event.preventDefault();
  }
  return target;
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
  options?: { authored?: boolean },
): { path: string; line: number | null } | null {
  const target = raw.trim();
  const grammar = options?.authored ? AUTHORED_FILE : SCANNED_FILE;
  if (!grammar.exact.test(target) && !isAllowlistedBareFilename(target)) {
    return null;
  }
  return splitMarkdownFileLineSuffix(target);
}

export function isHostLocalMarkdownFileHref(href: string): boolean {
  return HOST_LOCAL_FILE_HREF_RE.test(href.trim());
}
