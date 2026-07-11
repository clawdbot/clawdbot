import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { translateNativeEntries } from "./control-ui-i18n.ts";

type NativeI18nSurface = "android" | "apple";

export const NATIVE_I18N_LOCALES = [
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "hi",
  "ar",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "vi",
  "nl",
  "fa",
  "ru",
  "sv",
] as const;

export type NativeI18nEntry = {
  id: string;
  kind: string;
  line: number;
  path: string;
  source: string;
  surface: NativeI18nSurface;
};

type Candidate = Omit<NativeI18nEntry, "id">;
type NativeTranslationArtifact = {
  entries: Array<{ id: string; source: string; translated: string }>;
  glossaryHash: string;
  locale: string;
  version: 1;
};
type NativeTranslator = typeof translateNativeEntries;
type NativeLocaleSyncOptions = {
  glossary?: Array<{ source: string; target: string }>;
  translate?: NativeTranslator;
  translationsDir?: string;
};
type NativeI18nCommand = {
  command: "check" | "sync";
  locale?: string;
  write: boolean;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUTPUT_PATH = path.join(ROOT, "apps", ".i18n", "native-source.json");
const TRANSLATIONS_DIR = path.join(ROOT, "apps", ".i18n", "native");
const SOURCE_ROOTS: Record<NativeI18nSurface, string[]> = {
  android: [path.join(ROOT, "apps", "android", "app", "src", "main")],
  apple: [
    path.join(ROOT, "apps", "ios"),
    path.join(ROOT, "apps", "macos", "Sources"),
    path.join(ROOT, "apps", "shared", "OpenClawKit", "Sources"),
  ],
};

const ANDROID_EXTENSIONS = new Set([".kt", ".kts"]);
const APPLE_EXTENSIONS = new Set([".swift", ".plist"]);
const NATIVE_FORMAT_RE = /%(?:\d+\$)?[@a-z]/giu;
const NATIVE_SOURCE_READ_CONCURRENCY = 32;
const APPLE_UI_MULTILINE_CALLS =
  /(?:Text|Label|Button|TextField|SecureField|Picker|Section|LabeledContent|Toggle|Menu|ShareLink|Link|TextEditor|ProgressView|Gauge|DisclosureGroup|ControlGroup|DatePicker|Stepper)\s*\(\s*"""([\s\S]*?)"""/gu;
const APPLE_LOCALIZED_STRING_CALLS =
  /\b(?:String\s*\(\s*localized:|LocalizedStringResource\s*\()\s*"((?:\\.|[^"\\])*)"/gu;
const APPLE_LOCALIZED_STRING_MULTILINE_CALLS =
  /\b(?:String\s*\(\s*localized:|LocalizedStringResource\s*\()\s*"""([\s\S]*?)"""/gu;
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
const CONDITIONAL_BRANCHES = [
  /\bif\s*\([^)]*\)\s*"((?:\\.|[^"\\])*)"\s*else\s*"((?:\\.|[^"\\])*)"/gu,
  /\?\s*"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/gu,
];
const UI_STRING_NAME_RE =
  /(?:title|subtitle|body|message|label|text|description|detail|prompt|placeholder|help)$/iu;
const APPLE_STRING_PROPERTY = /\bvar\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*String\s*\{/gu;
const APPLE_SWITCH_BRANCH =
  /(?:\bcase\b[^:\n]+|\bdefault)\s*:\s*(?:return\s+)?"((?:\\.|[^"\\])*)"/gu;
const ANDROID_STRING_FUNCTION =
  /\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*:\s*String\s*(=|\{)/gu;
const ANDROID_WHEN_BRANCH = /(?:[^\n{}]+|\belse)\s*->\s*"((?:\\.|[^"\\])*)"/gu;
const ANDROID_RESOURCE_STRINGS = /<string\b[^>]*>([\s\S]*?)<\/string>/gu;
const ANDROID_RESOURCE_COLLECTIONS =
  /<(?:string-array|plurals)\b[^>]*>([\s\S]*?)<\/(?:string-array|plurals)>/gu;
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
const APPLE_PLIST_STRINGS = /<string>([\s\S]*?)<\/string>/gu;
const GENERATED_PATH_RE = /(?:^|[\\/])(?:build|\.gradle|\.build|DerivedData)(?:$|[\\/])/u;
const EXCLUDED_PATH_RE = /(?:^|[\\/])(?:Tests?|UITests?|test|Preview(?:s)?)(?:$|[\\/])/u;
const EXCLUDED_FILE_RE = /(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u;
const BUILD_SETTING_RE = /\$\([A-Za-z0-9_.-]+\)/gu;
const NATIVE_I18N_LOCALE_SET = new Set<string>(NATIVE_I18N_LOCALES);

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

export function isConditionalBranchIdentifier(source: string): boolean {
  let index = 0;
  while (index < source.length && isAsciiLowercaseLetter(source[index])) {
    index += 1;
  }

  // Keep this scanner linear: PR-controlled native source passes through CI,
  // so a backtracking regex here can become a cheap native-i18n DoS trigger.
  if (index === 0 || index >= source.length || !isAsciiUppercaseLetter(source[index])) {
    return false;
  }

  for (index += 1; index < source.length; index += 1) {
    if (!isAsciiAlphaNumeric(source[index])) {
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

function extractKotlinStringLiterals(source: string, start: number, end: number) {
  const values: Array<{ offset: number; value: string }> = [];
  let cursor = start;
  while (cursor < end) {
    const openingQuote = source.indexOf('"', cursor);
    if (openingQuote < 0 || openingQuote >= end) {
      break;
    }
    const literal = readKotlinStringLiteral(source, openingQuote);
    if (!literal || literal.end > end) {
      break;
    }
    values.push({ offset: openingQuote, value: literal.value });
    cursor = literal.end;
  }
  return values;
}

function extractSwiftUiCalls(
  entries: Candidate[],
  repoPath: string,
  source: string,
  uiCallNames: ReadonlySet<string>,
) {
  for (const match of source.matchAll(APPLE_CALL_START)) {
    if (!match[1] || !uiCallNames.has(match[1])) {
      continue;
    }
    const offset = match.index ?? 0;
    let cursor = offset + match[0].length;
    const first = readSwiftStringLiteral(source, cursor);
    if (!first) {
      continue;
    }
    const values = [first.value];
    cursor = first.end;
    let unsupportedConcatenation = false;
    while (true) {
      const separator = source.slice(cursor).match(/^\s*\+\s*/u)?.[0];
      if (!separator) {
        break;
      }
      cursor += separator.length;
      const next = readSwiftStringLiteral(source, cursor);
      if (!next) {
        unsupportedConcatenation = true;
        break;
      }
      values.push(next.value);
      cursor = next.end;
    }
    if (!unsupportedConcatenation) {
      const kind = values.length > 1 ? "ui-call-concatenated" : "ui-call";
      addCandidate(entries, "apple", repoPath, values.join(""), kind, lineNumber(source, offset));
    }
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
  while (cursor >= 0 && (isAsciiAlphaNumeric(source[cursor]) || source[cursor] === "_")) {
    cursor -= 1;
  }
  const start = cursor + 1;
  if (
    start === end ||
    (!isAsciiLowercaseLetter(source[start]) &&
      !isAsciiUppercaseLetter(source[start]) &&
      source[start] !== "_")
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
  const nativeFormat = [...source.matchAll(NATIVE_FORMAT_RE)].map((match) => match[0]).toSorted();
  const buildSettings = (source.match(BUILD_SETTING_RE) ?? []).toSorted();
  const lineBreaks = (source.match(/\n/gu) ?? []).length;
  return JSON.stringify({ swift, kotlin, nativeFormat, buildSettings, lineBreaks });
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

function extractCandidates(
  surface: NativeI18nSurface,
  repoPath: string,
  source: string,
  uiCallNames: ReadonlySet<string>,
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
          ...CONDITIONAL_BRANCHES.map((pattern) => [pattern, "conditional-branch"] as const),
        ]
      : [
          [ANDROID_CALLS, "ui-call"],
          [ANDROID_TOAST_ARGS, "ui-toast"],
          [ANDROID_CHOOSER_ARGS, "ui-chooser"],
          [ANDROID_DIALOG_CALLS, "ui-dialog"],
          [ANDROID_UI_STATE_TEXT, "ui-state-text"],
          ...CONDITIONAL_BRANCHES.map((pattern) => [pattern, "conditional-branch"] as const),
        ];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const offset = match.index ?? 0;
      for (const value of match.slice(1)) {
        if (value) {
          addCandidate(entries, surface, repoPath, value, kind, lineNumber(source, offset));
        }
      }
    }
  }
  if (surface === "apple") {
    extractSwiftUiCalls(entries, repoPath, source, uiCallNames);
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
      for (const branch of body.matchAll(APPLE_SWITCH_BRANCH)) {
        if (branch[1]) {
          addCandidate(
            entries,
            surface,
            repoPath,
            branch[1],
            "conditional-branch",
            lineNumber(source, openingBrace + 1 + (branch.index ?? 0)),
          );
        }
      }
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
        addCandidate(
          entries,
          surface,
          repoPath,
          literal,
          multiline === undefined ? "ui-named-argument" : "ui-named-argument-multiline",
          lineNumber(source, match.index ?? 0),
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
        for (const returnLine of body.matchAll(/\breturn\b([^\n]*)/gu)) {
          const lineStart = bodyStart + (returnLine.index ?? 0);
          const lineEnd = lineStart + returnLine[0].length;
          for (const literal of extractKotlinStringLiterals(source, lineStart, lineEnd)) {
            addCandidate(
              entries,
              surface,
              repoPath,
              literal.value,
              "conditional-branch",
              lineNumber(source, literal.offset),
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
        for (const branch of body.matchAll(ANDROID_WHEN_BRANCH)) {
          if (!branch[1]) {
            continue;
          }
          addCandidate(
            entries,
            surface,
            repoPath,
            branch[1],
            "conditional-branch",
            lineNumber(source, openingBrace + 1 + (branch.index ?? 0)),
          );
        }
        continue;
      }
      const expressionLine = expression.split("\n", 1)[0] ?? "";
      for (const literal of extractKotlinStringLiterals(
        source,
        bodyStart,
        bodyStart + expressionLine.length,
      )) {
        addCandidate(
          entries,
          surface,
          repoPath,
          literal.value,
          "conditional-branch",
          lineNumber(source, literal.offset),
        );
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
      addCandidate(
        entries,
        surface,
        repoPath,
        match[2],
        "ui-named-argument",
        lineNumber(source, match.index ?? 0),
      );
    }
  }
  if (surface === "android" && /\/res\/values\/[^/]+\.xml$/u.test(repoPath)) {
    for (const match of source.matchAll(ANDROID_RESOURCE_STRINGS)) {
      if (match[1]) {
        addCandidate(
          entries,
          surface,
          repoPath,
          match[1],
          "resource-string",
          lineNumber(source, match.index ?? 0),
        );
      }
    }
    for (const collection of source.matchAll(ANDROID_RESOURCE_COLLECTIONS)) {
      const body = collection[1];
      if (!body) {
        continue;
      }
      const bodyOffset = (collection.index ?? 0) + collection[0].indexOf(body);
      for (const item of body.matchAll(ANDROID_RESOURCE_ITEMS)) {
        if (item[1]) {
          addCandidate(
            entries,
            surface,
            repoPath,
            item[1],
            "resource-item",
            lineNumber(source, bodyOffset + (item.index ?? 0)),
          );
        }
      }
    }
  }
  if (surface === "apple" && repoPath.endsWith(".plist")) {
    for (const match of source.matchAll(APPLE_PLIST_STRINGS)) {
      if (match[1]) {
        addCandidate(
          entries,
          surface,
          repoPath,
          match[1],
          "plist-string",
          lineNumber(source, match.index ?? 0),
        );
      }
    }
  }
  return entries;
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
        !EXCLUDED_FILE_RE.test(entry.name)
        ? [fullPath]
        : [];
    }),
  );
  return nested.flat();
}

function nativeEntryIdentity(entry: Pick<NativeI18nEntry, "path" | "source" | "surface">): string {
  return [entry.surface, entry.path, entry.source].join("\u0000");
}

export function assignNativeI18nIds(
  entries: readonly Candidate[],
  previousEntries: readonly NativeI18nEntry[] = [],
): NativeI18nEntry[] {
  const seen = new Set<string>();
  const previousIds = new Map(
    previousEntries.map((entry) => [nativeEntryIdentity(entry), entry.id]),
  );
  const unique = [...new Map(entries.map((entry) => [nativeEntryIdentity(entry), entry])).values()];
  return unique
    .toSorted(
      (left, right) =>
        compareCodePoints(left.surface, right.surface) ||
        compareCodePoints(left.path, right.path) ||
        left.line - right.line ||
        compareCodePoints(left.kind, right.kind) ||
        compareCodePoints(left.source, right.source),
    )
    .map((entry) => {
      const identity = nativeEntryIdentity(entry);
      const previousId = previousIds.get(identity);
      const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
      const baseId = `native.${entry.surface}.${digest}`;
      let id = previousId && !seen.has(previousId) ? previousId : baseId;
      for (let suffix = 2; seen.has(id); suffix += 1) {
        id = `${baseId}.${suffix}`;
      }
      seen.add(id);
      return Object.assign(entry, { id });
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) {
          return;
        }
        results[index] = await run(values[index]);
      }
    }),
  );
  return results;
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
  const sources = await mapWithConcurrency(
    filesByRoot.flatMap(({ files, surface }) => files.map((filePath) => ({ filePath, surface }))),
    NATIVE_SOURCE_READ_CONCURRENCY,
    async ({ filePath, surface }) => ({
      repoPath: path.relative(ROOT, filePath).split(path.sep).join("/"),
      source: await readFile(filePath, "utf8"),
      surface,
    }),
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
    extractCandidates(surface, repoPath, source, uiCallNames),
  );
  return assignNativeI18nIds(entries, stableEntries);
}

function render(entries: NativeI18nEntry[]): string {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

async function syncNativeI18n(options: {
  checkOnly: boolean;
  write: boolean;
}): Promise<NativeI18nEntry[]> {
  const currentInventory = await readNativeI18nInventory();
  const entries = await collectNativeI18nEntries(currentInventory.entries);
  const expected = render(entries);
  const current = currentInventory.raw;
  if (current !== expected && options.checkOnly) {
    throw new Error(
      "native app i18n inventory drift detected. Run `pnpm native:i18n:sync` and commit apps/.i18n/native-source.json.",
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

export async function syncNativeLocale(
  locale: string,
  entries: NativeI18nEntry[],
  options: NativeLocaleSyncOptions = {},
) {
  // Native runtime resources are owned by the Android and Apple slices; these
  // artifacts keep the shared translation-memory handoff current between them.
  const artifactPath = path.join(options.translationsDir ?? TRANSLATIONS_DIR, `${locale}.json`);
  const glossary = options.glossary ?? (await loadGlossary(locale));
  const glossaryHash = createHash("sha256").update(JSON.stringify(glossary)).digest("hex");
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
  const previousById = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const glossaryChanged = previous.glossaryHash !== glossaryHash;
  const pending = entries
    .filter((entry) => {
      const current = previousById.get(entry.id);
      return (
        glossaryChanged || !current || current.source !== entry.source || !current.translated.trim()
      );
    })
    .map((entry) => ({
      id: entry.id,
      source: entry.source,
      sourcePath: entry.path,
    }));
  const translated = pending.length
    ? await (options.translate ?? translateNativeEntries)(pending, locale, glossary)
    : new Map<string, string>();
  const artifact: NativeTranslationArtifact = {
    version: 1,
    locale,
    glossaryHash,
    entries: entries.map((entry) => ({
      id: entry.id,
      source: entry.source,
      translated:
        translated.get(entry.id) ?? previousById.get(entry.id)?.translated ?? entry.source,
    })),
  };
  for (const entry of artifact.entries) {
    if (structuralTokenSignature(entry.source) !== structuralTokenSignature(entry.translated)) {
      throw new Error(
        `native translation changed placeholders or line breaks for ${locale}:${entry.id}`,
      );
    }
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
  if (command !== "check" && command !== "sync") {
    throw new Error(
      "usage: node --import tsx scripts/native-app-i18n.ts check|sync [--write] [--locale <code>]",
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
  if (command === "check" && write) {
    throw new Error("native i18n check does not accept `--write`");
  }
  return { command, locale, write };
}

async function main() {
  const parsed = parseNativeI18nCommand(process.argv.slice(2));
  const entries = await syncNativeI18n({
    checkOnly: parsed.command === "check",
    write: parsed.command === "sync" && parsed.write,
  });
  if (parsed.locale) {
    await syncNativeLocale(parsed.locale, entries);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
