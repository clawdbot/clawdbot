import { parse } from "acorn";

type CodeModeAstNode = {
  type: string;
  start: number;
  end: number;
  name?: string;
  argument?: CodeModeAstNode;
  callee?: CodeModeAstNode;
  expression?: CodeModeAstNode;
  object?: CodeModeAstNode;
};

const AUTO_RETURN_GUEST_ROOTS = new Set(["API", "MCP", "agents", "nodes", "skills", "tools"]);

function isCodeModeAstNode(value: unknown): value is CodeModeAstNode {
  return Boolean(
    value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string",
  );
}

function expressionRootIdentifier(node: CodeModeAstNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "ChainExpression" || node.type === "AwaitExpression") {
    return expressionRootIdentifier(node.expression ?? node.argument);
  }
  if (node.type === "CallExpression") {
    return expressionRootIdentifier(node.callee);
  }
  if (node.type === "MemberExpression") {
    return expressionRootIdentifier(node.object);
  }
  return node.type === "Identifier" ? node.name : undefined;
}

function guestCallRootIdentifier(node: CodeModeAstNode | undefined): string | undefined {
  if (node?.type === "ChainExpression" || node?.type === "AwaitExpression") {
    return guestCallRootIdentifier(node.expression ?? node.argument);
  }
  if (node?.type === "MemberExpression") {
    return guestCallRootIdentifier(node.object);
  }
  return node?.type === "CallExpression" ? expressionRootIdentifier(node.callee) : undefined;
}

function patternBindsIdentifier(node: unknown, name: string): boolean {
  if (!isCodeModeAstNode(node)) {
    return false;
  }
  if (node.type === "Identifier") {
    return node.name === name;
  }
  if (node.type === "RestElement") {
    return patternBindsIdentifier(node.argument, name);
  }
  if (node.type === "AssignmentPattern") {
    return patternBindsIdentifier((node as { left?: unknown }).left, name);
  }
  if (node.type === "ArrayPattern") {
    return ((node as { elements?: unknown[] }).elements ?? []).some((element) =>
      patternBindsIdentifier(element, name),
    );
  }
  if (node.type === "ObjectPattern") {
    return ((node as { properties?: unknown[] }).properties ?? []).some((property) => {
      if (!isCodeModeAstNode(property)) {
        return false;
      }
      return property.type === "Property"
        ? patternBindsIdentifier((property as { value?: unknown }).value, name)
        : patternBindsIdentifier(property.argument, name);
    });
  }
  return false;
}

function isFunctionNode(node: CodeModeAstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function variableDeclarationBindsIdentifier(
  node: CodeModeAstNode,
  name: string,
  kinds: ReadonlySet<string>,
): boolean {
  if (
    node.type !== "VariableDeclaration" ||
    !kinds.has(String((node as { kind?: unknown }).kind))
  ) {
    return false;
  }
  return ((node as { declarations?: Array<{ id?: unknown }> }).declarations ?? []).some(
    (declaration) => patternBindsIdentifier(declaration.id, name),
  );
}

function directStatementsBindIdentifier(
  statements: readonly CodeModeAstNode[],
  name: string,
  variableKinds: ReadonlySet<string>,
): boolean {
  return statements.some(
    (statement) =>
      variableDeclarationBindsIdentifier(statement, name, variableKinds) ||
      ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
        patternBindsIdentifier((statement as { id?: unknown }).id, name)),
  );
}

function containsVarBinding(value: unknown, name: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsVarBinding(item, name));
  }
  if (!isCodeModeAstNode(value)) {
    return false;
  }
  if (isFunctionNode(value)) {
    return false;
  }
  if (variableDeclarationBindsIdentifier(value, name, new Set(["var"]))) {
    return true;
  }
  return Object.entries(value).some(
    ([key, child]) =>
      key !== "type" &&
      key !== "start" &&
      key !== "end" &&
      key !== "loc" &&
      containsVarBinding(child, name),
  );
}

function functionScopeBindsIdentifier(node: CodeModeAstNode, name: string): boolean {
  if (
    patternBindsIdentifier((node as { id?: unknown }).id, name) ||
    ((node as { params?: unknown[] }).params ?? []).some((param) =>
      patternBindsIdentifier(param, name),
    )
  ) {
    return true;
  }
  const body = (node as { body?: unknown }).body;
  if (!isCodeModeAstNode(body) || body.type !== "BlockStatement") {
    return false;
  }
  const statements = (body as { body?: CodeModeAstNode[] }).body ?? [];
  return (
    directStatementsBindIdentifier(statements, name, new Set(["let", "const"])) ||
    containsVarBinding(statements, name)
  );
}

function blockScopeBindsIdentifier(node: CodeModeAstNode, name: string): boolean {
  const statements = (node as { body?: CodeModeAstNode[] }).body ?? [];
  return directStatementsBindIdentifier(statements, name, new Set(["let", "const"]));
}

function targetWritesIdentifier(node: unknown, name: string): boolean {
  return (
    patternBindsIdentifier(node, name) ||
    expressionRootIdentifier(isCodeModeAstNode(node) ? node : undefined) === name
  );
}

function astWritesIdentifier(value: unknown, name: string, shadowed = false): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => astWritesIdentifier(item, name, shadowed));
  }
  if (!isCodeModeAstNode(value)) {
    return false;
  }
  if (isFunctionNode(value)) {
    const functionShadowed = shadowed || functionScopeBindsIdentifier(value, name);
    return astWritesIdentifier((value as { body?: unknown }).body, name, functionShadowed);
  }
  if (value.type === "BlockStatement") {
    return astWritesIdentifier(
      (value as { body?: unknown[] }).body,
      name,
      shadowed || blockScopeBindsIdentifier(value, name),
    );
  }
  if (value.type === "CatchClause") {
    return astWritesIdentifier(
      (value as { body?: unknown }).body,
      name,
      shadowed || patternBindsIdentifier((value as { param?: unknown }).param, name),
    );
  }
  if (value.type === "ForInStatement" || value.type === "ForOfStatement") {
    const left = (value as { left?: CodeModeAstNode }).left;
    if (!shadowed && left?.type !== "VariableDeclaration" && targetWritesIdentifier(left, name)) {
      return true;
    }
    const loopShadowed =
      shadowed ||
      Boolean(left && variableDeclarationBindsIdentifier(left, name, new Set(["let", "const"])));
    return (
      astWritesIdentifier((value as { right?: unknown }).right, name, shadowed) ||
      astWritesIdentifier((value as { body?: unknown }).body, name, loopShadowed)
    );
  }
  if (value.type === "ForStatement") {
    const init = (value as { init?: CodeModeAstNode }).init;
    const loopShadowed =
      shadowed ||
      Boolean(init && variableDeclarationBindsIdentifier(init, name, new Set(["let", "const"])));
    return (
      astWritesIdentifier(init, name, loopShadowed) ||
      astWritesIdentifier((value as { test?: unknown }).test, name, loopShadowed) ||
      astWritesIdentifier((value as { update?: unknown }).update, name, loopShadowed) ||
      astWritesIdentifier((value as { body?: unknown }).body, name, loopShadowed)
    );
  }
  if (
    !shadowed &&
    value.type === "AssignmentExpression" &&
    targetWritesIdentifier((value as { left?: unknown }).left, name)
  ) {
    return true;
  }
  if (
    !shadowed &&
    value.type === "UpdateExpression" &&
    targetWritesIdentifier(value.argument, name)
  ) {
    return true;
  }
  if (
    !shadowed &&
    value.type === "UnaryExpression" &&
    (value as { operator?: unknown }).operator === "delete" &&
    targetWritesIdentifier(value.argument, name)
  ) {
    return true;
  }
  return Object.entries(value).some(
    ([key, child]) =>
      key !== "type" &&
      key !== "start" &&
      key !== "end" &&
      key !== "loc" &&
      astWritesIdentifier(child, name, shadowed),
  );
}

function programScopeBindsIdentifier(
  statements: readonly CodeModeAstNode[],
  name: string,
): boolean {
  return (
    directStatementsBindIdentifier(statements, name, new Set(["var", "let", "const"])) ||
    containsVarBinding(statements, name)
  );
}

function isIdentifierReference(
  parent: CodeModeAstNode | undefined,
  key: string | undefined,
): boolean {
  if (!parent || !key) {
    return true;
  }
  if (
    parent.type === "MemberExpression" &&
    key === "property" &&
    !(parent as { computed?: boolean }).computed
  ) {
    return false;
  }
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    key === "key" &&
    !(parent as { computed?: boolean }).computed
  ) {
    return false;
  }
  if (
    (parent.type === "LabeledStatement" ||
      parent.type === "BreakStatement" ||
      parent.type === "ContinueStatement") &&
    key === "label"
  ) {
    return false;
  }
  if (parent.type === "MetaProperty") {
    return false;
  }
  return !(
    (parent.type === "VariableDeclarator" && key === "id") ||
    ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") && key === "id")
  );
}

function expressionReferencesProgramBinding(
  value: unknown,
  statements: readonly CodeModeAstNode[],
  parent?: CodeModeAstNode,
  key?: string,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => expressionReferencesProgramBinding(item, statements, parent, key));
  }
  if (!isCodeModeAstNode(value)) {
    return false;
  }
  // A nested function's own result is not the value of the trailing expression.
  // Keep auto-return scoped to references evaluated by the expression itself.
  if (isFunctionNode(value)) {
    return false;
  }
  if (
    value.type === "Identifier" &&
    value.name &&
    isIdentifierReference(parent, key) &&
    programScopeBindsIdentifier(statements, value.name)
  ) {
    return true;
  }
  return Object.entries(value).some(
    ([childKey, child]) =>
      childKey !== "type" &&
      childKey !== "start" &&
      childKey !== "end" &&
      childKey !== "loc" &&
      expressionReferencesProgramBinding(child, statements, value, childKey),
  );
}

function expressionContainsGuestCall(
  value: unknown,
  statements: readonly CodeModeAstNode[],
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => expressionContainsGuestCall(item, statements));
  }
  if (!isCodeModeAstNode(value) || isFunctionNode(value)) {
    return false;
  }
  if (value.type === "CallExpression") {
    const root = expressionRootIdentifier(value.callee);
    if (
      root &&
      AUTO_RETURN_GUEST_ROOTS.has(root) &&
      !programScopeBindsIdentifier(statements, root) &&
      !astWritesIdentifier(statements, root) &&
      !astWritesIdentifier(value, root)
    ) {
      return true;
    }
  }
  return Object.entries(value).some(
    ([key, child]) =>
      key !== "type" &&
      key !== "start" &&
      key !== "end" &&
      key !== "loc" &&
      expressionContainsGuestCall(child, statements),
  );
}

export function autoReturnFinalGuestCall(code: string): string {
  try {
    const source = parse(code, {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      ecmaVersion: "latest",
    }) as unknown as { body: CodeModeAstNode[] };
    const statement = source.body.at(-1);
    if (statement?.type !== "ExpressionStatement") {
      return code;
    }
    const precedingStatements = source.body.slice(0, -1);
    if (
      statement.expression?.type === "Identifier" &&
      statement.expression.name &&
      programScopeBindsIdentifier(precedingStatements, statement.expression.name)
    ) {
      return `${code.slice(0, statement.start)}return ${code.slice(statement.start)}`;
    }
    const localRoot = expressionRootIdentifier(statement.expression);
    if (localRoot && programScopeBindsIdentifier(precedingStatements, localRoot)) {
      return `${code.slice(0, statement.start)}return ${code.slice(statement.start)}`;
    }
    const containsGuestCall = expressionContainsGuestCall(
      statement.expression,
      precedingStatements,
    );
    if (
      !containsGuestCall &&
      expressionReferencesProgramBinding(statement.expression, precedingStatements)
    ) {
      return `${code.slice(0, statement.start)}return ${code.slice(statement.start)}`;
    }
    const root = guestCallRootIdentifier(statement.expression);
    if (!root || !AUTO_RETURN_GUEST_ROOTS.has(root)) {
      return code;
    }
    if (
      programScopeBindsIdentifier(precedingStatements, root) ||
      astWritesIdentifier(precedingStatements, root)
    ) {
      return code;
    }
    return `${code.slice(0, statement.start)}return ${code.slice(statement.start)}`;
  } catch {
    return code;
  }
}
