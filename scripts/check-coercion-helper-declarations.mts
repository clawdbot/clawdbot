#!/usr/bin/env node

// Prevents local primitive-coercion helpers from regrowing after consolidation.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isCodeFile, listRepoFilesSync } from "./check-file-utils.js";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { toLine, unwrapExpression } from "./lib/ts-guard-utils.mts";

const ABSOLUTE_LEGACY_COERCION_HELPER_NAMES = [
  "asObject",
  "asString",
  "normalizeString",
  "optionalString",
  "readBoolean",
  "readNumber",
  "readOptionalString",
  "readString",
  "timestampMs",
] as const;

export type CoercionHelperDeclarationKind =
  | "field"
  | "function"
  | "method"
  | "property"
  | "variable";

export const CANONICAL_COERCION_HELPER_OWNERS = [
  {
    file: "packages/normalization-core/src/string-coerce.ts",
    kind: "function",
    names: [
      "lowercasePreservingWhitespace",
      "localeLowercasePreservingWhitespace",
      "normalizeBoundedOptionalString",
      "normalizeFastMode",
      "normalizeNullableString",
      "normalizeOptionalLowercaseString",
      "normalizeOptionalString",
      "normalizeOptionalStringifiedId",
      "normalizeStringifiedEntries",
      "readNonBlankString",
      "readNonEmptyStringPreservingWhitespace",
      "readStringValue",
      "resolvePrimaryStringValue",
    ],
  },
  {
    file: "packages/normalization-core/src/string-normalization.ts",
    kind: "function",
    names: ["filterStringEntries"],
  },
  {
    file: "packages/normalization-core/src/number-coercion.ts",
    kind: "function",
    names: [
      "addTimerTimeoutGraceMs",
      "asDateTimestampMs",
      "asFiniteNumber",
      "asFiniteNumberInRange",
      "asNonNegativeFiniteNumber",
      "asPositiveFiniteNumber",
      "asPositiveSafeInteger",
      "asSafeIntegerInRange",
      "clampPositiveTimerTimeoutMs",
      "finiteSecondsToTimerSafeMilliseconds",
      "isFutureDateTimestampMs",
      "nonNegativeSecondsToSafeMilliseconds",
      "parseDateFirstTimestampMs",
      "parseDateStringTimestampMs",
      "parseFiniteNumber",
      "parseStrictFiniteNumber",
      "parseStrictInteger",
      "parseStrictNonNegativeInteger",
      "positiveSecondsToSafeMilliseconds",
      "resolveDateTimestampMs",
      "resolveExpiresAtMsFromDurationMs",
      "resolveExpiresAtMsFromDurationOrEpoch",
      "resolveExpiresAtMsFromDurationSeconds",
      "resolveExpiresAtMsFromEpochSeconds",
      "resolveIntegerOption",
      "resolveNonNegativeIntegerOption",
      "resolveOptionalIntegerOption",
      "resolvePositiveTimerTimeoutMs",
      "resolveTimestampMsToIsoString",
      "timestampMsToIsoFileStamp",
      "timestampMsToIsoString",
    ],
  },
  {
    file: "packages/normalization-core/src/record-coerce.ts",
    kind: "function",
    names: [
      "asNonArrayRecord",
      "asNullableObjectRecord",
      "asNullableRecord",
      "asOptionalObjectRecord",
      "asOptionalRecord",
      "asRecord",
      "filterStringRecord",
      "isRecord",
      "isStringRecord",
      "readStringField",
    ],
  },
  {
    file: "packages/normalization-core/src/json-coercion.ts",
    kind: "function",
    names: ["safeParseJsonRecord"],
  },
  {
    file: "packages/normalization-core/src/error-coercion.ts",
    kind: "function",
    names: ["coerceErrorMessage", "stringifyNonErrorCause", "toErrorObject", "toStringifiedError"],
  },
  {
    file: "scripts/lib/error-format.mts",
    kind: "function",
    names: ["coerceErrorMessage", "toErrorObject"],
  },
  {
    file: "src/utils/boolean.ts",
    kind: "function",
    names: ["parseBooleanValue"],
  },
] as const satisfies readonly {
  file: string;
  kind: CoercionHelperDeclarationKind;
  names: readonly string[];
}[];

const EXCEPTIONAL_COERCION_HELPER_CARVE_OUTS = [
  {
    file: "ui/src/test-helpers/control-ui-e2e.ts",
    name: "isRecord",
    kind: "function",
    count: 1,
    reason: "Serialized mock Gateway closure cannot capture module imports.",
  },
  {
    file: "scripts/lib/kova-report-gate.mts",
    name: "isRecord",
    kind: "function",
    count: 1,
    reason: "Copied standalone report gate cannot rely on workspace package resolution.",
  },
  {
    file: "scripts/lib/record-shared.mjs",
    name: "isRecord",
    kind: "function",
    count: 1,
    reason: "Plain-Node shared helper serves MJS and E2E callers without package resolution.",
  },
  {
    file: "scripts/pr-lib/process-group-runner.mjs",
    name: "toError",
    kind: "function",
    count: 1,
    reason:
      "Bootstrap process supervisor preserves fallback errors without workspace dependencies.",
  },
  {
    file: "scripts/lib/bounded-response.mjs",
    name: "toLintErrorObject",
    kind: "function",
    count: 1,
    reason: "Standalone copied response reader cannot resolve workspace packages.",
  },
] as const satisfies readonly {
  count: number;
  file: string;
  kind: CoercionHelperDeclarationKind;
  name: string;
  reason: string;
}[];

type CanonicalCoercionHelperName =
  (typeof CANONICAL_COERCION_HELPER_OWNERS)[number]["names"][number];
type AbsoluteLegacyCoercionHelperName = (typeof ABSOLUTE_LEGACY_COERCION_HELPER_NAMES)[number];
type ExceptionalCoercionHelperName =
  (typeof EXCEPTIONAL_COERCION_HELPER_CARVE_OUTS)[number]["name"];
export type BannedCoercionHelperName =
  | AbsoluteLegacyCoercionHelperName
  | CanonicalCoercionHelperName
  | ExceptionalCoercionHelperName;

export const BANNED_COERCION_HELPER_NAMES: readonly BannedCoercionHelperName[] = [
  ...new Set<BannedCoercionHelperName>([
    ...ABSOLUTE_LEGACY_COERCION_HELPER_NAMES,
    ...CANONICAL_COERCION_HELPER_OWNERS.flatMap(({ names }) => names),
    ...EXCEPTIONAL_COERCION_HELPER_CARVE_OUTS.map(({ name }) => name),
  ]),
];
const BANNED_HELPER_NAMES: ReadonlySet<string> = new Set(BANNED_COERCION_HELPER_NAMES);
// One tracked-tree scan covers root configs plus config, Actions, skills, apps, plugins, and packages.
const SCAN_ROOTS = ["."];
const GENERATED_OR_FIXTURE_PATH_RE =
  /(?:^|\/)(?:\.generated|__generated__|build|coverage|dist|generated|fixtures|node_modules|test-fixtures|vendor)(?:\/|$)|\.generated\.[^/]+$|\.(?:bundle|min)\.[cm]?[jt]sx?$/u;

export type CoercionHelperDeclaration = {
  file: string;
  kind: CoercionHelperDeclarationKind;
  line: number;
  name: BannedCoercionHelperName;
};

export type CoercionHelperCarveOut = {
  count: number;
  file: string;
  kind: CoercionHelperDeclarationKind;
  name: BannedCoercionHelperName;
  reason: string;
};

function canonicalOwnerCarveOuts(
  owner: (typeof CANONICAL_COERCION_HELPER_OWNERS)[number],
): CoercionHelperCarveOut[] {
  return owner.names.map((name) => ({
    file: owner.file,
    kind: owner.kind,
    name,
    count: 1,
    reason: "Canonical coercion helper owned by this module.",
  }));
}

export const COERCION_HELPER_CARVE_OUTS: readonly CoercionHelperCarveOut[] = [
  ...CANONICAL_COERCION_HELPER_OWNERS.flatMap(canonicalOwnerCarveOuts),
  ...EXCEPTIONAL_COERCION_HELPER_CARVE_OUTS,
];

type CarveOutMismatch = CoercionHelperCarveOut & {
  actualCount: number;
};

type CoercionHelperAudit = {
  excessDeclarations: CoercionHelperDeclaration[];
  invalidCarveOuts: string[];
  staleCarveOuts: CarveOutMismatch[];
};

type ScriptIo = {
  stderr: { write(value: string): unknown };
  stdout: { write(value: string): unknown };
};

const COERCION_HELPER_DECLARATION_KINDS = new Set<CoercionHelperDeclarationKind>([
  "field",
  "function",
  "method",
  "property",
  "variable",
]);

function carveOutKey(entry: Pick<CoercionHelperCarveOut, "file" | "kind" | "name">) {
  return `${entry.file}\0${entry.name}\0${entry.kind}`;
}

function unwrapCallableInitializer(expression: ts.Expression) {
  let current = unwrapExpression(expression);
  while (ts.isSatisfiesExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return current;
}

/** Returns true for tracked source files governed by the declaration guard. */
export function isGovernedCoercionHelperPath(filePath: string) {
  return (
    isCodeFile(filePath) &&
    !/\.d\.[cm]?ts$/u.test(filePath) &&
    !GENERATED_OR_FIXTURE_PATH_RE.test(filePath)
  );
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function isCallableInitializer(expression: ts.Expression): boolean {
  const initializer = unwrapCallableInitializer(expression);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer);
}

function unwrapDirectAliasInitializer(expression: ts.Expression): ts.Expression | undefined {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      return undefined;
    }
    return current;
  }
}

/** Finds banned callable declarations in one source file. */
export function findBannedCoercionHelperDeclarations(
  source: string,
  file = "source.ts",
): CoercionHelperDeclaration[] {
  if (![...BANNED_HELPER_NAMES].some((name) => source.includes(name))) {
    return [];
  }
  const scriptKind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const declarations: CoercionHelperDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && BANNED_HELPER_NAMES.has(node.name.text)) {
      declarations.push({
        file,
        kind: "function",
        line: toLine(sourceFile, node.name),
        name: node.name.text as BannedCoercionHelperName,
      });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      BANNED_HELPER_NAMES.has(node.name.text) &&
      node.initializer
    ) {
      const aliasInitializer = unwrapDirectAliasInitializer(node.initializer);
      if (
        isCallableInitializer(node.initializer) ||
        (aliasInitializer !== undefined &&
          (ts.isIdentifier(aliasInitializer) || ts.isPropertyAccessExpression(aliasInitializer)))
      ) {
        declarations.push({
          file,
          kind: "variable",
          line: toLine(sourceFile, node.name),
          name: node.name.text as BannedCoercionHelperName,
        });
      }
    } else if (ts.isMethodDeclaration(node)) {
      const name = propertyNameText(node.name);
      if (name && BANNED_HELPER_NAMES.has(name)) {
        declarations.push({
          file,
          kind: "method",
          line: toLine(sourceFile, node.name),
          name: name as BannedCoercionHelperName,
        });
      }
    } else if (ts.isPropertyDeclaration(node) && node.initializer) {
      const name = propertyNameText(node.name);
      if (name && BANNED_HELPER_NAMES.has(name) && isCallableInitializer(node.initializer)) {
        declarations.push({
          file,
          kind: "field",
          line: toLine(sourceFile, node.name),
          name: name as BannedCoercionHelperName,
        });
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (name && BANNED_HELPER_NAMES.has(name) && isCallableInitializer(node.initializer)) {
        declarations.push({
          file,
          kind: "property",
          line: toLine(sourceFile, node.name),
          name: name as BannedCoercionHelperName,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

/** Checks exact file/name/count carve-outs and rejects stale or excess entries. */
export function auditCoercionHelperDeclarations(
  declarations: readonly CoercionHelperDeclaration[],
  carveOuts: readonly CoercionHelperCarveOut[],
): CoercionHelperAudit {
  const invalidCarveOuts: string[] = [];
  const carveOutByKey = new Map<string, CoercionHelperCarveOut>();
  for (const carveOut of carveOuts) {
    const key = carveOutKey(carveOut);
    if (carveOutByKey.has(key)) {
      invalidCarveOuts.push(`${carveOut.file} [${carveOut.name}] is listed more than once`);
      continue;
    }
    if (!BANNED_HELPER_NAMES.has(carveOut.name)) {
      invalidCarveOuts.push(`${carveOut.file} [${carveOut.name}] is not a banned helper name`);
    }
    if (!COERCION_HELPER_DECLARATION_KINDS.has(carveOut.kind)) {
      invalidCarveOuts.push(
        `${carveOut.file} [${carveOut.name}] has invalid kind ${carveOut.kind}`,
      );
    }
    if (!Number.isInteger(carveOut.count) || carveOut.count < 1) {
      invalidCarveOuts.push(`${carveOut.file} [${carveOut.name}] must have a positive count`);
    }
    if (!carveOut.reason.trim()) {
      invalidCarveOuts.push(`${carveOut.file} [${carveOut.name}] needs a non-empty reason`);
    }
    carveOutByKey.set(key, carveOut);
  }

  const declarationsByKey = new Map<string, CoercionHelperDeclaration[]>();
  for (const declaration of declarations) {
    const key = carveOutKey(declaration);
    const current = declarationsByKey.get(key) ?? [];
    current.push(declaration);
    declarationsByKey.set(key, current);
  }

  const excessDeclarations: CoercionHelperDeclaration[] = [];
  for (const [key, actual] of declarationsByKey) {
    const allowedCount = carveOutByKey.get(key)?.count ?? 0;
    if (actual.length > allowedCount) {
      excessDeclarations.push(...actual.slice(allowedCount));
    }
  }
  const staleCarveOuts = carveOuts
    .map((carveOut): CarveOutMismatch | null => {
      const actual = declarationsByKey.get(carveOutKey(carveOut)) ?? [];
      return actual.length < carveOut.count
        ? {
            ...carveOut,
            actualCount: actual.length,
          }
        : null;
    })
    .filter((entry): entry is CarveOutMismatch => entry !== null);

  return {
    excessDeclarations: excessDeclarations.toSorted(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.name.localeCompare(right.name),
    ),
    invalidCarveOuts,
    staleCarveOuts,
  };
}

function writeLine(stream: ScriptIo["stdout"] | ScriptIo["stderr"], value: string) {
  stream.write(`${value}\n`);
}

/** Runs the full tracked-source declaration guard. */
export function runCoercionHelperDeclarationGuard(
  options: {
    carveOuts?: readonly CoercionHelperCarveOut[];
    io?: ScriptIo;
    repoRoot?: string;
  } = {},
) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot(import.meta.url);
  const io = options.io ?? { stderr: process.stderr, stdout: process.stdout };
  const carveOuts = options.carveOuts ?? COERCION_HELPER_CARVE_OUTS;
  const relativeFiles = listRepoFilesSync(repoRoot, {
    roots: SCAN_ROOTS,
    includeFile: isGovernedCoercionHelperPath,
  });
  const declarations = relativeFiles.flatMap((file) => {
    const absolutePath = path.join(repoRoot, file);
    if (!fs.existsSync(absolutePath)) {
      return [];
    }
    return findBannedCoercionHelperDeclarations(fs.readFileSync(absolutePath, "utf8"), file);
  });
  const audit = auditCoercionHelperDeclarations(declarations, carveOuts);
  const failed =
    audit.excessDeclarations.length > 0 ||
    audit.invalidCarveOuts.length > 0 ||
    audit.staleCarveOuts.length > 0;
  if (!failed) {
    writeLine(
      io.stdout,
      `Coercion helper declaration guard passed (${declarations.length} allowlisted declarations).`,
    );
    return 0;
  }

  if (audit.invalidCarveOuts.length > 0) {
    writeLine(io.stderr, "Invalid coercion-helper carve-outs:");
    for (const message of audit.invalidCarveOuts) {
      writeLine(io.stderr, `- ${message}`);
    }
  }
  if (audit.excessDeclarations.length > 0) {
    writeLine(io.stderr, "Banned local coercion-helper declarations:");
    for (const declaration of audit.excessDeclarations) {
      writeLine(
        io.stderr,
        `- ${declaration.file}:${declaration.line} ${declaration.name} (${declaration.kind} declaration)`,
      );
    }
  }
  if (audit.staleCarveOuts.length > 0) {
    writeLine(io.stderr, "Stale coercion-helper carve-outs:");
    for (const carveOut of audit.staleCarveOuts) {
      writeLine(
        io.stderr,
        `- ${carveOut.file} [${carveOut.name}] expected ${carveOut.count} ${carveOut.kind} declaration(s), found ${carveOut.actualCount}; remove or reduce the carve-out`,
      );
    }
  }
  writeLine(
    io.stderr,
    "Core/package/UI/workspace-script code: use the matching @openclaw/normalization-core coercion subpath.",
  );
  writeLine(
    io.stderr,
    "Plugin production code: use openclaw/plugin-sdk/string-coerce-runtime, number-runtime, or error-runtime.",
  );
  writeLine(
    io.stderr,
    "Dependency-free, copied, generated, or serialized code: use an existing dependency-light seam or a precise semantic name with an exact reasoned carve-out.",
  );
  return 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runWithFailedTrailer("check:coercion-helpers", () => {
    process.exitCode = runCoercionHelperDeclarationGuard();
  });
}
