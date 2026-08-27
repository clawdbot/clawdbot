#!/usr/bin/env node

// Guards gateway -> mobile-client event coverage drift.
//
// Source of truth for server->client event names is GATEWAY_EVENTS in
// src/gateway/server-methods-list.ts (the catalog advertised to clients in
// hello-ok `features.events`). packages/gateway-protocol only types the event
// frame envelope (`event: NonEmptyString`), so the gateway catalog is the most
// canonical single list of wire event names.
//
// Client "handled" sets are extracted with deliberately simple parsing over
// the mobile app sources: Swift `switch <x>.event { case "..." }` blocks plus
// `.event == "..."` comparisons, and Kotlin `when (event) { "..." -> }` blocks
// plus `event == "..."` comparisons scoped to `fun handle*Event(...)` bodies.
// Swift case labels may use qualified static string constants; those are
// resolved across the scanned source tree. Kotlin labels and comparisons may
// likewise use generated enum `rawValue` constants. Events a client
// intentionally does not consume live in scripts/protocol-event-coverage.allowlist.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Dependency-light seam by design: preflight runs this script without
// installed dependencies (the dependency-free manifest contract), so the
// canonical @openclaw/normalization-core import cannot resolve here.
import { isRecord } from "./lib/record-shared.mjs";

const GATEWAY_EVENTS_FILE = "src/gateway/server-methods-list.ts";
const GATEWAY_EVENT_CONSTANTS_FILE = "src/gateway/events.ts";
const ALLOWLIST_FILE = "scripts/protocol-event-coverage.allowlist.json";

// Scan roots per client. The sentinel files are the primary event dispatch
// surfaces; if one moves, the check must fail loudly instead of silently
// passing with an empty handled set. Apple event mapping is shared by iOS and
// macOS, so the iOS coverage owner lives in OpenClawChatUI.
const IOS_SCAN_ROOTS = ["apps/ios/Sources", "apps/shared/OpenClawKit/Sources"];
const IOS_SENTINEL_FILE =
  "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatGatewayPayloadCodec.swift";
const ANDROID_SCAN_ROOT = "apps/android/app/src/main/java/ai/openclaw/app";
const ANDROID_SENTINEL_FILES = [
  "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt",
  "apps/android/app/src/main/java/ai/openclaw/app/chat/ChatController.kt",
];

// Minimum plausible catalog size; a partial parse below this means the
// GATEWAY_EVENTS array changed shape and the extractor needs updating.
const MIN_EXPECTED_GATEWAY_EVENTS = 10;

const GATEWAY_EVENTS_BLOCK_RE = /export const GATEWAY_EVENTS = \[([\s\S]*?)\];/u;
const SWIFT_EVENT_SWITCH_RE = /\bswitch\s+\w+(?:\.\w+)*\.event\s*\{/u;
const SWIFT_CASE_LABEL_RE = /^\s*case\s+(.+?):/u;
const SWIFT_TYPE_DECLARATION_RE =
  /^\s*(?:(?:private|fileprivate|internal|public)\s+)?(?:enum|struct|class|actor|extension)\s+([A-Za-z_]\w*)[^{]*\x7b/u;
const SWIFT_STATIC_STRING_CONSTANT_RE = /^\s*static\s+let\s+([A-Za-z_]\w*)\s*=\s*"([^"]+)"/u;
const SWIFT_QUALIFIED_CONSTANT_RE = /\b([A-Za-z_]\w*\.[A-Za-z_]\w*)\b/gu;
const KOTLIN_EVENT_WHEN_RE = /\bwhen\s*\(\s*event\s*\)\s*\{/u;
// Kotlin gateway handlers follow the `handle*Event` naming convention
// (handleEvent, handleGatewayEvent, handleExecApprovalGatewayEvent, ...).
// Handlers named differently surface as loud "unhandled" failures, which is
// the safe direction for a coverage gate.
const KOTLIN_HANDLER_FUN_RE = /\bfun\s+handle\w*Event\s*\(/u;
const KOTLIN_CASE_SEGMENT_RE = /^\s*(.+?)\s*->/u;
const KOTLIN_ENUM_DECLARATION_RE = /^\s*enum\s+class\s+([A-Za-z_]\w*)\s*\(/u;
const KOTLIN_ENUM_STRING_ENTRY_RE = /^\s*([A-Za-z_]\w*)\s*\(\s*"([^"]+)"\s*\)\s*,?/u;
const KOTLIN_STRING_CASE_EXPRESSION_RE = /^"([^"]+)"$/u;
const KOTLIN_RAW_VALUE_EXPRESSION_RE = /^([A-Za-z_]\w*\.[A-Za-z_]\w*)\.rawValue$/u;
const SWIFT_EVENT_COMPARISON_RE = /\.event\s*==\s*"([^"]+)"/gu;
const KOTLIN_EVENT_COMPARISON_RE = /\bevent\s*==\s*"([^"]+)"(?!\s*(?:\.|\?\.|\+|\[|\())/gu;
const KOTLIN_EVENT_CONSTANT_COMPARISON_RE =
  /\bevent\s*==\s*([A-Za-z_]\w*\.[A-Za-z_]\w*)\.rawValue\b(?!\s*(?:\.|\?\.|\+|\[|\())/gu;
const STRING_LITERAL_RE = /"([^"]+)"/gu;

type StringConstants = ReadonlyMap<string, string>;
type FsImpl = Pick<typeof fs, "existsSync" | "readFileSync" | "readdirSync">;
type CoverageParams = {
  client: string;
  serverEvents: string[];
  handledEvents: Set<string>;
  allowlist: Record<string, unknown>;
};
type ClientCollectionParams = {
  rootDir: string;
  roots: string[];
  extension: string;
  extract: (source: string, context?: StringConstants) => Set<string>;
  buildExtractContext?: (sources: Iterable<string>) => StringConstants;
  sentinels: string[];
  fsImpl: FsImpl;
};
type KotlinLexicalContext =
  | { type: "code"; templateDepth: number | null }
  | { type: "raw" }
  | { type: "quoted" }
  | { type: "char" };

function requiredCapture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Expected regular expression capture group ${index}.`);
  }
  return value;
}

function isMainModule(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

/**
 * Extracts the gateway event name list from server-methods-list.ts source.
 * Bare identifiers in the array (e.g. GATEWAY_EVENT_UPDATE_AVAILABLE) are
 * resolved against constantsSource (src/gateway/events.ts).
 */
export function extractGatewayEventNames(listSource: string, constantsSource: string): string[] {
  const block = GATEWAY_EVENTS_BLOCK_RE.exec(listSource);
  if (!block) {
    throw new Error(
      `Could not find the GATEWAY_EVENTS array in ${GATEWAY_EVENTS_FILE}. ` +
        "If the catalog moved, update scripts/check-protocol-event-coverage.mjs.",
    );
  }
  const body = requiredCapture(block, 1)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  const names: string[] = [];
  for (const token of body.matchAll(/"([^"]+)"|([A-Za-z_$][\w$]*)/gu)) {
    if (token[1]) {
      names.push(token[1]);
      continue;
    }
    const identifier = requiredCapture(token, 2);
    const constant = new RegExp(`export const ${identifier} = "([^"]+)"`, "u").exec(
      constantsSource,
    );
    if (!constant) {
      throw new Error(
        `Could not resolve GATEWAY_EVENTS identifier "${identifier}" from ${GATEWAY_EVENT_CONSTANTS_FILE}.`,
      );
    }
    names.push(requiredCapture(constant, 1));
  }
  if (names.length < MIN_EXPECTED_GATEWAY_EVENTS) {
    throw new Error(
      `Extracted only ${names.length} gateway events from ${GATEWAY_EVENTS_FILE}; ` +
        "the array shape likely changed. Update the extractor.",
    );
  }
  return names;
}

// Neutralizes string literals and line comments so brace counting cannot be
// confused by braces inside strings or comments.
function sanitizeLineForBraces(line: string): string {
  return line
    .replace(/\\"/gu, "")
    .replace(/"[^"]*"/gu, '""')
    .replace(/\/\/.*$/u, "");
}

// Collects case-label lines at depth 1 of blocks whose header matches
// headerRe, feeding each into extractLabels. Line-based on purpose: this is a
// drift check, not a parser; sources keep one case label per line.
function collectBlockCaseLabels(
  source: string,
  headerRe: RegExp,
  extractLabels: (line: string, sink: string[]) => void,
): string[] {
  const names: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const headerLine = lines[i];
    if (headerLine === undefined || !headerRe.test(headerLine)) {
      continue;
    }
    let depth = 0;
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j];
      if (line === undefined) {
        break;
      }
      if (depth === 1) {
        extractLabels(line, names);
      }
      const braceSource =
        j === i
          ? sanitizeLineForBraces(line.slice(line.indexOf("{")))
          : sanitizeLineForBraces(line);
      for (const char of braceSource) {
        if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
        }
      }
      if (j > i && depth <= 0) {
        break;
      }
    }
  }
  return names;
}

function pushStringLiterals(segment: string, names: string[]): void {
  for (const literal of segment.matchAll(STRING_LITERAL_RE)) {
    names.push(requiredCapture(literal, 1));
  }
}

function stripKotlinComments(source: string): string {
  let output = "";
  let index = 0;
  let blockDepth = 0;
  let lineComment = false;
  const contexts: KotlinLexicalContext[] = [{ type: "code", templateDepth: null }];

  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    const triple = source.slice(index, index + 3);
    const context = contexts.at(-1);
    if (!context) {
      throw new Error("Kotlin lexical context stack became empty");
    }

    if (lineComment) {
      output += char === "\n" ? "\n" : " ";
      lineComment = char !== "\n";
      index += 1;
      continue;
    }

    if (blockDepth > 0) {
      if (pair === "/*") {
        output += "  ";
        blockDepth += 1;
        index += 2;
        continue;
      }
      if (pair === "*/") {
        output += "  ";
        blockDepth -= 1;
        index += 2;
        continue;
      }
      output += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (context.type === "raw") {
      if (triple === '"""') {
        output += triple;
        contexts.pop();
        index += 3;
      } else if (pair === "${") {
        output += pair;
        contexts.push({ type: "code", templateDepth: 1 });
        index += 2;
      } else {
        output += char;
        index += 1;
      }
      continue;
    }

    if (context.type === "quoted" || context.type === "char") {
      output += char;
      if (char === "\\" && index + 1 < source.length) {
        output += source[index + 1];
        index += 2;
        continue;
      }
      if (context.type === "quoted" && pair === "${") {
        output += source[index + 1];
        contexts.push({ type: "code", templateDepth: 1 });
        index += 2;
        continue;
      }
      const delimiter = context.type === "quoted" ? '"' : "'";
      if (char === delimiter) {
        contexts.pop();
      }
      index += 1;
      continue;
    }

    if (pair === "//") {
      output += "  ";
      lineComment = true;
      index += 2;
      continue;
    }
    if (pair === "/*") {
      output += "  ";
      blockDepth = 1;
      index += 2;
      continue;
    }
    if (triple === '"""') {
      output += triple;
      contexts.push({ type: "raw" });
      index += 3;
      continue;
    }
    if (char === '"') {
      output += char;
      contexts.push({ type: "quoted" });
      index += 1;
      continue;
    }
    if (char === "'") {
      output += char;
      contexts.push({ type: "char" });
      index += 1;
      continue;
    }
    if (context.templateDepth !== null) {
      if (char === "{") {
        context.templateDepth += 1;
      } else if (char === "}") {
        context.templateDepth -= 1;
        if (context.templateDepth === 0) {
          contexts.pop();
        }
      }
    }
    output += char;
    index += 1;
  }

  return output;
}

/**
 * Extracts qualified static string constants declared at Swift type scope.
 * Type qualification avoids resolving unrelated constants that share a short
 * member name elsewhere in the app.
 */
export function extractSwiftStaticStringConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const declarationLine = lines[i];
    if (declarationLine === undefined) {
      continue;
    }
    const declaration = SWIFT_TYPE_DECLARATION_RE.exec(declarationLine);
    if (!declaration) {
      continue;
    }
    const typeName = requiredCapture(declaration, 1);
    let depth = 0;
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j];
      if (line === undefined) {
        break;
      }
      if (depth === 1) {
        const constant = SWIFT_STATIC_STRING_CONSTANT_RE.exec(line);
        if (constant) {
          constants.set(
            `${typeName}.${requiredCapture(constant, 1)}`,
            requiredCapture(constant, 2),
          );
        }
      }
      const braceSource = sanitizeLineForBraces(line);
      for (const char of braceSource) {
        if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
        }
      }
      if (j > i && depth <= 0) {
        break;
      }
    }
  }
  return constants;
}

/** Extracts generated Kotlin enum entries whose constructor stores a wire string. */
export function extractKotlinEnumStringConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const lines = stripKotlinComments(source).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const declarationLine = lines[i];
    if (declarationLine === undefined) {
      continue;
    }
    const declaration = KOTLIN_ENUM_DECLARATION_RE.exec(declarationLine);
    if (!declaration) {
      continue;
    }
    const typeName = requiredCapture(declaration, 1);
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j];
      if (line === undefined) {
        break;
      }
      if (opened && depth === 1) {
        const entry = KOTLIN_ENUM_STRING_ENTRY_RE.exec(line);
        if (entry) {
          constants.set(`${typeName}.${requiredCapture(entry, 1)}`, requiredCapture(entry, 2));
        }
      }
      const sanitized = sanitizeLineForBraces(line);
      for (const char of sanitized) {
        if (char === "{") {
          depth += 1;
          opened = true;
        } else if (char === "}") {
          depth -= 1;
        }
      }
      if (opened && depth <= 0) {
        break;
      }
    }
  }
  return constants;
}

/** Extracts Swift gateway-event case labels, including qualified constants. */
export function extractSwiftHandledEvents(
  source: string,
  constants: StringConstants = new Map(),
): Set<string> {
  const names = collectBlockCaseLabels(source, SWIFT_EVENT_SWITCH_RE, (line, sink) => {
    const label = SWIFT_CASE_LABEL_RE.exec(line);
    if (label) {
      const labelSource = requiredCapture(label, 1);
      pushStringLiterals(labelSource, sink);
      const constantReferences = sanitizeLineForBraces(labelSource);
      for (const reference of constantReferences.matchAll(SWIFT_QUALIFIED_CONSTANT_RE)) {
        const value = constants.get(requiredCapture(reference, 1));
        if (value) {
          sink.push(value);
        }
      }
    }
  });
  for (const comparison of source.matchAll(SWIFT_EVENT_COMPARISON_RE)) {
    names.push(requiredCapture(comparison, 1));
  }
  return new Set(names);
}

// Collects the bodies of Kotlin gateway event handler functions
// (`fun handle*Event(...)`). Signatures may span multiple lines, so scan
// forward from the declaration to the first `{` before brace counting.
function extractKotlinHandlerBodies(source: string): string[] {
  const bodies: string[] = [];
  const lines = source.split("\n");
  const uncommentedLines = stripKotlinComments(source).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const handlerLine = uncommentedLines[i];
    if (handlerLine === undefined || !KOTLIN_HANDLER_FUN_RE.test(handlerLine)) {
      continue;
    }
    let depth = 0;
    let opened = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j];
      const uncommentedLine = uncommentedLines[j];
      if (line === undefined || uncommentedLine === undefined) {
        break;
      }
      const sanitized = sanitizeLineForBraces(uncommentedLine);
      if (opened) {
        body.push(line);
      }
      for (const char of sanitized) {
        if (char === "{") {
          depth += 1;
          opened = true;
        } else if (char === "}") {
          depth -= 1;
        }
      }
      if (opened && depth <= 0) {
        break;
      }
    }
    if (opened) {
      bodies.push(body.join("\n"));
    }
  }
  return bodies;
}

/**
 * Extracts event names a Kotlin source handles: string-literal case labels of
 * `when (event)` blocks plus `event == "..."` comparisons, both scoped to
 * `fun handle*Event(...)` bodies. Scoping matters: bare `event == "..."`
 * literals also appear in predicate helpers that are not called from the
 * dispatch path (e.g. gatewayEventInvalidatesNodesDevices in NodeRuntime.kt),
 * and counting those would silently mark events as covered. Swift extraction
 * stays tree-wide because Swift consumption always reads `.event` off a
 * received EventFrame, which does not have that false-positive shape.
 */
export function extractKotlinHandledEvents(
  source: string,
  constants: StringConstants = new Map(),
): Set<string> {
  const names: string[] = [];
  for (const body of extractKotlinHandlerBodies(source)) {
    const uncommentedBody = stripKotlinComments(body);
    names.push(
      ...collectBlockCaseLabels(uncommentedBody, KOTLIN_EVENT_WHEN_RE, (line, sink) => {
        const segment = KOTLIN_CASE_SEGMENT_RE.exec(line)?.[1];
        if (!segment) {
          return;
        }
        for (const expression of segment.split(",").map((value) => value.trim())) {
          const literal = KOTLIN_STRING_CASE_EXPRESSION_RE.exec(expression);
          if (literal) {
            sink.push(requiredCapture(literal, 1));
            continue;
          }
          const reference = KOTLIN_RAW_VALUE_EXPRESSION_RE.exec(expression)?.[1];
          const value = reference ? constants.get(reference) : undefined;
          if (value) {
            sink.push(value);
          }
        }
      }),
    );
    for (const comparison of uncommentedBody.matchAll(KOTLIN_EVENT_COMPARISON_RE)) {
      names.push(requiredCapture(comparison, 1));
    }
    for (const comparison of uncommentedBody.matchAll(KOTLIN_EVENT_CONSTANT_COMPARISON_RE)) {
      const value = constants.get(requiredCapture(comparison, 1));
      if (value) {
        names.push(value);
      }
    }
  }
  return new Set(names);
}

/**
 * Compares a client's handled events against the gateway catalog and its
 * allowlist. Returns human-readable error strings. Client-only names (e.g. the
 * client-synthesized "seqGap" pseudo-event) are intentionally ignored; this
 * check only guards the server->client direction.
 */
export function compareEventCoverage(params: CoverageParams): string[] {
  const { client, serverEvents, handledEvents, allowlist } = params;
  const errors: string[] = [];
  const serverSet = new Set(serverEvents);
  for (const event of serverEvents) {
    if (handledEvents.has(event) || event in allowlist) {
      continue;
    }
    errors.push(
      `[${client}] gateway event "${event}" has no handler and no allowlist entry. ` +
        `Handle it in the ${client} app or add it to ${ALLOWLIST_FILE} with a reason.`,
    );
  }
  for (const [event, reason] of Object.entries(allowlist)) {
    if (typeof reason !== "string" || reason.trim() === "") {
      errors.push(`[${client}] allowlist entry "${event}" needs a non-empty reason string.`);
    }
    if (!serverSet.has(event)) {
      errors.push(
        `[${client}] allowlist entry "${event}" is not a gateway event anymore; remove it from ${ALLOWLIST_FILE}.`,
      );
    } else if (handledEvents.has(event)) {
      errors.push(
        `[${client}] allowlist entry "${event}" is now handled; remove it from ${ALLOWLIST_FILE}.`,
      );
    }
  }
  return errors;
}

function listFilesRecursive(rootDir: string, extension: string, fsImpl: FsImpl): string[] {
  const files: string[] = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = fsImpl.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Test sources match the same event literals but are not product
        // handlers; including them would mask real coverage gaps.
        if (entry.name === "Tests" || entry.name === ".build" || entry.name === "build") {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(fullPath);
      }
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function readRequiredFile(rootDir: string, relativePath: string, fsImpl: FsImpl): string {
  const fullPath = path.resolve(rootDir, relativePath);
  try {
    return fsImpl.readFileSync(fullPath, "utf8");
  } catch {
    throw new Error(
      `Required file ${relativePath} is missing. If it moved, update scripts/check-protocol-event-coverage.mjs.`,
    );
  }
}

function loadAllowlist(rootDir: string, fsImpl: FsImpl) {
  const raw = readRequiredFile(rootDir, ALLOWLIST_FILE, fsImpl);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${ALLOWLIST_FILE} is not valid JSON: ${String(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${ALLOWLIST_FILE} must contain a JSON object.`);
  }
  const readClientAllowlist = (client: string) => {
    const entries = parsed[client];
    if (!isRecord(entries)) {
      throw new Error(`${ALLOWLIST_FILE} must contain an object entry for "${client}".`);
    }
    return entries;
  };
  return { ios: readClientAllowlist("ios"), android: readClientAllowlist("android") };
}

function collectClientHandledEvents(params: ClientCollectionParams): Set<string> {
  const { rootDir, roots, extension, extract, buildExtractContext, sentinels, fsImpl } = params;
  const handled = new Set<string>();
  const sources = new Map<string, string>();
  for (const root of roots) {
    const rootPath = path.resolve(rootDir, root);
    if (!fsImpl.existsSync(rootPath)) {
      throw new Error(
        `Scan root ${root} is missing. If it moved, update scripts/check-protocol-event-coverage.mjs.`,
      );
    }
    for (const filePath of listFilesRecursive(rootPath, extension, fsImpl)) {
      sources.set(filePath, fsImpl.readFileSync(filePath, "utf8"));
    }
  }
  const extractContext = buildExtractContext?.(sources.values());
  for (const source of sources.values()) {
    for (const event of extract(source, extractContext)) {
      handled.add(event);
    }
  }
  for (const sentinel of sentinels) {
    const source = readRequiredFile(rootDir, sentinel, fsImpl);
    if (extract(source, extractContext).size === 0) {
      throw new Error(
        `Sentinel dispatch file ${sentinel} no longer matches any event names; ` +
          "its event handling likely moved or changed shape. Update scripts/check-protocol-event-coverage.mjs.",
      );
    }
  }
  return handled;
}

function collectStringConstants(sources: Iterable<string>, language: "Swift" | "Kotlin") {
  const extract =
    language === "Swift" ? extractSwiftStaticStringConstants : extractKotlinEnumStringConstants;
  const constants = new Map<string, string>();
  for (const source of sources) {
    for (const [name, value] of extract(source)) {
      const existing = constants.get(name);
      if (existing !== undefined && existing !== value) {
        const kind = language === "Swift" ? "string constant" : "enum string";
        throw new Error(`Conflicting ${language} ${kind} values for ${name}.`);
      }
      constants.set(name, value);
    }
  }
  return constants;
}

/**
 * Runs the full coverage check against a repo checkout and returns error
 * strings plus a summary for logging.
 */
function collectProtocolEventCoverageErrors(params: { rootDir?: string; fs?: FsImpl } = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;

  const serverEvents = extractGatewayEventNames(
    readRequiredFile(rootDir, GATEWAY_EVENTS_FILE, fsImpl),
    readRequiredFile(rootDir, GATEWAY_EVENT_CONSTANTS_FILE, fsImpl),
  );
  const allowlist = loadAllowlist(rootDir, fsImpl);
  const clients = [
    {
      client: "ios" satisfies keyof typeof allowlist,
      handledEvents: collectClientHandledEvents({
        rootDir,
        roots: IOS_SCAN_ROOTS,
        extension: ".swift",
        extract: extractSwiftHandledEvents,
        buildExtractContext: (sources) => collectStringConstants(sources, "Swift"),
        sentinels: [IOS_SENTINEL_FILE],
        fsImpl,
      }),
    },
    {
      client: "android" satisfies keyof typeof allowlist,
      handledEvents: collectClientHandledEvents({
        rootDir,
        roots: [ANDROID_SCAN_ROOT],
        extension: ".kt",
        extract: extractKotlinHandledEvents,
        buildExtractContext: (sources) => collectStringConstants(sources, "Kotlin"),
        sentinels: ANDROID_SENTINEL_FILES,
        fsImpl,
      }),
    },
  ] as const;

  const errors: string[] = [];
  const summaryParts: string[] = [];
  for (const { client, handledEvents } of clients) {
    errors.push(
      ...compareEventCoverage({
        client,
        serverEvents,
        handledEvents,
        allowlist: allowlist[client],
      }),
    );
    const handledCount = serverEvents.filter((event) => handledEvents.has(event)).length;
    summaryParts.push(
      `${client} handles ${handledCount}, allowlists ${Object.keys(allowlist[client]).length}`,
    );
  }
  return {
    errors,
    summary: `${serverEvents.length} gateway events; ${summaryParts.join("; ")}.`,
  };
}

if (isMainModule()) {
  let result;
  try {
    result = collectProtocolEventCoverageErrors();
  } catch (error) {
    console.error(
      `Protocol event coverage check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  if (result.errors.length > 0) {
    console.error("Protocol event coverage check failed:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log(`Protocol event coverage OK: ${result.summary}`);
}
