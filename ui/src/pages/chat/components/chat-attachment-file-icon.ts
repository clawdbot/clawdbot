import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { inferControlUiPublicAssetPath } from "../../../app/public-assets.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";

type AttachmentFileIconFamily =
  | "unknown"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "text"
  | "markdown"
  | "code"
  | "javascript"
  | "json"
  | "python"
  | "svg"
  | "yaml";

export type AttachmentFileVisualMode = "preview-with-favicon" | "large-placeholder";

type CompactFileIcon =
  | "css"
  | "csv"
  | "docx"
  | "gif"
  | "html"
  | "jpg"
  | "js"
  | "json"
  | "md"
  | "mp3"
  | "mp4"
  | "pdf"
  | "png"
  | "py"
  | "rtf"
  | "svg"
  | "txt"
  | "wav"
  | "xlsx"
  | "xml"
  | "yaml"
  | "zip";

type FileIconFamilyDefinition = {
  family: AttachmentFileIconFamily;
  accent: string;
  accentByExtension?: Readonly<Record<string, string>>;
  accentByMimeType?: Readonly<Record<string, string>>;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  compact?: CompactFileIcon;
  compactByExtension?: Readonly<Record<string, CompactFileIcon>>;
};

const FILE_ICON_FAMILIES: readonly FileIconFamilyDefinition[] = [
  {
    family: "unknown",
    accent: "#929292",
    extensions: [],
    mimeTypes: ["application/octet-stream"],
  },
  {
    family: "pdf",
    accent: "#E94B64",
    extensions: ["pdf"],
    mimeTypes: ["application/pdf"],
    compact: "pdf",
  },
  {
    family: "document",
    accent: "#5B7FD6",
    extensions: ["doc", "docx", "rtf", "odt", "pages"],
    mimeTypes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/rtf",
      "text/rtf",
      "application/vnd.oasis.opendocument.text",
    ],
    compact: "docx",
    compactByExtension: { rtf: "rtf" },
  },
  {
    family: "spreadsheet",
    accent: "#3FA66B",
    extensions: ["csv", "xls", "xlsx", "ods", "numbers"],
    mimeTypes: [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.spreadsheet",
    ],
    compact: "xlsx",
    compactByExtension: { csv: "csv" },
  },
  {
    family: "image",
    accent: "#3FA66B",
    extensions: ["gif", "jpg", "jpeg", "png", "webp", "avif", "heic"],
    mimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp", "image/avif", "image/heic"],
    compact: "png",
    compactByExtension: { gif: "gif", jpg: "jpg", jpeg: "jpg" },
  },
  {
    family: "video",
    accent: "#E94B64",
    extensions: ["mp4", "mov", "m4v", "webm", "mkv"],
    mimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"],
    compact: "mp4",
  },
  {
    family: "audio",
    accent: "#E86672",
    extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"],
    mimeTypes: [
      "audio/mpeg",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/flac",
      "audio/ogg",
    ],
    compact: "wav",
    compactByExtension: { mp3: "mp3" },
  },
  {
    family: "archive",
    accent: "#8B7CF6",
    extensions: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2"],
    mimeTypes: [
      "application/zip",
      "application/x-rar-compressed",
      "application/x-7z-compressed",
      "application/x-tar",
      "application/gzip",
    ],
    compact: "zip",
  },
  {
    family: "text",
    accent: "#5B7FD6",
    extensions: ["txt", "log"],
    mimeTypes: ["text/plain"],
    compact: "txt",
  },
  {
    family: "markdown",
    accent: "#5B7FD6",
    extensions: ["md", "mdx", "markdown"],
    mimeTypes: ["text/markdown", "text/x-markdown"],
    compact: "md",
  },
  {
    family: "code",
    accent: "#E76F3C",
    accentByExtension: { css: "#8B7CF6" },
    accentByMimeType: { "text/css": "#8B7CF6" },
    extensions: ["css", "html", "htm", "xml", "jsx", "tsx", "ts", "sh", "bash", "zsh"],
    mimeTypes: [
      "text/css",
      "text/html",
      "application/xml",
      "text/xml",
      "application/typescript",
      "text/x-shellscript",
    ],
    compact: "html",
    compactByExtension: { css: "css", xml: "xml" },
  },
  {
    family: "javascript",
    accent: "#F2A93B",
    extensions: ["js", "cjs", "mjs"],
    mimeTypes: ["text/javascript", "application/javascript"],
    compact: "js",
  },
  {
    family: "json",
    accent: "#F2A93B",
    extensions: ["json", "jsonl", "geojson"],
    mimeTypes: [
      "application/json",
      "application/ld+json",
      "application/x-ndjson",
      "application/geo+json",
    ],
    compact: "json",
  },
  {
    family: "python",
    accent: "#F2A93B",
    extensions: ["py", "pyw", "pyi"],
    mimeTypes: ["text/x-python", "application/x-python-code"],
    compact: "py",
  },
  {
    family: "svg",
    accent: "#E76F3C",
    extensions: ["svg", "svgz"],
    mimeTypes: ["image/svg+xml"],
    compact: "svg",
  },
  {
    family: "yaml",
    accent: "#E86672",
    extensions: ["yaml", "yml"],
    mimeTypes: ["application/yaml", "text/yaml", "application/x-yaml", "text/x-yaml"],
    compact: "yaml",
  },
] as const;

const UNKNOWN_FILE_ICON = FILE_ICON_FAMILIES[0]!;

type ResolvedAttachmentFileIcon = {
  family: AttachmentFileIconFamily;
  accent: string;
  extension?: string;
  extensionLabel: string;
  compact?: CompactFileIcon;
};

export function resolveAttachmentFileIcon(
  filename: string,
  mimeType?: string,
): ResolvedAttachmentFileIcon {
  const extension = getMediaFileExtension(filename);
  const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const definition =
    (extension
      ? FILE_ICON_FAMILIES.find((candidate) => candidate.extensions.includes(extension))
      : undefined) ??
    (normalizedMimeType
      ? FILE_ICON_FAMILIES.find((candidate) => candidate.mimeTypes.includes(normalizedMimeType))
      : undefined) ??
    UNKNOWN_FILE_ICON;
  const compact = extension
    ? (definition.compactByExtension?.[extension] ?? definition.compact)
    : definition.compact;
  const accent =
    (extension ? definition.accentByExtension?.[extension] : undefined) ??
    (normalizedMimeType ? definition.accentByMimeType?.[normalizedMimeType] : undefined) ??
    definition.accent;
  return {
    family: definition.family,
    accent,
    extension,
    extensionLabel:
      extension?.toUpperCase() ??
      (definition.family === "unknown" ? "FILE" : definition.family.toUpperCase()),
    compact,
  };
}

function fileIconAssetPath(path: string): string {
  return inferControlUiPublicAssetPath(`file-icons/${path}.svg`);
}

export function renderAttachmentFileIcon(options: {
  filename: string;
  mimeType?: string;
  mode: AttachmentFileVisualMode;
  unavailable?: boolean;
}) {
  const resolved = resolveAttachmentFileIcon(options.filename, options.mimeType);
  const compactLight = resolved.compact
    ? fileIconAssetPath(`compact/light/${resolved.compact}`)
    : fileIconAssetPath("compact/unknown-light");
  const compactDark = resolved.compact
    ? fileIconAssetPath(`compact/dark/${resolved.compact}`)
    : fileIconAssetPath("compact/unknown-dark");
  return html`<span
    class="chat-attachment-file-icon ${options.unavailable
      ? "chat-attachment-file-icon--unavailable"
      : ""}"
    data-mode=${options.mode}
    aria-hidden="true"
    style=${styleMap({
      "--chat-file-icon-shell-light": `url("${fileIconAssetPath("large/shell-light")}")`,
      "--chat-file-icon-shell-dark": `url("${fileIconAssetPath("large/shell-dark")}")`,
      "--chat-file-icon-overlay": `url("${fileIconAssetPath(`overlays/${resolved.family}`)}")`,
      "--chat-file-icon-accent": resolved.accent,
      "--chat-file-icon-compact-light": `url("${compactLight}")`,
      "--chat-file-icon-compact-dark": `url("${compactDark}")`,
    })}
  >
    <span class="chat-attachment-file-icon__large">
      <span class="chat-attachment-file-icon__overlay"></span>
    </span>
    <span class="chat-attachment-file-icon__compact"></span>
  </span>`;
}
