import { parse } from "acorn";

const RESERVED_TOOLS_MODULE = "tools";

type ImportSpecifierNode = {
  type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" | "ImportSpecifier";
  local: { name: string };
  imported?: { name?: string; value?: string };
  importKind?: string;
};

type ImportDeclarationNode = {
  type: "ImportDeclaration";
  start: number;
  end: number;
  source: { start: number; end: number; value?: unknown };
  specifiers: ImportSpecifierNode[];
  attributes?: unknown[];
  assertions?: unknown[];
  importKind?: string;
};

type Replacement = { start: number; end: number; value: string };

function mayContainReservedToolsImport(code: string): boolean {
  return /\bimport\b[\s\S]*?(?:\bfrom\s*)?["']tools["']/u.test(code);
}

function applyReplacements(code: string, replacements: readonly Replacement[]): string {
  let normalized = code;
  for (const replacement of replacements.toReversed()) {
    normalized =
      normalized.slice(0, replacement.start) +
      replacement.value +
      normalized.slice(replacement.end);
  }
  return normalized;
}

function generatedBindingNames(declarations: readonly string[]): Array<string | undefined> {
  return declarations.map((bindingDeclaration) => bindingDeclaration.split(/\s+/u)[1]);
}

function consumeFollowingLineBreak(code: string, end: number): number {
  if (code.startsWith("\r\n", end)) {
    return end + 2;
  }
  return code[end] === "\n" || code[end] === "\r" ? end + 1 : end;
}

export function normalizeReservedToolsImportsJavaScript(code: string): string {
  if (!mayContainReservedToolsImport(code)) {
    return code;
  }
  let source: { body: Array<ImportDeclarationNode | { type: string }> };
  try {
    source = parse(code, {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      ecmaVersion: "latest",
      sourceType: "module",
    }) as unknown as typeof source;
  } catch {
    return code;
  }
  const replacements: Replacement[] = [];
  const hoistedDeclarations: string[] = [];
  const generatedBindings = new Set<string>();
  for (const statement of source.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as ImportDeclarationNode;
    if (declaration.source.value !== RESERVED_TOOLS_MODULE) {
      continue;
    }
    const rawModuleSpecifier = code.slice(declaration.source.start, declaration.source.end);
    if (
      (rawModuleSpecifier !== '"tools"' && rawModuleSpecifier !== "'tools'") ||
      declaration.attributes?.length ||
      declaration.assertions?.length ||
      declaration.importKind === "type"
    ) {
      return code;
    }
    const declarations: string[] = [];
    for (const specifier of declaration.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") {
        return code;
      }
      if (specifier.type === "ImportNamespaceSpecifier") {
        if (specifier.local.name !== RESERVED_TOOLS_MODULE) {
          declarations.push(`const ${specifier.local.name} = this.tools;`);
        }
        continue;
      }
      if (specifier.importKind === "type") {
        continue;
      }
      const importedName = specifier.imported?.name ?? specifier.imported?.value;
      const localName = specifier.local.name;
      if (
        typeof importedName !== "string" ||
        importedName === "default" ||
        localName === RESERVED_TOOLS_MODULE
      ) {
        return code;
      }
      declarations.push(`const ${localName} = this.tools[${JSON.stringify(importedName)}];`);
    }
    const names = generatedBindingNames(declarations);
    if (names.some((name) => !name || generatedBindings.has(name))) {
      return code;
    }
    names.forEach((name) => generatedBindings.add(name!));
    hoistedDeclarations.push(...declarations);
    replacements.push({
      start: declaration.start,
      end: consumeFollowingLineBreak(code, declaration.end),
      value: "",
    });
  }
  const normalized = applyReplacements(code, replacements);
  return hoistedDeclarations.length > 0
    ? `${hoistedDeclarations.join("\n")}\n${normalized}`
    : normalized;
}

function renderTypeScriptImport(
  statement: import("typescript").ImportDeclaration,
  ts: typeof import("typescript"),
): string | undefined {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) {
    return "";
  }
  const importWithAttributes = statement as import("typescript").ImportDeclaration & {
    attributes?: unknown;
    assertClause?: unknown;
  };
  if (clause.name || importWithAttributes.attributes || importWithAttributes.assertClause) {
    return undefined;
  }
  const declarations: string[] = [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    if (bindings.name.text !== RESERVED_TOOLS_MODULE) {
      declarations.push(`const ${bindings.name.text} = this.tools;`);
    }
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      const localName = element.name.text;
      if (localName === RESERVED_TOOLS_MODULE) {
        return undefined;
      }
      const importedName = element.propertyName?.text ?? localName;
      if (importedName === "default") {
        return undefined;
      }
      declarations.push(`const ${localName} = this.tools[${JSON.stringify(importedName)}];`);
    }
  }
  return declarations.join("\n");
}

export function normalizeReservedToolsImportsTypeScript(
  code: string,
  ts: typeof import("typescript"),
): string {
  if (!mayContainReservedToolsImport(code)) {
    return code;
  }
  const source = ts.createSourceFile(
    "code-mode.ts",
    code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    source as import("typescript").SourceFile & {
      parseDiagnostics?: readonly import("typescript").Diagnostic[];
    }
  ).parseDiagnostics;
  if (parseDiagnostics?.length) {
    return code;
  }
  const replacements: Replacement[] = [];
  const hoistedDeclarations: string[] = [];
  const generatedBindings = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== RESERVED_TOOLS_MODULE
    ) {
      continue;
    }
    const rawModuleSpecifier = statement.moduleSpecifier.getText(source);
    if (rawModuleSpecifier !== '"tools"' && rawModuleSpecifier !== "'tools'") {
      return code;
    }
    const value = renderTypeScriptImport(statement, ts);
    if (value === undefined) {
      return code;
    }
    const names = Array.from(
      value.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu),
      (match) => match[1],
    );
    if (names.some((name) => name === undefined || generatedBindings.has(name))) {
      return code;
    }
    for (const name of names) {
      if (name) {
        generatedBindings.add(name);
      }
    }
    if (value) {
      hoistedDeclarations.push(value);
    }
    replacements.push({
      start: statement.getStart(source),
      end: consumeFollowingLineBreak(code, statement.getEnd()),
      value: "",
    });
  }
  const normalized = applyReplacements(code, replacements);
  return hoistedDeclarations.length > 0
    ? `${hoistedDeclarations.join("\n")}\n${normalized}`
    : normalized;
}
