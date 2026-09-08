import { createRequire } from "node:module";
import { isAbsolute, win32 } from "node:path";
import type ts from "typescript";

const require = createRequire(import.meta.url);
type Origin =
  | "root"
  | "caller"
  | "factory"
  | "module"
  | "process"
  | "path"
  | "fs"
  | "fs-promises"
  | "builtin"
  | "join"
  | "resolve"
  | "realpath"
  | "realpath-async"
  | "cwd"
  | "chdir"
  | "location"
  | "input"
  | "caller-path"
  | "caller-string"
  | "literal"
  | "relative"
  | "scalar"
  | "unknown"
  | "unlocated";
const namespaces = new Map<string, Origin>([
  ["node:module", "module"],
  ["module", "module"],
  ["node:process", "process"],
  ["process", "process"],
  ["node:path", "path"],
  ["path", "path"],
  ["node:fs", "fs"],
  ["fs", "fs"],
  ["node:fs/promises", "fs-promises"],
  ["fs/promises", "fs-promises"],
]);
const members = new Map<Origin, ReadonlyMap<string, Origin>>([
  ["module", new Map([["createRequire", "factory"]])],
  [
    "process",
    new Map([
      ["getBuiltinModule", "builtin"],
      ["cwd", "cwd"],
      ["chdir", "chdir"],
    ]),
  ],
  [
    "path",
    new Map([
      ["join", "join"],
      ["resolve", "resolve"],
    ]),
  ],
  [
    "fs",
    new Map([
      ["realpathSync", "realpath"],
      ["promises", "fs-promises"],
    ]),
  ],
  ["fs-promises", new Map([["realpath", "realpath-async"]])],
]);
const ambient = new Map<string, Origin>([
  ["require", "root"],
  ["__filename", "location"],
  ["process", "process"],
]);
const loaders = new Set<Origin>(["root", "caller", "unlocated"]);
const snapshotsKinds = new Set<Origin>(["caller-path", "caller-string", "caller", "root"]);
const callerValues = new Set<Origin>(["input", "caller-path", "caller-string"]);
const pathValues = new Set<Origin>([...callerValues, "literal", "relative"]);
const readableValues = new Set<Origin>([
  ...pathValues,
  "module",
  "process",
  "path",
  "fs",
  "fs-promises",
  "scalar",
]);
const pureCalls = new Set<Origin>([
  "factory",
  "builtin",
  "join",
  "resolve",
  "realpath",
  "realpath-async",
  "cwd",
]);
function union(...values: Origin[][]): Origin[] {
  const result = [...new Set(values.flat())];
  return result.length ? result : ["unknown"];
}

export type PackageRootImportOccurrence = {
  specifier: string;
  start: number;
};

/** Read dependency ownership without resolving or executing the inspected package. */
export function collectPackageRootImportOccurrences(source: string): PackageRootImportOccurrence[] {
  const ts = require("typescript") as typeof import("typescript");
  const file = ts.createSourceFile(
    "dist.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports: PackageRootImportOccurrence[] = [];
  const recordImport = (specifier: string, node: ts.Node) => {
    imports.push({ specifier, start: node.getStart(file) });
  };
  const calls: ts.CallExpression[] = [];
  const scopes: Array<ts.SourceFile | ts.FunctionLikeDeclaration> = [file];
  const assignments: Array<[ts.Identifier, ts.Expression | undefined]> = [];
  const cwdReferences: Array<ts.Expression | ts.ImportSpecifier | ts.BindingElement> = [];
  // Only const primitive paths and bound Node loaders survive the entry prefix; raw inputs do not.
  const snapshots = new Map<ts.Symbol, Origin[]>();
  let changedCwd = false;
  let checker: ts.TypeChecker | undefined;
  function symbolAt(node: ts.Node): ts.Symbol | undefined {
    checker ??= ts
      .createProgram(
        [file.fileName],
        { allowJs: true, noLib: true, noResolve: true },
        {
          getSourceFile: (name) => (name === file.fileName ? file : undefined),
          getDefaultLibFileName: () => "",
          writeFile: () => {},
          getCurrentDirectory: () => "",
          getCanonicalFileName: (name) => name,
          useCaseSensitiveFileNames: () => true,
          getNewLine: () => "\n",
          fileExists: (name) => name === file.fileName,
          readFile: (name) => (name === file.fileName ? source : undefined),
        },
      )
      .getTypeChecker();
    return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  }
  function literal(node: ts.Expression | undefined): string | undefined {
    let value = node;
    while (value && ts.isParenthesizedExpression(value)) {
      value = value.expression;
    }
    return value && ts.isStringLiteral(value) ? value.text : undefined;
  }
  function property(node: ts.Node): string | undefined {
    return ts.isIdentifier(node) || ts.isStringLiteral(node)
      ? node.text
      : ts.isComputedPropertyName(node)
        ? literal(node.expression)
        : undefined;
  }
  const logical = new Set([
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);
  function recordWrite(node: ts.Node, value?: ts.Expression) {
    if (ts.isIdentifier(node)) {
      assignments.push([node, value]);
    } else if (ts.isParenthesizedExpression(node)) {
      recordWrite(node.expression, value);
    } else if (ts.isPropertyAssignment(node)) {
      recordWrite(node.initializer);
    } else if (ts.isShorthandPropertyAssignment(node) || ts.isBindingElement(node)) {
      recordWrite(node.name);
    } else if (ts.isBinaryExpression(node)) {
      recordWrite(node.left);
    } else if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
      ts.forEachChild(node, (child) => recordWrite(child));
    }
  }
  const pending: ts.Node[] = [file];
  let hasLoader = false;
  while (pending.length) {
    const node = pending.pop()!;
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
      ["require", "createRequire", "getBuiltinModule"].includes(node.text)
    ) {
      hasLoader = true;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier !== undefined) {
        recordImport(specifier, node.moduleSpecifier!);
      }
    }
    if (ts.isCallExpression(node)) {
      const specifier = literal(node.arguments[0]);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && specifier !== undefined) {
        recordImport(specifier, node.arguments[0]!);
      } else {
        calls.push(node);
      }
    }
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      scopes.push(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      recordWrite(node.left, node.right);
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      recordWrite(node.initializer);
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "chdir") ||
      (ts.isElementAccessExpression(node) && literal(node.argumentExpression) === "chdir") ||
      ((ts.isImportSpecifier(node) || ts.isBindingElement(node)) &&
        property(node.propertyName ?? node.name) === "chdir")
    ) {
      cwdReferences.push(node);
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  if (!hasLoader) {
    return imports;
  }
  const writes = new Map<ts.Symbol, Array<ts.Expression | undefined>>();
  for (const [name, value] of assignments) {
    const symbol = symbolAt(name);
    if (symbol) {
      writes.set(symbol, [...(writes.get(symbol) ?? []), value]);
    }
  }
  function memberOrigins(owners: Origin[], name: string | undefined): Origin[] {
    return union(
      owners.map((owner) =>
        owner === "input"
          ? "input"
          : name === undefined
            ? "unknown"
            : (members.get(owner)?.get(name) ?? "unknown"),
      ),
    );
  }
  function origins(
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
    inputScope?: ts.Node,
    awaited = false,
  ): Origin[] {
    if (ts.isParenthesizedExpression(expression)) {
      return origins(expression.expression, seen, inputScope, awaited);
    }
    if (ts.isAwaitExpression(expression)) {
      return origins(expression.expression, seen, inputScope, true);
    }
    if (ts.isStringLiteralLike(expression)) {
      return [
        isAbsolute(expression.text) ||
        win32.isAbsolute(expression.text) ||
        URL.canParse(expression.text)
          ? "literal"
          : "relative",
      ];
    }
    if (
      ts.isNumericLiteral(expression) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
        expression.kind,
      )
    ) {
      return ["literal"];
    }
    if (ts.isConditionalExpression(expression)) {
      return union(
        origins(expression.whenTrue, new Set(seen), inputScope),
        origins(expression.whenFalse, new Set(seen), inputScope),
      );
    }
    if (ts.isBinaryExpression(expression)) {
      const op = expression.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.CommaToken) {
        return origins(expression.right, seen, inputScope);
      }
      const values = union(
        origins(expression.left, new Set(seen), inputScope),
        origins(expression.right, new Set(seen), inputScope),
      );
      if (logical.has(op)) {
        return values;
      }
      if (
        op === ts.SyntaxKind.PlusToken &&
        values.some((value) => callerValues.has(value)) &&
        values.every((value) => pathValues.has(value))
      ) {
        return ["caller-string"];
      }
      return ["scalar"];
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression);
      if (!symbol?.declarations?.length) {
        return [ambient.get(expression.text) ?? "unknown"];
      }
      const snapshot = snapshots.get(symbol);
      if (snapshot) {
        return snapshot;
      }
      if (seen.has(symbol)) {
        return ["unknown"];
      }
      seen.add(symbol);
      const entryParameter = symbol.declarations.some(
        (declaration) =>
          ts.isParameter(declaration) &&
          ts.findAncestor(declaration.parent, ts.isFunctionLike) === inputScope,
      );
      return union(
        ...symbol.declarations.map((declaration) =>
          declarationOrigins(declaration, new Set(seen), inputScope),
        ),
        ...(entryParameter ? [] : (writes.get(symbol) ?? [])).map((value): Origin[] =>
          value ? origins(value, new Set(seen), inputScope) : ["unknown"],
        ),
      );
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : literal(expression.argumentExpression);
      if (
        name === "url" &&
        ts.isMetaProperty(expression.expression) &&
        expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        return ["location"];
      }
      return memberOrigins(origins(expression.expression, seen, inputScope), name);
    }
    if (ts.isCallExpression(expression)) {
      const specifier = literal(expression.arguments[0]);
      const namespace = specifier === undefined ? undefined : namespaces.get(specifier);
      if (expression.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return [namespace ?? "unknown"];
      }
      const locations = expression.arguments.map((value) =>
        origins(value, new Set(seen), inputScope),
      );
      return union(
        ...origins(expression.expression, new Set(seen), inputScope).map((loader): Origin[] => {
          if (loader === "factory") {
            return (locations[0] ?? ["unknown"]).map((location) =>
              location === "location"
                ? "root"
                : callerValues.has(location)
                  ? "caller"
                  : "unlocated",
            );
          }
          if (loaders.has(loader) || loader === "builtin") {
            return [namespace ?? "unknown"];
          }
          if (loader === "cwd") {
            return [inputScope && !changedCwd ? "caller-path" : "scalar"];
          }
          // Only the awaited default result is a string; the Promise itself is mutable.
          if (loader === "realpath-async" && !awaited) {
            return ["unknown"];
          }
          if (
            loader === "resolve" ||
            ((loader === "realpath" || loader === "realpath-async") &&
              expression.arguments.length === 1)
          ) {
            const values = loader === "resolve" ? locations.flat() : (locations[0] ?? ["unknown"]);
            return [
              !changedCwd &&
              values.every((value) =>
                ["input", "caller-path", "caller-string", "relative"].includes(value),
              ) &&
              (inputScope || values.includes("caller-path")) &&
              (inputScope || !values.includes("caller-string"))
                ? "caller-path"
                : "scalar",
            ];
          }
          if (loader === "join") {
            const values = locations.flat();
            if (
              values.every((value) => pathValues.has(value)) &&
              values.some((value) => callerValues.has(value))
            ) {
              return [
                locations[0]?.every((value) => value === "caller-path")
                  ? "caller-path"
                  : "caller-string",
              ];
            }
            return ["scalar"];
          }
          return ["unknown"];
        }),
      );
    }
    return ["unknown"];
  }
  function declarationOrigins(
    declaration: ts.Declaration,
    seen: Set<ts.Symbol>,
    inputScope?: ts.Node,
  ): Origin[] {
    if (ts.isParameter(declaration)) {
      // A nested function cannot recapture a mutable input belonging to an outer invocation.
      const input: Origin =
        inputScope && ts.findAncestor(declaration.parent, ts.isFunctionLike) === inputScope
          ? "input"
          : "unknown";
      const initial = declaration.initializer
        ? origins(declaration.initializer, seen, inputScope)
        : [];
      return union(
        [input],
        declaration.initializer && !ts.isIdentifier(declaration.name) ? ["unknown"] : initial,
      );
    }
    if (ts.isBindingElement(declaration)) {
      let owner: ts.Node = declaration;
      const defaults: Origin[][] = [];
      while (
        ts.isBindingElement(owner) ||
        ts.isObjectBindingPattern(owner) ||
        ts.isArrayBindingPattern(owner)
      ) {
        if (ts.isBindingElement(owner) && owner.initializer) {
          defaults.push(
            owner === declaration
              ? origins(owner.initializer, new Set(seen), inputScope)
              : ["unknown"],
          );
        }
        owner = owner.parent;
      }
      const incoming: Origin[] = ts.isParameter(owner)
        ? declarationOrigins(owner, new Set(seen), inputScope)
        : ts.isVariableDeclaration(owner) && owner.initializer
          ? origins(owner.initializer, new Set(seen), inputScope)
          : ["unknown"];
      const name = property(declaration.propertyName ?? declaration.name);
      const projected: Origin[] = ts.isParameter(owner)
        ? incoming
        : ts.isObjectBindingPattern(declaration.parent) &&
            declaration.parent.parent === owner &&
            name !== undefined
          ? memberOrigins(incoming, name)
          : ["unknown"];
      return union(
        projected,
        ...defaults,
        !ts.isParameter(owner) && !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)
          ? ["unknown"]
          : [],
      );
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return union(
        origins(declaration.initializer, seen, inputScope),
        ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const ? [] : ["unknown"],
      );
    }
    if (
      ts.isImportSpecifier(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportClause(declaration)
    ) {
      const owner = ts.findAncestor(declaration, ts.isImportDeclaration);
      const namespace =
        owner && ts.isStringLiteral(owner.moduleSpecifier)
          ? namespaces.get(owner.moduleSpecifier.text)
          : undefined;
      if (namespace) {
        return ts.isImportSpecifier(declaration)
          ? memberOrigins([namespace], (declaration.propertyName ?? declaration.name).text)
          : [namespace];
      }
    }
    return ["unknown"];
  }
  function pure(node: ts.Expression, scope: ts.Node): boolean {
    // Admission is closed: coercion, iteration, defaults and unknown syntax may execute caller code.
    if (ts.isIdentifier(node)) {
      return Boolean(symbolAt(node)) || ambient.has(node.text) || node.text === "undefined";
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
        node.kind,
      )
    ) {
      return true;
    }
    if (ts.isParenthesizedExpression(node)) {
      return pure(node.expression, scope);
    }
    if (ts.isBinaryExpression(node)) {
      return (
        logical.has(node.operatorToken.kind) &&
        node.operatorToken.kind < ts.SyntaxKind.FirstAssignment &&
        pure(node.left, scope) &&
        pure(node.right, scope)
      );
    }
    if (ts.isConditionalExpression(node)) {
      return (
        pure(node.condition, scope) && pure(node.whenTrue, scope) && pure(node.whenFalse, scope)
      );
    }
    if (ts.isAwaitExpression(node)) {
      let value: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(value)) {
        value = value.expression;
      }
      if (!ts.isCallExpression(value)) {
        return false;
      }
      const specifier = literal(value.arguments[0]);
      const native = origins(value.expression, new Set(), scope).every(
        (origin) => origin === "realpath-async",
      );
      const builtin =
        value.expression.kind === ts.SyntaxKind.ImportKeyword &&
        specifier !== undefined &&
        namespaces.has(specifier);
      return (native || builtin) && pure(value, scope);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (origins(node, new Set(), scope).includes("location")) {
        return true;
      }
      return (
        origins(node.expression, new Set(), scope).every((value) => readableValues.has(value)) &&
        pure(node.expression, scope) &&
        (!ts.isElementAccessExpression(node) || literal(node.argumentExpression) !== undefined)
      );
    }
    if (!ts.isCallExpression(node)) {
      return false;
    }
    const builtin = literal(node.arguments[0]);
    const builtinCall =
      builtin !== undefined && namespaces.has(builtin) && node.arguments.length === 1;
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return builtinCall;
    }
    return (
      origins(node.expression, new Set(), scope).every(
        (value) =>
          (pureCalls.has(value) &&
            (value === "join" ||
              value === "resolve" ||
              node.arguments.length === (value === "cwd" ? 0 : 1))) ||
          (loaders.has(value) && builtinCall),
      ) &&
      pure(node.expression, scope) &&
      node.arguments.every((argument) => pure(argument, scope))
    );
  }
  changedCwd = cwdReferences.some((reference) =>
    (ts.isImportSpecifier(reference) || ts.isBindingElement(reference)
      ? declarationOrigins(reference, new Set())
      : origins(reference)
    ).includes("chdir"),
  );
  // Effects or control flow end admission; later loaders may still use captured immutable paths.
  for (const scope of scopes.toSorted((a, b) => a.pos - b.pos)) {
    const body = ts.isSourceFile(scope) ? scope : scope.body;
    if (!body || (!ts.isSourceFile(body) && !ts.isBlock(body))) {
      continue;
    }
    if (
      !ts.isSourceFile(scope) &&
      scope.parameters.some(
        (parameter) =>
          !ts.isIdentifier(parameter.name) ||
          Boolean(parameter.initializer) ||
          Boolean(parameter.dotDotDotToken),
      )
    ) {
      continue;
    }
    prefix: for (const statement of body.statements) {
      if (
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isEmptyStatement(statement) ||
        (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression))
      ) {
        continue;
      }
      if (
        !ts.isVariableStatement(statement) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const)
      ) {
        break;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !declaration.initializer ||
          !pure(declaration.initializer, scope)
        ) {
          break prefix;
        }
        const values = origins(declaration.initializer, new Set(), scope);
        if (
          !values.every(
            (value) =>
              snapshotsKinds.has(value) ||
              ["literal", "relative", ...namespaces.values(), ...pureCalls].includes(value),
          )
        ) {
          break prefix;
        }
        const symbol = symbolAt(declaration.name);
        if (symbol && values.every((value) => snapshotsKinds.has(value))) {
          snapshots.set(symbol, values);
        }
      }
    }
  }
  for (const node of calls) {
    const specifier = literal(node.arguments[0]);
    if (node.arguments.length !== 1 || specifier === undefined) {
      continue;
    }
    const values = origins(node.expression);
    let callee: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    // Unproven literal require calls retain the original conservative manifest check.
    if (
      values.includes("root") ||
      (ts.isIdentifier(callee) &&
        callee.text === "require" &&
        !values.every((value) => value === "caller"))
    ) {
      recordImport(specifier, node.arguments[0]!);
    }
  }
  return imports;
}
