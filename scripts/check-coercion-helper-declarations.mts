#!/usr/bin/env node

// Prevents local primitive-coercion helpers from regrowing after consolidation.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isCodeFile, listRepoFilesSync } from "./check-file-utils.js";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { getPropertyNameText, toLine, unwrapExpression } from "./lib/ts-guard-utils.mts";

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
    file: "packages/normalization-core/src/agent-id.ts",
    kind: "function",
    names: ["isValidAgentId", "normalizeAgentId", "normalizeAgentIdStrict"],
  },
  {
    file: "packages/normalization-core/src/string-coerce.ts",
    kind: "function",
    names: [
      "hasNonEmptyString",
      "lowercasePreservingWhitespace",
      "localeLowercasePreservingWhitespace",
      "normalizeBoundedOptionalString",
      "normalizeFastMode",
      "normalizeLowercaseStringOrEmpty",
      "normalizeNullableString",
      "normalizeOptionalLowercaseString",
      "normalizeOptionalString",
      "normalizeOptionalStringifiedId",
      "normalizeOptionalThreadValue",
      "normalizeStringifiedOptionalString",
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
    names: [
      "filterStringEntries",
      "normalizeArrayBackedTrimmedStringList",
      "normalizeAtHashSlug",
      "normalizeCsvOrLooseStringList",
      "normalizeHyphenSlug",
      "normalizeOptionalTrimmedStringList",
      "normalizeSingleOrTrimmedStringList",
      "normalizeSortedUniqueStringEntries",
      "normalizeSortedUniqueTrimmedStringList",
      "normalizeStringEntries",
      "normalizeStringEntriesLower",
      "normalizeTrimmedStringList",
      "normalizeUniqueSingleOrTrimmedStringList",
      "normalizeUniqueStringEntries",
      "normalizeUniqueStringEntriesLower",
      "normalizeUniqueTrimmedStringList",
      "sortUniqueStrings",
      "uniqueStrings",
      "uniqueValues",
    ],
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
      "clampTimerTimeoutMs",
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
      "parseStrictPositiveInteger",
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
      "resolveTimerTimeoutMs",
      "resolveTimestampMsToIsoString",
      "timestampMsToIsoFileStamp",
      "timestampMsToIsoString",
    ],
  },
  {
    file: "packages/normalization-core/src/boolean-coercion.ts",
    kind: "function",
    names: ["parseBoolean"],
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
    names: ["safeParseJson", "safeParseJsonRecord"],
  },
  {
    file: "packages/normalization-core/src/error-coercion.ts",
    kind: "function",
    names: [
      "coerceErrorMessage",
      "stringifyNonErrorCause",
      "toErrorObject",
      "toStringifiedError",
      "toStructuredErrorObject",
    ],
  },
  {
    file: "scripts/lib/error-format.mts",
    kind: "function",
    names: ["coerceErrorMessage", "toErrorObject", "toStringifiedError"],
  },
  {
    file: "scripts/lib/arg-utils.runtime.mjs",
    kind: "function",
    names: [
      "classifyBoundedUnsignedDecimal",
      "parsePermissiveBooleanToken",
      "parseStrictBooleanArg",
    ],
  },
  {
    file: "src/utils/boolean.ts",
    kind: "function",
    names: ["asBoolean", "parseBooleanValue"],
  },
] as const satisfies readonly {
  file: string;
  kind: CoercionHelperDeclarationKind;
  names: readonly string[];
}[];

export const CANONICAL_COERCION_MODULES = [
  "packages/normalization-core/src/agent-id.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/normalization-core/src/string-normalization.ts",
  "packages/normalization-core/src/number-coercion.ts",
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/json-coercion.ts",
  "packages/normalization-core/src/error-coercion.ts",
  "packages/normalization-core/src/boolean-coercion.ts",
  "scripts/lib/error-format.mts",
  "src/utils/boolean.ts",
] as const;

const MIXED_CANONICAL_COERCION_MODULES = ["scripts/lib/arg-utils.runtime.mjs"] as const;

export const DEFERRED_CANONICAL_COERCION_EXPORTS = [
  {
    file: "packages/normalization-core/src/error-coercion.ts",
    name: "formatErrorMessage",
    reason: "Structural formatter shares its public name with redacting owner adapters.",
  },
  {
    file: "scripts/lib/error-format.mts",
    name: "formatErrorMessage",
    reason: "Dependency-light scripts retain a deliberately smaller formatting policy.",
  },
] as const satisfies readonly { file: string; name: string; reason: string }[];

const EXCEPTIONAL_COERCION_HELPER_CARVE_OUTS = [
  {
    file: "ui/src/test-helpers/control-ui-e2e.ts",
    name: "isRecord",
    kind: "function",
    reason: "Serialized mock Gateway closure cannot capture module imports.",
  },
  {
    file: "src/gateway/mcp-app-standalone.ts",
    name: "asStandaloneRecord",
    kind: "variable",
    reason: "Serialized standalone app closure cannot capture module imports.",
  },
  {
    file: "extensions/diffs/src/viewer-payload.ts",
    name: "isViewerRecord",
    kind: "function",
    reason: "Standalone browser asset build cannot resolve workspace package imports.",
  },
  {
    file: "scripts/lib/kova-report-gate.mts",
    name: "isRecord",
    kind: "function",
    reason: "Copied standalone report gate cannot rely on workspace package resolution.",
  },
  {
    file: "scripts/lib/record-shared.mjs",
    name: "isRecord",
    kind: "function",
    reason: "Plain-Node shared helper serves MJS and E2E callers without package resolution.",
  },
  {
    file: "scripts/pr-lib/process-group-runner.mjs",
    name: "toError",
    kind: "function",
    reason:
      "Bootstrap process supervisor preserves fallback errors without workspace dependencies.",
  },
  {
    file: "scripts/lib/bounded-response.mjs",
    name: "toLintErrorObject",
    kind: "function",
    reason: "Standalone copied response reader cannot resolve workspace packages.",
  },
] as const satisfies readonly {
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

export type CanonicalCoercionExportClassification = {
  file: string;
  name: string;
  reason?: string;
  status: "deferred" | "enforced";
};

export type CanonicalCoercionExportAudit = {
  invalidClassifications: string[];
  staleClassifications: CanonicalCoercionExportClassification[];
  unclassifiedExports: Array<{ file: string; name: string }>;
};

export type CoercionHelperCarveOut = {
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
    reason: "Canonical coercion helper owned by this module.",
  }));
}

export const COERCION_HELPER_CARVE_OUTS: readonly CoercionHelperCarveOut[] = [
  ...CANONICAL_COERCION_HELPER_OWNERS.flatMap(canonicalOwnerCarveOuts),
  ...EXCEPTIONAL_COERCION_HELPER_CARVE_OUTS,
];

type CoercionHelperAudit = {
  excessDeclarations: CoercionHelperDeclaration[];
  invalidCarveOuts: string[];
  staleCarveOuts: CoercionHelperCarveOut[];
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
      const name = getPropertyNameText(node.name);
      if (name && BANNED_HELPER_NAMES.has(name)) {
        declarations.push({
          file,
          kind: "method",
          line: toLine(sourceFile, node.name),
          name: name as BannedCoercionHelperName,
        });
      }
    } else if (ts.isPropertyDeclaration(node) && node.initializer) {
      const name = getPropertyNameText(node.name);
      if (name && BANNED_HELPER_NAMES.has(name) && isCallableInitializer(node.initializer)) {
        declarations.push({
          file,
          kind: "field",
          line: toLine(sourceFile, node.name),
          name: name as BannedCoercionHelperName,
        });
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = getPropertyNameText(node.name);
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

function hasExportModifier(node: ts.Node) {
  return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/** Finds directly declared callable exports in one selected canonical module. */
export function findExportedCallableNames(source: string, file = "source.ts") {
  const scriptKind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const callableLocals = new Set<string>();
  const exportedNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      callableLocals.add(statement.name.text);
      if (hasExportModifier(statement)) {
        exportedNames.add(statement.name.text);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      const alias = unwrapDirectAliasInitializer(declaration.initializer);
      if (
        !isCallableInitializer(declaration.initializer) &&
        (!alias || (!ts.isIdentifier(alias) && !ts.isPropertyAccessExpression(alias)))
      ) {
        continue;
      }
      callableLocals.add(declaration.name.text);
      if (hasExportModifier(statement)) {
        exportedNames.add(declaration.name.text);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const localName = element.propertyName?.text ?? element.name.text;
      if (!element.isTypeOnly && callableLocals.has(localName)) {
        exportedNames.add(element.name.text);
      }
    }
  }
  return [...exportedNames].toSorted();
}

/** Requires every selected callable export to be enforced or explicitly deferred. */
export function auditCanonicalCoercionExports(
  exportsByFile: ReadonlyMap<string, readonly string[]>,
  classifications: readonly CanonicalCoercionExportClassification[],
): CanonicalCoercionExportAudit {
  const invalidClassifications: string[] = [];
  const byKey = new Map<string, CanonicalCoercionExportClassification>();
  for (const classification of classifications) {
    const key = `${classification.file}\0${classification.name}`;
    if (byKey.has(key)) {
      invalidClassifications.push(
        `${classification.file} [${classification.name}] is classified more than once`,
      );
      continue;
    }
    if (classification.status === "deferred" && !classification.reason?.trim()) {
      invalidClassifications.push(
        `${classification.file} [${classification.name}] needs a non-empty deferred reason`,
      );
    }
    byKey.set(key, classification);
  }
  const unclassifiedExports = [...exportsByFile].flatMap(([file, names]) =>
    names.flatMap((name) => (byKey.has(`${file}\0${name}`) ? [] : [{ file, name }])),
  );
  const staleClassifications = classifications.filter(
    ({ file, name }) => !(exportsByFile.get(file) ?? []).includes(name),
  );
  return { invalidClassifications, staleClassifications, unclassifiedExports };
}

/** Checks exact file/name/kind carve-outs and rejects stale or excess entries. */
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
    if (carveOutByKey.has(key)) {
      excessDeclarations.push(...actual.slice(1));
    } else {
      excessDeclarations.push(...actual);
    }
  }
  const staleCarveOuts = carveOuts.filter(
    (carveOut) => !declarationsByKey.has(carveOutKey(carveOut)),
  );

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

function auditDefaultCanonicalExports(repoRoot: string): CanonicalCoercionExportAudit {
  const canonicalModules = new Set<string>(CANONICAL_COERCION_MODULES);
  const mixedModules = new Set<string>(MIXED_CANONICAL_COERCION_MODULES);
  const auditedModules = [...CANONICAL_COERCION_MODULES, ...MIXED_CANONICAL_COERCION_MODULES];
  const exportsByFile = new Map(
    auditedModules.map((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const exportedNames = findExportedCallableNames(source, file);
      if (!mixedModules.has(file)) {
        return [file, exportedNames] as const;
      }
      const registeredNames = new Set<string>(
        CANONICAL_COERCION_HELPER_OWNERS.filter((owner) => owner.file === file).flatMap(
          (owner) => owner.names,
        ),
      );
      return [file, exportedNames.filter((name) => registeredNames.has(name))] as const;
    }),
  );
  const classifications: CanonicalCoercionExportClassification[] = [
    ...CANONICAL_COERCION_HELPER_OWNERS.filter(
      ({ file }) => canonicalModules.has(file) || mixedModules.has(file),
    ).flatMap(({ file, names }) =>
      names.map((name) => ({ file, name, status: "enforced" as const })),
    ),
    ...DEFERRED_CANONICAL_COERCION_EXPORTS.map(({ file, name, reason }) => ({
      file,
      name,
      reason,
      status: "deferred" as const,
    })),
  ];
  return auditCanonicalCoercionExports(exportsByFile, classifications);
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
  const exportAudit =
    options.carveOuts === undefined
      ? auditDefaultCanonicalExports(repoRoot)
      : { invalidClassifications: [], staleClassifications: [], unclassifiedExports: [] };
  const failed =
    audit.excessDeclarations.length > 0 ||
    audit.invalidCarveOuts.length > 0 ||
    audit.staleCarveOuts.length > 0 ||
    exportAudit.invalidClassifications.length > 0 ||
    exportAudit.staleClassifications.length > 0 ||
    exportAudit.unclassifiedExports.length > 0;
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
        `- ${carveOut.file} [${carveOut.name}] has no ${carveOut.kind} declaration; remove the carve-out`,
      );
    }
  }
  if (exportAudit.invalidClassifications.length > 0) {
    writeLine(io.stderr, "Invalid canonical-export classifications:");
    for (const message of exportAudit.invalidClassifications) {
      writeLine(io.stderr, `- ${message}`);
    }
  }
  if (exportAudit.unclassifiedExports.length > 0) {
    writeLine(io.stderr, "Unclassified canonical callable exports:");
    for (const entry of exportAudit.unclassifiedExports) {
      writeLine(io.stderr, `- ${entry.file} [${entry.name}]`);
    }
  }
  if (exportAudit.staleClassifications.length > 0) {
    writeLine(io.stderr, "Stale canonical-export classifications:");
    for (const entry of exportAudit.staleClassifications) {
      writeLine(io.stderr, `- ${entry.file} [${entry.name}] (${entry.status})`);
    }
  }
  writeLine(
    io.stderr,
    "Core/package/UI/workspace-script code: use the matching @openclaw/normalization-core export or module.",
  );
  writeLine(
    io.stderr,
    "Bundled plugin production code: use the matching openclaw/plugin-sdk runtime; number-runtime is bundled/private-local, not a third-party typed contract.",
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
