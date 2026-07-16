import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { expandTilde } from "./platform.js";

// Canonical media tags. `qqmedia` is the generic auto-routing tag.
const VALID_TAGS = ["qqimg", "qqvoice", "qqvideo", "qqfile", "qqmedia"] as const;

// Lowercased aliases that should normalize to the canonical tag set.
const TAG_ALIASES: Record<string, (typeof VALID_TAGS)[number]> = {
  qq_img: "qqimg",
  qqimage: "qqimg",
  qq_image: "qqimg",
  qqpic: "qqimg",
  qq_pic: "qqimg",
  qqpicture: "qqimg",
  qq_picture: "qqimg",
  qqphoto: "qqimg",
  qq_photo: "qqimg",
  img: "qqimg",
  image: "qqimg",
  pic: "qqimg",
  picture: "qqimg",
  photo: "qqimg",
  qq_voice: "qqvoice",
  qqaudio: "qqvoice",
  qq_audio: "qqvoice",
  voice: "qqvoice",
  audio: "qqvoice",
  qq_video: "qqvideo",
  video: "qqvideo",
  qq_file: "qqfile",
  qqdoc: "qqfile",
  qq_doc: "qqfile",
  file: "qqfile",
  doc: "qqfile",
  document: "qqfile",
  qq_media: "qqmedia",
  media: "qqmedia",
  attachment: "qqmedia",
  attach: "qqmedia",
  qqattachment: "qqmedia",
  qq_attachment: "qqmedia",
  qqsend: "qqmedia",
  qq_send: "qqmedia",
  send: "qqmedia",
};

const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)];
ALL_TAG_NAMES.sort((a, b) => b.length - a.length);

const TAG_NAME_PATTERN = ALL_TAG_NAMES.join("|");

const LEFT_BRACKET = "(?:[<＜<]|&lt;)";
const RIGHT_BRACKET = "(?:[>＞>]|&gt;)";
/** Match self-closing media-tag syntax with file/src/path/url attributes. */
export const SELF_CLOSING_TAG_REGEX = new RegExp(
  "`?" +
    LEFT_BRACKET +
    "\\s*(" +
    TAG_NAME_PATTERN +
    ")" +
    "(?:\\s+(?!file|src|path|url)[a-z_-]+\\s*=\\s*[\"']?[^\"'\\s＜<>＞>]*?[\"']?)*" +
    "\\s+(?:file|src|path|url)\\s*=\\s*" +
    "[\"']?" +
    "([^\"'\\s>＞]+?)" +
    "[\"']?" +
    "(?:\\s+[a-z_-]+\\s*=\\s*[\"']?[^\"'\\s＜<>＞>]*?[\"']?)*" +
    "\\s*/?" +
    "\\s*" +
    RIGHT_BRACKET +
    "`?",
  "gi",
);

/** Match malformed wrapped media tags that should be normalized. */
export const FUZZY_MEDIA_TAG_REGEX = new RegExp(
  "`?" +
    LEFT_BRACKET +
    "\\s*(" +
    TAG_NAME_PATTERN +
    ")\\s*" +
    RIGHT_BRACKET +
    "[\"']?\\s*" +
    "([^<＜<＞>\"'`]+?)" +
    "\\s*[\"']?" +
    LEFT_BRACKET +
    "\\s*/?\\s*(?:" +
    TAG_NAME_PATTERN +
    ")\\s*" +
    RIGHT_BRACKET +
    "`?",
  "gi",
);

/** Normalize a raw tag name into the canonical tag set. */
function resolveTagName(raw: string): (typeof VALID_TAGS)[number] {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if ((VALID_TAGS as readonly string[]).includes(lower)) {
    return lower as (typeof VALID_TAGS)[number];
  }
  return TAG_ALIASES[lower] ?? "qqimg";
}

/** Match wrapped tags whose bodies need newline and tab cleanup. */
const MULTILINE_TAG_CLEANUP = new RegExp(
  "(" +
    LEFT_BRACKET +
    "\\s*(?:" +
    TAG_NAME_PATTERN +
    ")\\s*" +
    RIGHT_BRACKET +
    ")" +
    "([\\s\\S]*?)" +
    "(" +
    LEFT_BRACKET +
    "\\s*/?\\s*(?:" +
    TAG_NAME_PATTERN +
    ")\\s*" +
    RIGHT_BRACKET +
    ")",
  "gi",
);

/** Normalize malformed media-tag output into canonical wrapped tags. */
export function normalizeMediaTags(text: string): string {
  let cleaned = text.replace(SELF_CLOSING_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) {
      return _match;
    }
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });

  cleaned = cleaned.replace(
    MULTILINE_TAG_CLEANUP,
    (_m, open: string, body: string, close: string) => {
      const flat = body.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
      return open + flat + close;
    },
  );

  return cleaned.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) {
      return _match;
    }
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });
}
