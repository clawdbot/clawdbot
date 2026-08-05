import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pMap from "p-map";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { translateNativeEntries } from "./control-ui-i18n.ts";
import {
  loadControlUiSharedCatalog,
  type ControlUiSharedCatalog,
} from "./lib/control-ui-i18n-shared-catalog.ts";
import { NATIVE_I18N_LOCALES } from "./native-i18n-locales.ts";

type NativeI18nSurface = "android" | "apple" | "linux";
type ScannedNativeI18nSurface = Exclude<NativeI18nSurface, "linux">;

export { NATIVE_I18N_LOCALES };

export type NativeI18nEntry = {
  description?: string;
  id: string;
  kind: string;
  path: string;
  semanticKey?: string;
  source: string;
  surface: NativeI18nSurface;
};

type Candidate = Omit<NativeI18nEntry, "id"> & {
  line: number;
};
type NativeTranslationArtifact = {
  entries: Array<{ id: string; source: string; translated: string }>;
  glossaryHash: string;
  locale: string;
  version: 1;
};
export type NativeI18nQualityFinding = {
  code:
    | "adjacent-duplicate-word"
    | "android-language-picker-source-equal"
    | "same-source-contradiction"
    | "source-equal";
  id: string;
  locale: string;
  relatedIds?: string[];
  source: string;
  translated: string;
  words?: string[];
};
type NativeTranslator = typeof translateNativeEntries;
type NativeLocaleSyncOptions = {
  glossary?: Array<{ source: string; target: string }>;
  sharedCatalog?: ControlUiSharedCatalog;
  translate?: NativeTranslator;
  translationsDir?: string;
};
type NativeI18nCommand = {
  command: "baseline" | "check" | "sync" | "verify";
  locale?: string;
  write: boolean;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUTPUT_PATH = path.join(ROOT, "apps", ".i18n", "native-source.json");
const TRANSLATIONS_DIR = path.join(ROOT, "apps", ".i18n", "native");
const LINUX_MESSAGES_PATH = "apps/linux/ui/messages.json";
const SOURCE_ROOTS: Record<ScannedNativeI18nSurface, string[]> = {
  android: [
    path.join(ROOT, "apps", "android", "app", "src", "main"),
    path.join(ROOT, "apps", "android", "app", "src", "play"),
    path.join(ROOT, "apps", "android", "app", "src", "thirdParty"),
    path.join(ROOT, "apps", "android", "wear", "src", "main", "res", "values"),
  ],
  apple: [
    path.join(ROOT, "apps", "ios"),
    path.join(ROOT, "apps", "macos", "Sources"),
    path.join(ROOT, "apps", "shared", "OpenClawKit", "Sources"),
  ],
};

const ANDROID_EXTENSIONS = new Set([".kt", ".kts"]);
const APPLE_EXTENSIONS = new Set([".swift", ".plist"]);
const NATIVE_FORMAT_RE = /%(?:%|(?:\d+\$)?[@a-z])/giu;
const NATIVE_SOURCE_READ_CONCURRENCY = 32;
const SHARED_CATALOG_BY_LOCALE = new Map<string, Promise<ControlUiSharedCatalog>>();
// Sharing is an authored semantic decision: identical English alone does not establish meaning.
const REVIEWED_SHARED_NATIVE_MESSAGES = new Map<string, string>([
  ["Active", "common.active"],
  ["Back", "common.back"],
  ["Cancel", "common.cancel"],
  ["Close", "common.close"],
  ["Confirm", "common.confirm"],
  ["Connect", "common.connect"],
  ["Connected", "common.connected"],
  ["Continue", "common.continue"],
  ["Create", "common.create"],
  ["Delete", "common.delete"],
  ["Disabled", "common.disabled"],
  ["Dismiss", "common.dismiss"],
  ["Enabled", "common.enabled"],
  ["just now", "common.justNow"],
  ["Loading", "usage.loading.badge"],
  ["Loading…", "common.loading"],
  ["Next", "common.next"],
  ["Offline", "common.offline"],
  ["Online", "common.online"],
  ["Previous", "common.previous"],
  ["Refresh", "common.refresh"],
  ["Remove", "common.remove"],
  ["Retry", "common.retry"],
  ["Save", "common.save"],
  ["Saving…", "common.saving"],
]);
const APPLE_UI_MULTILINE_CALLS =
  /(?:Text|Label|Button|TextField|SecureField|Picker|Section|LabeledContent|Toggle|Menu|ShareLink|Link|TextEditor|ProgressView|Gauge|DisclosureGroup|ControlGroup|DatePicker|Stepper)\s*\(\s*"""([\s\S]*?)"""/gu;
const APPLE_LOCALIZED_STRING_CALLS =
  /(?:\bString\s*\(\s*localized:|\bAttributedString\s*\(\s*localized:|\bLocalizedString(?:Key|Resource)\s*\(|(?:\b[A-Za-z_]\w*)?\.localized(?:Format)?\s*\()\s*"((?:\\.|[^"\\])*)"/gu;
const APPLE_LOCALIZED_STRING_MULTILINE_CALLS =
  /\b(?:String\s*\(\s*localized:|AttributedString\s*\(\s*localized:|LocalizedString(?:Key|Resource)\s*\()\s*"""([\s\S]*?)"""/gu;
const APPLE_CALL_START = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*/gu;
const APPLE_MODIFIER_CALLS =
  /\.(?:navigationTitle|accessibilityLabel|accessibilityHint|help|alert|confirmationDialog)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const APPLE_MODIFIER_MULTILINE_CALLS =
  /\.(?:navigationTitle|accessibilityLabel|accessibilityHint|help|alert|confirmationDialog)\s*\(\s*"""([\s\S]*?)"""/gu;
const ANDROID_CALLS =
  /\b(?:Text|OutlinedTextField|BasicTextField|Button|IconButton|TopAppBar|Snackbar|AlertDialog)\s*\(\s*(?:text\s*=\s*)?"((?:\\.|[^"\\])*)"/gu;
const ANDROID_NAMED_LITERALS = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_TOAST_ARGS =
  /\b(?:Toast\.makeText|Snackbar\.make)\s*\([^,\n]*,\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_CHOOSER_ARGS = /\bIntent\.createChooser\s*\([^,\n]*,\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_DIALOG_CALLS =
  /\.(?:setTitle|setMessage|setPositiveButton|setNegativeButton|setNeutralButton)\s*\(\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_UI_STATE_TEXT =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:Status|Message|Error|Title|Label)Text\b[^=\n]*=\s*(?:MutableStateFlow|StateFlow|flowOf|runtimeState)\s*\([^"\n]*"((?:\\.|[^"\\])*)"/giu;
const ANDROID_COMPOSABLE_FUNCTION =
  /@Composable[\s\S]{0,240}?\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu;
const ANDROID_BUILTIN_UI_CALLS = new Set([
  "AlertDialog",
  "BasicTextField",
  "Box",
  "Button",
  "Card",
  "Checkbox",
  "Column",
  "combinedClickable",
  "DropdownMenuItem",
  "Icon",
  "IconButton",
  "Label",
  "LazyColumn",
  "LazyRow",
  "nativeString",
  "nativeStringResource",
  "nativeText",
  "OutlinedButton",
  "OutlinedTextField",
  "RadioButton",
  "Row",
  "Scaffold",
  "Snackbar",
  "Surface",
  "Switch",
  "Text",
  "TextButton",
  "TopAppBar",
]);
const UI_STRING_NAME_RE =
  /(?:title|subtitle|body|message|label|text|description|detail|prompt|placeholder|help)$/iu;
const APPLE_STRING_PROPERTY = /\bvar\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*String\s*\{/gu;
const APPLE_SWITCH_BRANCH_START = /(?:\bcase\b[^:\n]+|\bdefault)\s*:\s*(?:return\s+)?/gu;
const ANDROID_STRING_FUNCTION =
  /\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*:\s*String\s*(=|\{)/gu;
const ANDROID_WHEN_BRANCH_START = /(?:[^\n{}]+|\belse)\s*->\s*/gu;
const ANDROID_RESOURCE_STRINGS = /<string\b([^>]*)>([\s\S]*?)<\/string>/gu;
const ANDROID_RESOURCE_NAME = /\bname\s*=\s*"([^"]+)"/u;
const ANDROID_RESOURCE_COLLECTIONS =
  /<(?:string-array|plurals)\b([^>]*)>([\s\S]*?)<\/(?:string-array|plurals)>/gu;
const ANDROID_RESOURCE_ITEMS = /<item\b[^>]*>([\s\S]*?)<\/item>/gu;
const APPLE_NAMED_LITERALS =
  /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:"""([\s\S]*?)"""|"((?:\\.|[^"\\])*)")/gu;
const APPLE_VIEW_TYPE = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)[^:{\n]*:\s*[^{\n]*\bView\b/gu;
const APPLE_VIEW_FUNCTION =
  /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^{}]*?\)\s*(?:async\s*)?(?:throws\s*)?->\s*some\s+View\b/gu;
const APPLE_ALERT_FUNCTION = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{[^{}]{0,600}\bNSAlert\s*\(/gu;
const APPLE_BUILTIN_UI_CALLS = new Set([
  "Alert",
  "Button",
  "ControlGroup",
  "DatePicker",
  "DisclosureGroup",
  "Gauge",
  "Label",
  "LabeledContent",
  "Link",
  "Menu",
  "Picker",
  "ProgressView",
  "Section",
  "SecureField",
  "ShareLink",
  "Stepper",
  "Text",
  "TextEditor",
  "TextField",
  "Toggle",
  "searchable",
]);
const APPLE_PLIST_KEYED_STRINGS = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/gu;
// macOS uses this legacy privacy key instead of the *UsageDescription suffix.
const APPLE_LOCALIZABLE_DESCRIPTION_KEYS = new Set(["NSScreenCaptureDescription"]);
const GENERATED_PATH_RE = /(?:^|[\\/])(?:build|\.gradle|\.build|DerivedData)(?:$|[\\/])/u;
const EXCLUDED_PATH_RE = /(?:^|[\\/])(?:Tests?|UITests?|test|Preview(?:s)?)(?:$|[\\/])/u;
const EXCLUDED_FILE_RE = /(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u;
const GENERATED_FILE_RE = /(?:^|[\\/])NativeStringResources\.kt$/u;
// These files emit mobile.ui protocol evidence, not UI copy. Keep their text verbatim so
// developer-screen diagnostics match the agent-facing action results and snapshot refs.
const ANDROID_NATIVE_I18N_EXCLUDED_FILES = new Set([
  path.join(
    ROOT,
    "apps",
    "android",
    "app",
    "src",
    "thirdParty",
    "java",
    "ai",
    "openclaw",
    "app",
    "accessibility",
    "AccessibilityActionExecutor.kt",
  ),
  path.join(
    ROOT,
    "apps",
    "android",
    "app",
    "src",
    "thirdParty",
    "java",
    "ai",
    "openclaw",
    "app",
    "accessibility",
    "AccessibilitySnapshotter.kt",
  ),
]);
const BUILD_SETTING_RE = /\$\([A-Za-z0-9_.-]+\)/gu;
const NATIVE_I18N_LOCALE_SET = new Set<string>(NATIVE_I18N_LOCALES);
const ANDROID_LANGUAGE_PICKER_PATH =
  "apps/android/app/src/main/java/ai/openclaw/app/AppLanguage.kt";
const ANDROID_LANGUAGE_PICKER_SOURCES = new Set([
  "Follow Android · $systemLanguageTag",
  "OpenClaw translations · $languageTag",
]);

function isAsciiLowercaseLetter(character: string): boolean {
  return character >= "a" && character <= "z";
}

function isAsciiUppercaseLetter(character: string): boolean {
  return character >= "A" && character <= "Z";
}

function isAsciiAlphaNumeric(character: string): boolean {
  return (
    isAsciiLowercaseLetter(character) ||
    isAsciiUppercaseLetter(character) ||
    (character >= "0" && character <= "9")
  );
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function isLocalizableApplePlistKey(key: string): boolean {
  return key.endsWith("UsageDescription") || APPLE_LOCALIZABLE_DESCRIPTION_KEYS.has(key);
}

export function isConditionalBranchIdentifier(source: string): boolean {
  let index = 0;
  while (index < source.length && isAsciiLowercaseLetter(source.charAt(index))) {
    index += 1;
  }

  // Keep this scanner linear: PR-controlled native source passes through CI,
  // so a backtracking regex here can become a cheap native-i18n DoS trigger.
  if (index === 0 || index >= source.length || !isAsciiUppercaseLetter(source.charAt(index))) {
    return false;
  }

  for (index += 1; index < source.length; index += 1) {
    if (!isAsciiAlphaNumeric(source.charAt(index))) {
      return false;
    }
  }
  return true;
}

function isTranslatableCandidate(source: string, kind: string): boolean {
  if (BUILD_SETTING_RE.test(source)) {
    BUILD_SETTING_RE.lastIndex = 0;
    return false;
  }
  BUILD_SETTING_RE.lastIndex = 0;
  if (hasQuotedConditionalSwiftInterpolation(source)) {
    return false;
  }
  const isDirectUiText = kind.startsWith("ui-") || kind.startsWith("resource-");
  if (!isDirectUiText && (/^[a-z0-9_.:/$-]+$/u.test(source) || /^[A-Z0-9_.:/$-]+$/u.test(source))) {
    return false;
  }
  if (kind === "conditional-branch" && isConditionalBranchIdentifier(source)) {
    return false;
  }
  if (/[{}[\]]/u.test(source) && !/(?:\\\(|\$\{)/u.test(source)) {
    return false;
  }
  return kind !== "plist-string" || /\s/u.test(source);
}

function hasQuotedConditionalSwiftInterpolation(source: string): boolean {
  return (
    extractSwiftInterpolations(source)?.some(
      (interpolation) =>
        /\?\s*"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/u.test(interpolation) ||
        /\bif\b[\s\S]*"((?:\\.|[^"\\])*)"[\s\S]*\belse\b[\s\S]*"((?:\\.|[^"\\])*)"/u.test(
          interpolation,
        ),
    ) ?? false
  );
}

function extractSwiftInterpolations(source: string): string[] | null {
  const values: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\" || source[index + 1] !== "(") {
      continue;
    }
    const start = index;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    for (index += 2; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (!quoted && character === "(") {
        depth += 1;
      } else if (!quoted && character === ")") {
        depth -= 1;
        if (depth === 0) {
          values.push(source.slice(start, index + 1));
          break;
        }
      }
    }
    if (depth !== 0) {
      return null;
    }
  }
  return values;
}

function extractKotlinInterpolations(source: string): string[] | null {
  const values = [...source.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/gu)].map((match) => match[0]);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$" || source[index + 1] !== "{") {
      continue;
    }
    const start = index;
    let depth = 1;
    for (index += 2; index < source.length; index += 1) {
      if (source[index] === "{") {
        depth += 1;
      } else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          values.push(source.slice(start, index + 1));
          break;
        }
      }
    }
    if (depth !== 0) {
      return null;
    }
  }
  return values;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function findClosingBrace(source: string, openingBrace: number): number | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function readSwiftStringLiteral(
  source: string,
  openingQuote: number,
): { end: number; value: string } | null {
  if (source[openingQuote] !== '"' || source.startsWith('"""', openingQuote)) {
    return null;
  }
  let raw = "";
  for (let index = openingQuote + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined) {
        return null;
      }
      if (next === "(") {
        let depth = 1;
        let quoted = false;
        let escaped = false;
        let end = index + 2;
        for (; end < source.length; end += 1) {
          const interpolationCharacter = source[end];
          if (escaped) {
            escaped = false;
          } else if (quoted && interpolationCharacter === "\\") {
            escaped = true;
          } else if (interpolationCharacter === '"') {
            quoted = !quoted;
          } else if (!quoted && interpolationCharacter === "(") {
            depth += 1;
          } else if (!quoted && interpolationCharacter === ")") {
            depth -= 1;
            if (depth === 0) {
              break;
            }
          }
        }
        if (depth !== 0) {
          return null;
        }
        raw += source.slice(index, end + 1);
        index = end;
        continue;
      }
      if (next === "n") {
        raw += "\n";
      } else if (next === "r") {
        raw += "\r";
      } else if (next === "t") {
        raw += "\t";
      } else if (next === '"' || next === "\\") {
        raw += next;
      } else {
        raw += character + next;
      }
      index += 1;
      continue;
    }
    if (character === '"') {
      return { end: index + 1, value: raw };
    }
    raw += character;
  }
  return null;
}

function readKotlinStringLiteral(
  source: string,
  openingQuote: number,
): { end: number; value: string } | null {
  if (source[openingQuote] !== '"' || source.startsWith('"""', openingQuote)) {
    return null;
  }
  let raw = "";
  for (let index = openingQuote + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "$" && source[index + 1] === "{") {
      let depth = 1;
      let quoted = false;
      let escaped = false;
      let end = index + 2;
      for (; end < source.length; end += 1) {
        const interpolationCharacter = source[end];
        if (escaped) {
          escaped = false;
        } else if (quoted && interpolationCharacter === "\\") {
          escaped = true;
        } else if (interpolationCharacter === '"') {
          quoted = !quoted;
        } else if (!quoted && interpolationCharacter === "{") {
          depth += 1;
        } else if (!quoted && interpolationCharacter === "}") {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      if (depth !== 0) {
        return null;
      }
      raw += source.slice(index, end + 1);
      index = end;
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined) {
        return null;
      }
      if (next === "n") {
        raw += "\n";
      } else if (next === "r") {
        raw += "\r";
      } else if (next === "t") {
        raw += "\t";
      } else if (next === '"' || next === "\\" || next === "$") {
        raw += next;
      } else {
        raw += character + next;
      }
      index += 1;
      continue;
    }
    if (character === '"') {
      return { end: index + 1, value: raw };
    }
    raw += character;
  }
  return null;
}

function readMultilineStringLiteral(
  source: string,
  openingQuote: number,
): { end: number; value: string } | null {
  if (!source.startsWith('"""', openingQuote)) {
    return null;
  }
  const closingQuote = source.indexOf('"""', openingQuote + 3);
  if (closingQuote < 0) {
    return null;
  }
  return {
    end: closingQuote + 3,
    value: decodeMultilineLiteral(source.slice(openingQuote + 3, closingQuote)),
  };
}

function readNativeStringLiteral(
  surface: NativeI18nSurface,
  source: string,
  openingQuote: number,
): { end: number; value: string } | null {
  return (
    readMultilineStringLiteral(source, openingQuote) ??
    (surface === "apple"
      ? readSwiftStringLiteral(source, openingQuote)
      : readKotlinStringLiteral(source, openingQuote))
  );
}

function readAdjacentStringLiterals(
  surface: NativeI18nSurface,
  source: string,
  openingQuote: number,
): { end: number; fragments: number; value: string } | null {
  const first = readNativeStringLiteral(surface, source, openingQuote);
  if (!first) {
    return null;
  }
  const values = [first.value];
  let cursor = first.end;
  for (;;) {
    const separator = source.slice(cursor).match(/^\s*\+\s*/u)?.[0];
    if (!separator) {
      return { end: cursor, fragments: values.length, value: values.join("") };
    }
    cursor += separator.length;
    const next = readNativeStringLiteral(surface, source, cursor);
    // A runtime concatenation is not a compile-time literal. Dropping the whole
    // candidate prevents the inventory from preserving a misleading prefix.
    if (!next) {
      return null;
    }
    values.push(next.value);
    cursor = next.end;
  }
}

function extractUiCalls(
  entries: Candidate[],
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  uiCallNames: ReadonlySet<string>,
) {
  for (const match of source.matchAll(APPLE_CALL_START)) {
    if (!match[1] || !uiCallNames.has(match[1])) {
      continue;
    }
    const offset = match.index ?? 0;
    const openingQuote = offset + match[0].length;
    const literal = readAdjacentStringLiterals(surface, source, openingQuote);
    if (!literal) {
      continue;
    }
    const kind = literal.fragments > 1 ? "ui-call-concatenated" : "ui-call";
    addCandidate(entries, surface, repoPath, literal.value, kind, lineNumber(source, offset));
  }
}

function decodeMultilineLiteral(raw: string): string {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() === "") {
    lines.shift();
  }
  if (lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^[ \t]*/u)?.[0].length ?? 0);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  const deindented = lines.map((line) => line.slice(Math.min(indent, line.length)));
  return deindented
    .map((line, index) => {
      if (index === deindented.length - 1) {
        return line;
      }
      const trailingBackslashes = line.match(/\\+$/u)?.[0].length ?? 0;
      return trailingBackslashes % 2 === 1 ? line.slice(0, -1) : `${line}\n`;
    })
    .join("");
}

function decodeLiteral(raw: string, kind: string): string {
  if (kind.endsWith("-multiline")) {
    return decodeMultilineLiteral(raw);
  }
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function normalizeSource(source: string): string {
  return source;
}

function identifierBefore(source: string, offset: number): string | null {
  let cursor = offset - 1;
  while (cursor >= 0 && source.charCodeAt(cursor) <= 32) {
    cursor -= 1;
  }
  const end = cursor + 1;
  while (
    cursor >= 0 &&
    (isAsciiAlphaNumeric(source.charAt(cursor)) || source.charAt(cursor) === "_")
  ) {
    cursor -= 1;
  }
  const start = cursor + 1;
  if (
    start === end ||
    (!isAsciiLowercaseLetter(source.charAt(start)) &&
      !isAsciiUppercaseLetter(source.charAt(start)) &&
      source.charAt(start) !== "_")
  ) {
    return null;
  }
  return source.slice(start, end);
}

function enclosingCallName(source: string, offset: number): string | null {
  let depth = 0;
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (source[index] === ")") {
      depth += 1;
      continue;
    }
    if (source[index] !== "(") {
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    return identifierBefore(source, index);
  }
  return null;
}

function structuralTokenSignature(source: string): string {
  const swift = extractSwiftInterpolations(source)?.toSorted();
  const kotlin = extractKotlinInterpolations(source)?.toSorted();
  const icu = [...source.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)]
    .map((match) => match[1])
    .toSorted();
  const nativeFormat = [...source.matchAll(NATIVE_FORMAT_RE)].map((match) => match[0]).toSorted();
  const buildSettings = (source.match(BUILD_SETTING_RE) ?? []).toSorted();
  const lineBreaks = (source.match(/\n/gu) ?? []).length;
  return JSON.stringify({ swift, kotlin, icu, nativeFormat, buildSettings, lineBreaks });
}

function addCandidate(
  entries: Candidate[],
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  kind: string,
  line: number,
) {
  const normalized = normalizeSource(decodeLiteral(source, kind));
  if (!normalized.trim() || !/\p{L}/u.test(normalized)) {
    return;
  }
  if (!isTranslatableCandidate(normalized, kind)) {
    return;
  }
  if (
    normalized.length > 500 ||
    extractSwiftInterpolations(normalized) === null ||
    extractKotlinInterpolations(normalized) === null
  ) {
    return;
  }
  entries.push({ kind, line, path: repoPath, source: normalized, surface });
}

function findCapturedLiteralOffset(
  source: string,
  match: RegExpMatchArray,
  value: string,
  searchStart: number,
): number | null {
  const matchEnd = (match.index ?? 0) + match[0].length;
  const normal = source.indexOf(`"${value}"`, searchStart);
  const multiline = source.indexOf(`"""${value}"""`, searchStart);
  const offsets = [normal, multiline].filter((offset) => offset >= 0 && offset < matchEnd);
  return offsets.length > 0 ? Math.min(...offsets) : null;
}

function addCapturedLiteralCandidates(
  entries: Candidate[],
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  match: RegExpMatchArray,
  kind: string,
) {
  let searchStart = match.index ?? 0;
  for (const value of match.slice(1)) {
    if (!value) {
      continue;
    }
    const openingQuote = findCapturedLiteralOffset(source, match, value, searchStart);
    if (openingQuote === null) {
      continue;
    }
    const literal = readAdjacentStringLiterals(surface, source, openingQuote);
    if (literal) {
      addCandidate(
        entries,
        surface,
        repoPath,
        literal.value,
        literal.fragments > 1 ? `${kind}-concatenated` : kind,
        lineNumber(source, openingQuote),
      );
      searchStart = literal.end;
    } else {
      searchStart = openingQuote + 1;
    }
  }
}

function skipWhitespaceAndBrace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /\s/u.test(source.charAt(cursor))) {
    cursor += 1;
  }
  if (source.charAt(cursor) === "{") {
    cursor += 1;
    while (cursor < source.length && /\s/u.test(source.charAt(cursor))) {
      cursor += 1;
    }
  }
  if (source.startsWith("return", cursor) && !isAsciiAlphaNumeric(source[cursor + 6] ?? "")) {
    cursor += 6;
    while (cursor < source.length && /\s/u.test(source.charAt(cursor))) {
      cursor += 1;
    }
  }
  return cursor;
}

function addConditionalBranchPair(
  entries: Candidate[],
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  firstOffset: number,
  separator: RegExp,
) {
  const firstStart = skipWhitespaceAndBrace(source, firstOffset);
  const first = readAdjacentStringLiterals(surface, source, firstStart);
  if (!first) {
    return;
  }
  const remainder = source.slice(first.end);
  const separatorMatch = remainder.match(separator);
  if (!separatorMatch) {
    return;
  }
  const secondStart = skipWhitespaceAndBrace(source, first.end + separatorMatch[0].length);
  const second = readAdjacentStringLiterals(surface, source, secondStart);
  const branches = [{ offset: firstStart, value: first.value }];
  if (second) {
    branches.push({ offset: secondStart, value: second.value });
  }
  for (const branch of branches) {
    addCandidate(
      entries,
      surface,
      repoPath,
      branch.value,
      "conditional-branch",
      lineNumber(source, branch.offset),
    );
  }
}

function extractConditionalBranches(
  entries: Candidate[],
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
) {
  for (const match of source.matchAll(/\bif\s*\([^)]*\)\s*/gu)) {
    addConditionalBranchPair(
      entries,
      surface,
      repoPath,
      source,
      (match.index ?? 0) + match[0].length,
      /^\s*\}?\s*else\s*/u,
    );
  }
  for (const match of source.matchAll(/\?\s*/gu)) {
    addConditionalBranchPair(
      entries,
      surface,
      repoPath,
      source,
      (match.index ?? 0) + match[0].length,
      /^\s*:\s*/u,
    );
  }
}

function addBranchCandidates(
  entries: Candidate[],
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  bodyOffset: number,
  body: string,
  branchStart: RegExp,
) {
  for (const branch of body.matchAll(branchStart)) {
    const openingQuote = skipWhitespaceAndBrace(
      source,
      bodyOffset + (branch.index ?? 0) + branch[0].length,
    );
    const literal = readAdjacentStringLiterals(surface, source, openingQuote);
    if (literal) {
      addCandidate(
        entries,
        surface,
        repoPath,
        literal.value,
        "conditional-branch",
        lineNumber(source, openingQuote),
      );
    }
  }
}

export function extractNativeI18nCandidates(
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  uiCallNames: ReadonlySet<string> = new Set([
    ...APPLE_BUILTIN_UI_CALLS,
    ...ANDROID_BUILTIN_UI_CALLS,
  ]),
): Candidate[] {
  const entries: Candidate[] = [];
  const patterns: Array<readonly [RegExp, string]> =
    surface === "apple"
      ? [
          [APPLE_UI_MULTILINE_CALLS, "ui-call-multiline"],
          [APPLE_LOCALIZED_STRING_CALLS, "ui-localized-call"],
          [APPLE_LOCALIZED_STRING_MULTILINE_CALLS, "ui-localized-call-multiline"],
          [APPLE_MODIFIER_CALLS, "ui-modifier"],
          [APPLE_MODIFIER_MULTILINE_CALLS, "ui-modifier-multiline"],
        ]
      : [
          [ANDROID_CALLS, "ui-call"],
          [ANDROID_TOAST_ARGS, "ui-toast"],
          [ANDROID_CHOOSER_ARGS, "ui-chooser"],
          [ANDROID_DIALOG_CALLS, "ui-dialog"],
          [ANDROID_UI_STATE_TEXT, "ui-state-text"],
        ];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      addCapturedLiteralCandidates(entries, surface, repoPath, source, match, kind);
    }
  }
  extractConditionalBranches(entries, surface, repoPath, source);
  extractUiCalls(entries, surface, repoPath, source, uiCallNames);
  if (surface === "apple") {
    for (const property of source.matchAll(APPLE_STRING_PROPERTY)) {
      const name = property[1];
      const openingBrace = (property.index ?? 0) + property[0].lastIndexOf("{");
      const closingBrace = findClosingBrace(source, openingBrace);
      if (!name || !UI_STRING_NAME_RE.test(name) || closingBrace === null) {
        continue;
      }
      const body = source.slice(openingBrace + 1, closingBrace);
      if (!/\bswitch\b/u.test(body)) {
        continue;
      }
      addBranchCandidates(
        entries,
        surface,
        repoPath,
        source,
        openingBrace + 1,
        body,
        APPLE_SWITCH_BRANCH_START,
      );
    }
    for (const match of source.matchAll(APPLE_NAMED_LITERALS)) {
      const argumentName = match[1];
      const callName = enclosingCallName(source, match.index ?? 0);
      if (
        !argumentName ||
        !UI_STRING_NAME_RE.test(argumentName) ||
        !callName ||
        !uiCallNames.has(callName)
      ) {
        continue;
      }
      const multiline = match[2];
      const literal = multiline ?? match[3];
      if (literal) {
        addCapturedLiteralCandidates(
          entries,
          surface,
          repoPath,
          source,
          match,
          multiline === undefined ? "ui-named-argument" : "ui-named-argument-multiline",
        );
      }
    }
  }
  if (surface === "android") {
    for (const helper of source.matchAll(ANDROID_STRING_FUNCTION)) {
      const name = helper[1];
      const bodyKind = helper[2];
      if (!name || !bodyKind || !UI_STRING_NAME_RE.test(name)) {
        continue;
      }
      const bodyStart = (helper.index ?? 0) + helper[0].length;
      if (bodyKind === "{") {
        const openingBrace = bodyStart - 1;
        const closingBrace = findClosingBrace(source, openingBrace);
        if (closingBrace === null) {
          continue;
        }
        const body = source.slice(bodyStart, closingBrace);
        for (const returnKeyword of body.matchAll(/\breturn\b/gu)) {
          const openingQuote = skipWhitespaceAndBrace(
            source,
            bodyStart + (returnKeyword.index ?? 0) + returnKeyword[0].length,
          );
          const literal = readAdjacentStringLiterals(surface, source, openingQuote);
          if (literal) {
            addCandidate(
              entries,
              surface,
              repoPath,
              literal.value,
              "conditional-branch",
              lineNumber(source, openingQuote),
            );
          }
        }
        continue;
      }
      const expression = source.slice(bodyStart);
      const whenMatch = expression.match(/^\s*when\s*\([^)]*\)\s*\{/u);
      if (whenMatch) {
        const openingBrace = bodyStart + whenMatch[0].lastIndexOf("{");
        const closingBrace = findClosingBrace(source, openingBrace);
        if (closingBrace === null) {
          continue;
        }
        const body = source.slice(openingBrace + 1, closingBrace);
        addBranchCandidates(
          entries,
          surface,
          repoPath,
          source,
          openingBrace + 1,
          body,
          ANDROID_WHEN_BRANCH_START,
        );
        continue;
      }
      const openingQuote = skipWhitespaceAndBrace(source, bodyStart);
      const literal = readAdjacentStringLiterals(surface, source, openingQuote);
      if (literal) {
        addCandidate(
          entries,
          surface,
          repoPath,
          literal.value,
          "conditional-branch",
          lineNumber(source, openingQuote),
        );
        continue;
      }
      const elvisFallback = expression.match(/^\s*[^\n]*\?:\s*/u);
      if (elvisFallback) {
        const fallbackQuote = skipWhitespaceAndBrace(source, bodyStart + elvisFallback[0].length);
        const fallback = readAdjacentStringLiterals(surface, source, fallbackQuote);
        if (fallback) {
          addCandidate(
            entries,
            surface,
            repoPath,
            fallback.value,
            "conditional-branch",
            lineNumber(source, fallbackQuote),
          );
        }
      }
    }
    for (const match of source.matchAll(ANDROID_NAMED_LITERALS)) {
      const argumentName = match[1];
      const callName = enclosingCallName(source, match.index ?? 0);
      if (
        !argumentName ||
        !UI_STRING_NAME_RE.test(argumentName) ||
        !callName ||
        !uiCallNames.has(callName) ||
        !match[2]
      ) {
        continue;
      }
      addCapturedLiteralCandidates(entries, surface, repoPath, source, match, "ui-named-argument");
    }
  }
  if (surface === "android" && /\/res\/values\/[^/]+\.xml$/u.test(repoPath)) {
    for (const match of source.matchAll(ANDROID_RESOURCE_STRINGS)) {
      const resourceName = match[1]?.match(ANDROID_RESOURCE_NAME)?.[1];
      if (resourceName?.startsWith("native_")) {
        continue;
      }
      if (match[2]) {
        addCandidate(
          entries,
          surface,
          repoPath,
          match[2],
          "resource-string",
          lineNumber(source, match.index ?? 0),
        );
      }
    }
    for (const collection of source.matchAll(ANDROID_RESOURCE_COLLECTIONS)) {
      const attributes = collection[1] ?? "";
      const body = collection[2];
      if (!body || /\btranslatable\s*=\s*"false"/u.test(attributes)) {
        continue;
      }
      const bodyOffset = (collection.index ?? 0) + collection[0].indexOf(body);
      for (const item of body.matchAll(ANDROID_RESOURCE_ITEMS)) {
        const value = item[1]?.trim();
        // Resource references inherit translatability from their target.
        if (value && !value.startsWith("@")) {
          addCandidate(
            entries,
            surface,
            repoPath,
            value,
            "resource-item",
            lineNumber(source, bodyOffset + (item.index ?? 0)),
          );
        }
      }
    }
  }
  if (surface === "apple" && repoPath.endsWith(".plist")) {
    for (const match of source.matchAll(APPLE_PLIST_KEYED_STRINGS)) {
      const key = match[1];
      const value = match[2];
      if (key && isLocalizableApplePlistKey(key) && value) {
        const valueOffset = (match.index ?? 0) + match[0].indexOf(value);
        addCandidate(
          entries,
          surface,
          repoPath,
          decodeXml(value),
          "plist-string",
          lineNumber(source, valueOffset),
        );
      }
    }
  }
  return [
    ...new Map(
      entries.map((entry) => [[entry.surface, entry.path, entry.source].join("\u0000"), entry]),
    ).values(),
  ];
}

async function walkFiles(root: string, surface: NativeI18nSurface): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (GENERATED_PATH_RE.test(fullPath) || EXCLUDED_PATH_RE.test(fullPath)) {
          return [];
        }
        return await walkFiles(fullPath, surface);
      }
      const extension = path.extname(entry.name);
      const isAndroidValuesXml =
        surface === "android" &&
        extension === ".xml" &&
        path.dirname(fullPath).endsWith(`${path.sep}res${path.sep}values`);
      const allowed = surface === "apple" ? APPLE_EXTENSIONS : ANDROID_EXTENSIONS;
      return entry.isFile() &&
        (allowed.has(extension) || isAndroidValuesXml) &&
        !ANDROID_NATIVE_I18N_EXCLUDED_FILES.has(fullPath) &&
        !EXCLUDED_FILE_RE.test(entry.name) &&
        !GENERATED_FILE_RE.test(fullPath)
        ? [fullPath]
        : [];
    }),
  );
  return nested.flat();
}

function nativeEntryIdentity(
  entry: Pick<NativeI18nEntry, "path" | "source" | "surface"> &
    Partial<Pick<NativeI18nEntry, "semanticKey">>,
): string {
  if (entry.surface === "linux" && entry.semanticKey) {
    return [entry.surface, entry.semanticKey].join("\u0000");
  }
  return [entry.surface, entry.path, entry.source].join("\u0000");
}

function nativeSourceIdentity(entry: Pick<NativeI18nEntry, "source" | "surface">): string {
  return [entry.surface, entry.source].join("\u0000");
}

function sharedNativeSemanticKey(
  entry: Pick<NativeI18nEntry, "source">,
  sharedCatalog?: ControlUiSharedCatalog,
): string | undefined {
  if (!sharedCatalog) {
    return undefined;
  }

  const semanticKey = REVIEWED_SHARED_NATIVE_MESSAGES.get(entry.source);
  if (!semanticKey) {
    return undefined;
  }
  if (sharedCatalog.source.get(semanticKey) !== entry.source) {
    throw new Error(
      `reviewed native localization mapping ${semanticKey} must equal ${JSON.stringify(entry.source)}`,
    );
  }
  return semanticKey;
}

export function assignNativeI18nIds(
  entries: readonly Candidate[],
  previousEntries: readonly NativeI18nEntry[] = [],
  sharedCatalog?: ControlUiSharedCatalog,
): NativeI18nEntry[] {
  const seen = new Set<string>();
  const unique = [...new Map(entries.map((entry) => [nativeEntryIdentity(entry), entry])).values()];
  const currentIdentities = new Set(unique.map(nativeEntryIdentity));
  const previousByIdentity = new Map(
    previousEntries.map((entry) => [nativeEntryIdentity(entry), entry]),
  );
  const previousPositions = new Map(
    previousEntries.map((entry, index) => [nativeEntryIdentity(entry), index]),
  );
  const previousBySource = new Map<string, NativeI18nEntry[]>();
  for (const entry of previousEntries) {
    const identity = nativeSourceIdentity(entry);
    const previous = previousBySource.get(identity) ?? [];
    previous.push(entry);
    previousBySource.set(identity, previous);
  }

  const previousFor = (entry: Candidate): NativeI18nEntry | undefined => {
    const exact = previousByIdentity.get(nativeEntryIdentity(entry));
    if (exact) {
      return exact;
    }
    const moved = (previousBySource.get(nativeSourceIdentity(entry)) ?? []).filter(
      (candidate) => !currentIdentities.has(nativeEntryIdentity(candidate)),
    );
    return moved.length === 1 ? moved[0] : undefined;
  };

  return unique
    .toSorted(
      (left, right) =>
        compareCodePoints(left.surface, right.surface) ||
        compareCodePoints(left.path, right.path) ||
        (previousPositions.get(nativeEntryIdentity(left)) ?? Number.MAX_SAFE_INTEGER) -
          (previousPositions.get(nativeEntryIdentity(right)) ?? Number.MAX_SAFE_INTEGER) ||
        compareCodePoints(left.source, right.source) ||
        compareCodePoints(left.kind, right.kind),
    )
    .map((entry) => {
      const identity = nativeEntryIdentity(entry);
      const previous = previousFor(entry);
      const previousId = previous?.id;
      const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
      const baseId = `native.${entry.surface}.${digest}`;
      let id = previousId && !seen.has(previousId) ? previousId : baseId;
      for (let suffix = 2; seen.has(id); suffix += 1) {
        id = `${baseId}.${suffix}`;
      }
      seen.add(id);

      const persisted: NativeI18nEntry = {
        kind: entry.kind,
        path: entry.path,
        source: entry.source,
        surface: entry.surface,
        id,
      };
      const semanticKey =
        entry.semanticKey ??
        (sharedCatalog ? sharedNativeSemanticKey(entry, sharedCatalog) : previous?.semanticKey);
      if (semanticKey) {
        persisted.semanticKey = semanticKey;
        const description =
          entry.description ??
          (previous?.semanticKey === semanticKey ? previous.description : undefined) ??
          sharedCatalog?.descriptions.get(semanticKey);
        if (description) {
          persisted.description = description;
        }
      }
      return persisted;
    });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function readNativeI18nInventory(): Promise<{
  entries: NativeI18nEntry[];
  raw: string;
}> {
  let raw: string;
  try {
    raw = await readFile(OUTPUT_PATH, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { entries: [], raw: "" };
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid native app i18n inventory: ${OUTPUT_PATH}`);
  }
  const inventory = parsed as { entries?: unknown; version?: unknown };
  if (inventory.version !== 1 || !Array.isArray(inventory.entries)) {
    throw new Error(`invalid native app i18n inventory: ${OUTPUT_PATH}`);
  }
  return { entries: inventory.entries as NativeI18nEntry[], raw };
}

function sharedNativeCatalog(locale?: string): Promise<ControlUiSharedCatalog> {
  const cacheKey = locale ?? "source";
  let pending = SHARED_CATALOG_BY_LOCALE.get(cacheKey);
  if (!pending) {
    pending = loadControlUiSharedCatalog({ rootDir: ROOT, locales: locale ? [locale] : [] }).then(
      (catalog) => {
        for (const [source, semanticKey] of REVIEWED_SHARED_NATIVE_MESSAGES) {
          if (catalog.source.get(semanticKey) !== source) {
            throw new Error(
              `reviewed native localization mapping ${semanticKey} must equal ${JSON.stringify(source)}`,
            );
          }
        }
        return catalog;
      },
    );
    SHARED_CATALOG_BY_LOCALE.set(cacheKey, pending);
  }
  return pending;
}

export async function collectNativeI18nEntries(
  previousEntries?: readonly NativeI18nEntry[],
): Promise<NativeI18nEntry[]> {
  // The checked-in inventory is the stable-ID registry. Reusing IDs for the same
  // surface/path/source keeps extractor reclassification from orphaning translations.
  const stableEntries = previousEntries ?? (await readNativeI18nInventory()).entries;
  const roots = (["android", "apple"] as const).flatMap((surface) =>
    SOURCE_ROOTS[surface].map((sourceRoot) => ({ sourceRoot, surface })),
  );
  const filesByRoot = await Promise.all(
    roots.map(async ({ sourceRoot, surface }) => ({
      files: (await walkFiles(sourceRoot, surface)).toSorted(),
      surface,
    })),
  );
  const sources = await pMap(
    filesByRoot.flatMap(({ files, surface }) => files.map((filePath) => ({ filePath, surface }))),
    async ({ filePath, surface }) => ({
      repoPath: path.relative(ROOT, filePath).split(path.sep).join("/"),
      source: await readFile(filePath, "utf8"),
      surface,
    }),
    {
      concurrency: NATIVE_SOURCE_READ_CONCURRENCY,
      stopOnError: true,
    },
  );
  const typedSources: Array<{
    repoPath: string;
    source: string;
    surface: NativeI18nSurface;
  }> = sources;
  const uiCallNames = new Set([...APPLE_BUILTIN_UI_CALLS, ...ANDROID_BUILTIN_UI_CALLS]);
  for (const { source, surface } of typedSources) {
    if (surface === "android") {
      for (const match of source.matchAll(ANDROID_COMPOSABLE_FUNCTION)) {
        if (match[1]) {
          uiCallNames.add(match[1]);
        }
      }
      continue;
    }
    for (const pattern of [APPLE_VIEW_TYPE, APPLE_VIEW_FUNCTION, APPLE_ALERT_FUNCTION]) {
      for (const match of source.matchAll(pattern)) {
        if (match[1]) {
          uiCallNames.add(match[1]);
        }
      }
    }
  }
  const entries = typedSources.flatMap(({ repoPath, source, surface }) =>
    extractNativeI18nCandidates(surface, repoPath, source, uiCallNames),
  );
  const sharedCatalog = await sharedNativeCatalog();
  const linuxEntries: Candidate[] = [...sharedCatalog.source.entries()]
    .filter(([semanticKey]) => semanticKey.startsWith("desktop."))
    .map(([semanticKey, source]) => ({
      description: sharedCatalog.descriptions.get(semanticKey),
      kind: "semantic-message",
      line: 0,
      path: LINUX_MESSAGES_PATH,
      semanticKey,
      source,
      surface: "linux",
    }));
  return assignNativeI18nIds([...entries, ...linuxEntries], stableEntries, sharedCatalog);
}

function render(entries: NativeI18nEntry[]): string {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

async function syncNativeI18n(options: {
  checkInventory: boolean;
  checkLocales: boolean;
  write: boolean;
}): Promise<NativeI18nEntry[]> {
  const currentInventory = await readNativeI18nInventory();
  const entries = await collectNativeI18nEntries(currentInventory.entries);
  const expected = render(entries);
  const current = currentInventory.raw;
  if (options.checkLocales) {
    const findings = await checkNativeLocaleArtifacts(currentInventory.entries);
    for (const finding of findings) {
      process.stdout.write(`native-app-i18n: advisory=${JSON.stringify(finding)}\n`);
    }
    process.stdout.write(
      `native-app-i18n: locale-artifacts=${NATIVE_I18N_LOCALES.length} advisories=${findings.length}\n`,
    );
  }
  if (options.checkInventory && current !== expected) {
    throw new Error(
      "native app i18n inventory drift detected. Run `pnpm native:i18n:baseline` and commit apps/.i18n/native-source.json.",
    );
  }
  if (current !== expected && options.write) {
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, expected, "utf8");
  }
  const count = JSON.parse(expected).entries.length as number;
  process.stdout.write(`native-app-i18n: entries=${count} changed=${current !== expected}\n`);
  return entries;
}

async function loadGlossary(locale: string): Promise<Array<{ source: string; target: string }>> {
  try {
    return JSON.parse(
      await readFile(
        path.join(ROOT, "ui", "src", "i18n", ".i18n", `glossary.${locale}.json`),
        "utf8",
      ),
    ) as Array<{ source: string; target: string }>;
  } catch {
    return [];
  }
}

function glossaryHash(glossary: readonly { source: string; target: string }[]): string {
  return createHash("sha256").update(JSON.stringify(glossary)).digest("hex");
}

function adjacentDuplicateWords(value: string, locale: string): string[] {
  const words = [...value.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((match) => match[0]);
  const duplicates = new Set<string>();
  for (let index = 1; index < words.length; index += 1) {
    if (
      expectDefined(words[index - 1], `native i18n word before index ${index}`)
        .normalize("NFKC")
        .toLocaleLowerCase(locale) ===
      expectDefined(words[index], `native i18n word at index ${index}`)
        .normalize("NFKC")
        .toLocaleLowerCase(locale)
    ) {
      duplicates.add(expectDefined(words[index], `duplicate native i18n word at index ${index}`));
    }
  }
  return [...duplicates].toSorted(compareCodePoints);
}

function collectNativeI18nQualityFindings(
  locale: string,
  inventory: readonly NativeI18nEntry[],
  entries: readonly { id: string; source: string; translated: string }[],
): NativeI18nQualityFinding[] {
  const inventoryById = new Map(inventory.map((entry) => [entry.id, entry]));
  const translatedBySource = new Map<string, Array<{ id: string; translated: string }>>();
  for (const entry of entries) {
    const existing = translatedBySource.get(entry.source) ?? [];
    existing.push({ id: entry.id, translated: entry.translated });
    translatedBySource.set(entry.source, existing);
  }

  const findings: NativeI18nQualityFinding[] = [];
  for (const entry of entries) {
    const sourceEqual = entry.translated === entry.source;
    if (sourceEqual) {
      findings.push({ code: "source-equal", locale, ...entry });
      const relatedIds = (translatedBySource.get(entry.source) ?? [])
        .filter((candidate) => candidate.id !== entry.id && candidate.translated !== entry.source)
        .map((candidate) => candidate.id)
        .toSorted(compareCodePoints);
      if (relatedIds.length > 0) {
        findings.push({
          code: "same-source-contradiction",
          locale,
          ...entry,
          relatedIds,
        });
      }
      const inventoryEntry = inventoryById.get(entry.id);
      if (
        inventoryEntry?.surface === "android" &&
        inventoryEntry.path === ANDROID_LANGUAGE_PICKER_PATH &&
        ANDROID_LANGUAGE_PICKER_SOURCES.has(entry.source)
      ) {
        findings.push({
          code: "android-language-picker-source-equal",
          locale,
          ...entry,
        });
      }
    }

    const words = adjacentDuplicateWords(entry.translated, locale);
    if (words.length > 0) {
      findings.push({
        code: "adjacent-duplicate-word",
        locale,
        ...entry,
        words,
      });
    }
  }
  return findings.toSorted(
    (left, right) =>
      compareCodePoints(left.locale, right.locale) ||
      compareCodePoints(left.code, right.code) ||
      compareCodePoints(left.id, right.id),
  );
}

function describeArtifactValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function validateNativeLocaleArtifact(
  locale: string,
  inventory: readonly NativeI18nEntry[],
  artifactValue: unknown,
  glossary: readonly { source: string; target: string }[] = [],
): NativeI18nQualityFinding[] {
  const errors: string[] = [];
  if (!artifactValue || typeof artifactValue !== "object" || Array.isArray(artifactValue)) {
    throw new Error(`invalid native locale artifact ${locale}: expected an object`);
  }
  const artifact = artifactValue as {
    entries?: unknown;
    glossaryHash?: unknown;
    locale?: unknown;
    version?: unknown;
  };
  if (artifact.version !== 1) {
    errors.push(`version must be 1, got ${describeArtifactValue(artifact.version)}`);
  }
  if (artifact.locale !== locale) {
    errors.push(
      `locale must be ${JSON.stringify(locale)}, got ${describeArtifactValue(artifact.locale)}`,
    );
  }
  const expectedGlossaryHash = glossaryHash(glossary);
  if (artifact.glossaryHash !== expectedGlossaryHash) {
    errors.push(
      `glossaryHash must be ${expectedGlossaryHash}, got ${describeArtifactValue(artifact.glossaryHash)}`,
    );
  }
  if (!Array.isArray(artifact.entries)) {
    errors.push("entries must be an array");
  }

  const rawEntries = Array.isArray(artifact.entries) ? artifact.entries : [];
  const entries: Array<{ id: string; source: string; translated: string }> = [];
  const seenIds = new Set<string>();
  for (const [index, value] of rawEntries.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`entries[${index}] must be an object`);
      continue;
    }
    const entry = value as { id?: unknown; source?: unknown; translated?: unknown };
    if (
      typeof entry.id !== "string" ||
      typeof entry.source !== "string" ||
      typeof entry.translated !== "string"
    ) {
      errors.push(`entries[${index}] must contain string id, source, and translated fields`);
      continue;
    }
    if (seenIds.has(entry.id)) {
      errors.push(`duplicate id ${JSON.stringify(entry.id)}`);
    }
    seenIds.add(entry.id);
    entries.push({ id: entry.id, source: entry.source, translated: entry.translated });
  }

  if (rawEntries.length !== inventory.length) {
    errors.push(`entry count must be ${inventory.length}, got ${rawEntries.length}`);
  }
  for (let index = 0; index < Math.min(entries.length, inventory.length); index += 1) {
    const actual = expectDefined(entries[index], `native locale entry at index ${index}`);
    const expected = expectDefined(inventory[index], `native inventory entry at index ${index}`);
    if (actual.id !== expected.id) {
      errors.push(
        `entries[${index}].id must be ${JSON.stringify(expected.id)}, got ${JSON.stringify(actual.id)}`,
      );
    }
    if (actual.source !== expected.source) {
      errors.push(`entries[${index}].source does not match inventory id ${expected.id}`);
    }
    if (!actual.translated.trim()) {
      errors.push(`entries[${index}].translated must be nonempty for ${actual.id}`);
    } else if (
      structuralTokenSignature(actual.source) !== structuralTokenSignature(actual.translated)
    ) {
      errors.push(`translation changed structural tokens or line breaks for ${actual.id}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`invalid native locale artifact ${locale}:\n- ${errors.join("\n- ")}`);
  }
  return collectNativeI18nQualityFindings(locale, inventory, entries);
}

export async function checkNativeLocaleArtifacts(
  inventory: readonly NativeI18nEntry[],
  translationsDir = TRANSLATIONS_DIR,
): Promise<NativeI18nQualityFinding[]> {
  const expectedFiles = NATIVE_I18N_LOCALES.map((locale) => `${locale}.json`).toSorted(
    compareCodePoints,
  );
  const actualFiles = (await readdir(translationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .toSorted(compareCodePoints);
  const errors: string[] = [];
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    errors.push(
      `locale files must be ${JSON.stringify(expectedFiles)}, got ${JSON.stringify(actualFiles)}`,
    );
  }

  const findings: NativeI18nQualityFinding[] = [];
  for (const locale of NATIVE_I18N_LOCALES) {
    const artifactPath = path.join(translationsDir, `${locale}.json`);
    try {
      const artifact: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
      findings.push(
        ...validateNativeLocaleArtifact(locale, inventory, artifact, await loadGlossary(locale)),
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(`native locale artifact validation failed:\n${errors.join("\n")}`);
  }
  return findings.toSorted(
    (left, right) =>
      compareCodePoints(left.locale, right.locale) ||
      compareCodePoints(left.code, right.code) ||
      compareCodePoints(left.id, right.id),
  );
}

export async function syncNativeLocale(
  locale: string,
  entries: NativeI18nEntry[],
  options: NativeLocaleSyncOptions = {},
) {
  // Native runtime resources are owned by the Android and Apple slices; these
  // artifacts keep the shared translation-memory handoff current between them.
  const artifactPath = path.join(options.translationsDir ?? TRANSLATIONS_DIR, `${locale}.json`);
  const glossary = options.glossary ?? (await loadGlossary(locale));
  const currentGlossaryHash = glossaryHash(glossary);
  let previousRaw = "";
  let previous: NativeTranslationArtifact = {
    entries: [],
    glossaryHash: "",
    locale,
    version: 1,
  };
  try {
    previousRaw = await readFile(artifactPath, "utf8");
    previous = JSON.parse(previousRaw) as NativeTranslationArtifact;
  } catch {
    // The first refresh creates the locale artifact.
  }
  const sharedCatalog =
    options.sharedCatalog ??
    (entries.some((entry) => entry.semanticKey) ? await sharedNativeCatalog(locale) : undefined);
  const previousById = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const exactById = new Map(
    entries.map((entry) => {
      const exact = previousById.get(entry.id);
      const translated =
        exact?.source === entry.source && exact.translated.trim() ? exact.translated : undefined;
      return [entry.id, translated] as const;
    }),
  );
  const previousBySemanticKey = new Map<string, Set<string>>();
  for (const entry of entries) {
    const translated = exactById.get(entry.id);
    if (!entry.semanticKey || !translated || translated === entry.source) {
      continue;
    }
    const semanticIdentity = `${entry.semanticKey}\u0000${entry.source}`;
    const translations = previousBySemanticKey.get(semanticIdentity) ?? new Set<string>();
    translations.add(translated);
    previousBySemanticKey.set(semanticIdentity, translations);
  }
  const reusableById = new Map(
    entries.map((entry) => {
      const exact = exactById.get(entry.id);
      if (!entry.semanticKey) {
        return [entry.id, exact] as const;
      }

      const reviewedKey = REVIEWED_SHARED_NATIVE_MESSAGES.get(entry.source);
      const shared =
        sharedCatalog?.source.get(entry.semanticKey) === entry.source
          ? sharedCatalog.translations.get(locale)?.get(entry.semanticKey)
          : undefined;
      const validShared =
        shared?.trim() &&
        structuralTokenSignature(shared) === structuralTokenSignature(entry.source)
          ? shared
          : undefined;

      if (entry.semanticKey === reviewedKey && validShared) {
        return [entry.id, validShared] as const;
      }
      if (exact) {
        return [entry.id, exact] as const;
      }
      if (validShared) {
        return [entry.id, validShared] as const;
      }

      const existing = previousBySemanticKey.get(`${entry.semanticKey}\u0000${entry.source}`);
      const semanticTranslation = existing?.size === 1 ? [...existing][0] : undefined;
      return [entry.id, semanticTranslation] as const;
    }),
  );
  const glossaryChanged =
    previous.glossaryHash.length > 0 && previous.glossaryHash !== currentGlossaryHash;
  const pending = entries
    .filter((entry) => glossaryChanged || !reusableById.get(entry.id))
    .map((entry) => ({
      id: entry.id,
      source: entry.source,
      sourcePath: entry.path,
      semanticKey: entry.semanticKey,
      description:
        entry.description ??
        `${entry.surface === "apple" ? "Apple" : entry.surface === "android" ? "Android" : "Linux desktop"} ${entry.kind.replaceAll("-", " ")} in ${path.basename(entry.path)}`,
    }));
  const pendingBySemanticKey = new Map<string, typeof pending>();
  for (const entry of pending) {
    const semanticIdentity = entry.semanticKey
      ? `${entry.semanticKey}\u0000${entry.source}`
      : entry.id;
    const equivalents = pendingBySemanticKey.get(semanticIdentity) ?? [];
    equivalents.push(entry);
    pendingBySemanticKey.set(semanticIdentity, equivalents);
  }
  const representativeEntries = [...pendingBySemanticKey.values()].map((group) =>
    expectDefined(group[0], "native semantic translation representative"),
  );
  const representativeTranslations = representativeEntries.length
    ? await (options.translate ?? translateNativeEntries)(representativeEntries, locale, glossary)
    : new Map<string, string>();
  const translated = new Map<string, string>();
  for (const equivalents of pendingBySemanticKey.values()) {
    const representative = expectDefined(equivalents[0], "native semantic translation group");
    const value = representativeTranslations.get(representative.id);
    if (value !== undefined) {
      for (const entry of equivalents) {
        translated.set(entry.id, value);
      }
    }
  }
  const artifact: NativeTranslationArtifact = {
    version: 1,
    locale,
    glossaryHash: currentGlossaryHash,
    entries: entries.map((entry) => ({
      id: entry.id,
      source: entry.source,
      translated: translated.get(entry.id) ?? reusableById.get(entry.id) ?? entry.source,
    })),
  };
  try {
    validateNativeLocaleArtifact(locale, entries, artifact, glossary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structural = message.match(
      /translation changed structural tokens or line breaks for ([^\s]+)/u,
    );
    if (structural?.[1]) {
      throw new Error(
        `native translation changed placeholders or line breaks for ${locale}:${structural[1]}`,
        { cause: error },
      );
    }
    throw error;
  }
  const rendered = `${JSON.stringify(artifact, null, 2)}\n`;
  const changed = previousRaw !== rendered;
  if (changed) {
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, rendered, "utf8");
  }
  process.stdout.write(
    `native-app-i18n: locale=${locale} entries=${entries.length} translated=${translated.size} changed=${changed}\n`,
  );
  return { changed, translated: translated.size };
}

export function parseNativeI18nCommand(argv: string[]): NativeI18nCommand {
  const [command, ...args] = argv;
  if (command !== "baseline" && command !== "check" && command !== "sync" && command !== "verify") {
    throw new Error(
      "usage: node --import tsx scripts/native-app-i18n.ts baseline --write|check|sync [--write] [--locale <code>]|verify",
    );
  }
  let locale: string | undefined;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--write") {
      write = true;
      continue;
    }
    if (argument === "--locale") {
      if (locale) {
        throw new Error("native locale refresh accepts only one `--locale` value");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("native locale refresh requires a locale value after `--locale`");
      }
      locale = value;
      index += 1;
      continue;
    }
    throw new Error(`unsupported native i18n argument: ${argument}`);
  }
  if (locale) {
    if (command !== "sync" || !write) {
      throw new Error("native locale refresh requires `sync --write --locale <code>`");
    }
    if (!NATIVE_I18N_LOCALE_SET.has(locale)) {
      throw new Error(
        `unsupported native locale "${locale}". Expected one of: ${NATIVE_I18N_LOCALES.join(", ")}`,
      );
    }
  }
  if ((command === "check" || command === "verify") && write) {
    throw new Error(`native i18n ${command} does not accept \`--write\``);
  }
  if (command === "baseline" && !write) {
    throw new Error("native i18n baseline requires `--write`");
  }
  return { command, locale, write };
}

async function main() {
  const parsed = parseNativeI18nCommand(process.argv.slice(2));
  const entries = await syncNativeI18n({
    checkInventory:
      parsed.command === "check" || parsed.command === "verify" || parsed.locale !== undefined,
    checkLocales: parsed.command === "check",
    write:
      (parsed.command === "baseline" || parsed.command === "sync") &&
      parsed.write &&
      parsed.locale === undefined,
  });
  if (parsed.locale) {
    await syncNativeLocale(parsed.locale, entries);
  }
  if (parsed.command === "verify" || parsed.command === "check") {
    const android = await import("./android-app-i18n.ts");
    const apple = await import("./apple-app-i18n.ts");
    if (parsed.command === "verify") {
      await android.verifyAndroidAppI18n();
      await apple.verifyAppleAppI18n();
    } else {
      await android.checkAndroidAppI18n();
      await apple.checkAppleAppI18n();
    }
  }
  if (parsed.command === "sync" && parsed.write && !parsed.locale) {
    // The inventory and native/*.json feed the generated Android/Apple app
    // artifacts. Regenerate them once after a full sync; per-locale workers
    // only update their independent translation artifact so their patches can
    // be combined deterministically by the serialized finalizer.
    const [{ syncAndroidAppI18n }, { syncAppleAppI18n }] = await Promise.all([
      import("./android-app-i18n.ts"),
      import("./apple-app-i18n.ts"),
    ]);
    await syncAndroidAppI18n();
    const apple = await syncAppleAppI18n();
    process.stdout.write(
      `native-app-i18n: synced derived artifacts (android, Apple catalogs, ${apple.infoPlistFiles} InfoPlist files); contradictions=${apple.build.contradictions.length + apple.macosBuild.contradictions.length}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
