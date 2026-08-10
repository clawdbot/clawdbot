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

const BANNED_HELPER_NAMES = new Set([
  "asObject",
  "asRecord",
  "asString",
  "isRecord",
  "normalizeString",
  "optionalString",
  "readBoolean",
  "readNumber",
  "readOptionalString",
  "readString",
  "timestampMs",
  "toError",
]);
const SCAN_ROOTS = [
  "apps",
  "deploy",
  "examples",
  "extensions",
  "packages",
  "qa",
  "scripts",
  "security",
  "src",
  "test",
  "ui",
];
const GENERATED_OR_FIXTURE_PATH_RE =
  /(?:^|\/)(?:\.generated|__generated__|build|coverage|dist|generated|fixtures|node_modules|test-fixtures|vendor)(?:\/|$)|(?:^|\/)[^/]*(?:test-)?fixtures?\.[cm]?[jt]sx?$|\.generated\.[^/]+$|\.(?:bundle|min)\.[cm]?[jt]sx?$/u;
const GENERATED_BROWSER_RUNTIME_PATHS = new Set([
  "extensions/browser/chrome-extension/modules/copilot-runtime.js",
]);

export type BannedCoercionHelperName =
  | "asObject"
  | "asRecord"
  | "asString"
  | "isRecord"
  | "normalizeString"
  | "optionalString"
  | "readBoolean"
  | "readNumber"
  | "readOptionalString"
  | "readString"
  | "timestampMs"
  | "toError";

export type CoercionHelperDeclaration = {
  file: string;
  kind: "function" | "variable";
  line: number;
  name: BannedCoercionHelperName;
};

export type CoercionHelperCarveOut = {
  count: number;
  file: string;
  name: BannedCoercionHelperName;
  reason: string;
};

export const COERCION_HELPER_CARVE_OUTS: readonly CoercionHelperCarveOut[] = [
  {
    file: "packages/normalization-core/src/record-coerce.ts",
    name: "asRecord",
    count: 1,
    reason: "Canonical object-to-record fallback coercion owned by normalization-core.",
  },
  {
    file: "packages/normalization-core/src/record-coerce.ts",
    name: "isRecord",
    count: 1,
    reason: "Canonical non-array record predicate owned by normalization-core.",
  },
  {
    file: "packages/llm-core/src/validation.ts",
    name: "isRecord",
    count: 1,
    reason:
      "Dependency-free validator intentionally accepts arrays before JSON type-specific checks.",
  },
  {
    file: "ui/src/test-helpers/control-ui-e2e.ts",
    name: "isRecord",
    count: 1,
    reason: "Serialized mock Gateway closure cannot capture module imports.",
  },
  {
    file: "scripts/android-release-signing.mjs",
    name: "asRecord",
    count: 1,
    reason: "Release signing entrypoint runs before workspace dependencies are installed.",
  },
  {
    file: "scripts/changed-lanes.mts",
    name: "isRecord",
    count: 1,
    reason: "Changed-lane classification also runs in temporary repositories.",
  },
  {
    file: "scripts/check-built-plugin-control-plane-modules.mts",
    name: "isRecord",
    count: 1,
    reason: "Copied standalone build guard cannot rely on workspace package resolution.",
  },
  {
    file: "scripts/close-duplicate-prs-after-merge.mjs",
    name: "isRecord",
    count: 1,
    reason: "Plain-Node Actions entrypoint runs in checkout-only jobs without dependencies.",
  },
  {
    file: "scripts/copy-bundled-plugin-metadata.mts",
    name: "isRecord",
    count: 1,
    reason: "Copied standalone metadata closure cannot rely on workspace package resolution.",
  },
  {
    file: "scripts/lib/kova-report-gate.mts",
    name: "isRecord",
    count: 1,
    reason: "Copied standalone report gate cannot rely on workspace package resolution.",
  },
  {
    file: "scripts/lib/plugin-npm-package-manifest.mts",
    name: "isRecord",
    count: 1,
    reason: "Copied standalone package-manifest closure cannot resolve workspace packages.",
  },
  {
    file: "scripts/lib/record-shared.mjs",
    name: "isRecord",
    count: 1,
    reason: "Plain-Node shared helper serves MJS and E2E callers without package resolution.",
  },
  {
    file: "scripts/lib/static-extension-assets.mts",
    name: "asRecord",
    count: 1,
    reason: "Copied standalone asset closure cannot rely on workspace package resolution.",
  },
  {
    file: "scripts/periphery-intersection.mjs",
    name: "isRecord",
    count: 1,
    reason: "Plain-Node Actions entrypoint runs in checkout-only jobs without dependencies.",
  },
  {
    file: "scripts/pr-lib/process-group-runner.mjs",
    name: "toError",
    count: 1,
    reason:
      "Bootstrap process supervisor preserves fallback errors without workspace dependencies.",
  },
  {
    file: "scripts/stage-bundled-plugin-runtime.mts",
    name: "isRecord",
    count: 1,
    reason: "Copied standalone runtime-staging closure cannot resolve workspace packages.",
  },
];

type CarveOutMismatch = CoercionHelperCarveOut & {
  actualCount: number;
  lines: number[];
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

function carveOutKey(entry: Pick<CoercionHelperCarveOut, "file" | "name">) {
  return `${entry.file}\0${entry.name}`;
}

function unwrapCallableInitializer(expression: ts.Expression) {
  let current = unwrapExpression(expression);
  while (ts.isSatisfiesExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return current;
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

/** Returns true for tracked source files governed by the declaration guard. */
export function isGovernedCoercionHelperPath(filePath: string) {
  return (
    isCodeFile(filePath) &&
    !/\.d\.[cm]?ts$/u.test(filePath) &&
    !GENERATED_BROWSER_RUNTIME_PATHS.has(filePath) &&
    !GENERATED_OR_FIXTURE_PATH_RE.test(filePath)
  );
}

/** Finds banned function and callable-variable declarations in one source file. */
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
      const initializer = unwrapCallableInitializer(node.initializer);
      const aliasInitializer = unwrapDirectAliasInitializer(node.initializer);
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer) ||
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
            lines: actual.map((entry) => entry.line),
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
        `- ${carveOut.file} [${carveOut.name}] expected ${carveOut.count}, found ${carveOut.actualCount}; remove or reduce the carve-out`,
      );
    }
  }
  writeLine(
    io.stderr,
    "Use @openclaw/normalization-core coercion subpaths in core/packages/UI/scripts, or openclaw/plugin-sdk/string-coerce-runtime and error-runtime in plugin production code.",
  );
  return 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runWithFailedTrailer("check:coercion-helpers", () => {
    process.exitCode = runCoercionHelperDeclarationGuard();
  });
}
