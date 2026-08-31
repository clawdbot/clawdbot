import {
  tokenizer,
  type AnyNode,
  type CallExpression,
  type Identifier,
  type ObjectExpression,
} from "acorn";
import {
  buildCodeModeScriptParseSource,
  parseCodeModeScriptSyntax,
} from "../../../agents/code-mode-script-syntax.js";

type TriggerScriptMigration =
  | { kind: "current" }
  | { kind: "unsupported" }
  | { kind: "supported"; script: string };

type SyntaxVisit = { node: AnyNode; ancestors: AnyNode[] };
type SourceEdit = { start: number; end: number; replacement: string };

function sourceContainsComment(source: string): boolean {
  let hasComment = false;
  const tokens = tokenizer(source, {
    ecmaVersion: "latest",
    onComment: () => {
      hasComment = true;
    },
  });
  while (tokens.getToken().type.label !== "eof") {
    if (hasComment) {
      return true;
    }
  }
  return hasComment;
}

function isSyntaxNode(value: unknown): value is AnyNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}

function collectSyntaxVisits(node: AnyNode, ancestors: AnyNode[] = []): SyntaxVisit[] {
  const visits: SyntaxVisit[] = [{ node, ancestors }];
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isSyntaxNode(child)) {
        visits.push(...collectSyntaxVisits(child, [...ancestors, node]));
      }
    }
  }
  return visits;
}

function isNoncomputedPropertyName(node: AnyNode, parent: AnyNode | undefined): boolean {
  return (
    (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
  );
}

function isStaticPlainObjectArgument(node: AnyNode): node is ObjectExpression {
  return (
    node.type === "ObjectExpression" &&
    node.properties.every(
      (property) =>
        property.type === "Property" &&
        property.kind === "init" &&
        !property.computed &&
        !property.method,
    )
  );
}

function legacyToolCall(node: AnyNode): CallExpression | undefined {
  if (node.type !== "CallExpression") {
    return undefined;
  }
  const call = node;
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.optional ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "tools" ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "call" ||
    call.optional ||
    call.arguments.length !== 2
  ) {
    return undefined;
  }
  const [toolName, args] = call.arguments;
  return toolName?.type === "Literal" &&
    toolName.value === "exec" &&
    args &&
    isStaticPlainObjectArgument(args)
    ? call
    : undefined;
}

/** Rewrite only the exact v2026.7.1 Cron trigger idiom; custom legacy code stays untouched. */
export function migrateLegacyCronTriggerScript(script: string): TriggerScriptMigration {
  const parsed = parseCodeModeScriptSyntax(script);
  if (!parsed.ok) {
    return { kind: "unsupported" };
  }
  const wrapper = parsed.program.body[0];
  if (
    wrapper?.type !== "ExpressionStatement" ||
    wrapper.expression.type !== "ArrowFunctionExpression" ||
    wrapper.expression.body.type !== "BlockStatement"
  ) {
    return { kind: "unsupported" };
  }
  const body = wrapper.expression.body;
  const visits = collectSyntaxVisits(body);
  const accessesLegacyGlobal = visits.some(({ node, ancestors }) => {
    if (node.type !== "MemberExpression") {
      return false;
    }
    const receiver = node.object;
    const isGlobalObject = receiver.type === "Identifier" && receiver.name === "globalThis";
    const isTopLevelThis =
      receiver.type === "ThisExpression" &&
      !ancestors.some(
        (ancestor) =>
          ancestor.type === "FunctionDeclaration" || ancestor.type === "FunctionExpression",
      );
    if (!isGlobalObject && !isTopLevelThis) {
      return false;
    }
    const property = node.property;
    const name = node.computed
      ? property.type === "Literal"
        ? property.value
        : undefined
      : property.type === "Identifier"
        ? property.name
        : undefined;
    return name === "tools" || name === "ALL_TOOLS";
  });
  if (accessesLegacyGlobal) {
    return { kind: "unsupported" };
  }
  const legacyIdentifiers = visits.filter(({ node, ancestors }) => {
    if (node.type !== "Identifier") {
      return false;
    }
    return (
      (node.name === "tools" || node.name === "ALL_TOOLS") &&
      !isNoncomputedPropertyName(node, ancestors.at(-1))
    );
  });
  if (legacyIdentifiers.length === 0) {
    return { kind: "current" };
  }

  const edits: SourceEdit[] = [];
  const bindings = new Map<string, Identifier>();
  const recognizedTools = new Set<AnyNode>();
  const { codeOffset } = buildCodeModeScriptParseSource(script);

  for (const { node, ancestors } of visits) {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "WithStatement"
    ) {
      return { kind: "unsupported" };
    }
    const call = legacyToolCall(node);
    if (!call) {
      continue;
    }
    const parent = ancestors.at(-1);
    const awaited = parent?.type === "AwaitExpression";
    const expression = awaited ? parent : node;
    const owner = ancestors.at(awaited ? -2 : -1);
    const statement = ancestors.at(awaited ? -4 : -3);
    if (owner?.type === "VariableDeclarator") {
      const declaration = ancestors.at(awaited ? -3 : -2);
      const declarator = owner;
      if (
        !awaited ||
        declaration?.type !== "VariableDeclaration" ||
        declaration.kind !== "const" ||
        declaration.declarations.length !== 1 ||
        statement !== body ||
        declarator.id.type !== "Identifier" ||
        declarator.init !== expression ||
        declarator.id.name === "exec" ||
        bindings.has(declarator.id.name)
      ) {
        return { kind: "unsupported" };
      }
      bindings.set(declarator.id.name, declarator.id);
    } else if (owner?.type !== "ExpressionStatement" || ancestors.at(awaited ? -3 : -2) !== body) {
      return { kind: "unsupported" };
    }
    if (call.callee.type !== "MemberExpression") {
      return { kind: "unsupported" };
    }
    recognizedTools.add(call.callee.object);
    const args = call.arguments[1];
    if (!args) {
      return { kind: "unsupported" };
    }
    const removedPrefix = script.slice(call.start - codeOffset, args.start - codeOffset);
    if (sourceContainsComment(removedPrefix)) {
      return { kind: "unsupported" };
    }
    edits.push({
      start: call.start - codeOffset,
      end: args.start - codeOffset,
      replacement: "exec(",
    });
  }

  for (const { node, ancestors } of visits) {
    if (node.type !== "Identifier") {
      continue;
    }
    const parent = ancestors.at(-1);
    if (isNoncomputedPropertyName(node, parent)) {
      continue;
    }
    if (node.name === "tools" || node.name === "ALL_TOOLS") {
      if (!recognizedTools.has(node)) {
        return { kind: "unsupported" };
      }
      continue;
    }
    if (node.name === "exec") {
      if (parent?.type !== "CallExpression" || parent.callee !== node) {
        return { kind: "unsupported" };
      }
      continue;
    }
    const declaration = bindings.get(node.name);
    if (!declaration || declaration === node) {
      continue;
    }
    const result = parent;
    const details = ancestors.at(-2);
    if (
      result?.type !== "MemberExpression" ||
      result.object !== node ||
      result.computed ||
      result.property.type !== "Identifier" ||
      result.property.name !== "result" ||
      details?.type !== "MemberExpression" ||
      details.object !== result ||
      details.computed ||
      details.property.type !== "Identifier" ||
      details.property.name !== "details"
    ) {
      return { kind: "unsupported" };
    }
    if (sourceContainsComment(script.slice(node.end - codeOffset, details.end - codeOffset))) {
      return { kind: "unsupported" };
    }
    edits.push({ start: node.end - codeOffset, end: details.end - codeOffset, replacement: "" });
  }

  if (recognizedTools.size !== legacyIdentifiers.length || edits.length === 0) {
    return { kind: "unsupported" };
  }
  let rewritten = script;
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
  }
  const result = migrateLegacyCronTriggerScript(rewritten);
  return result.kind === "current"
    ? { kind: "supported", script: rewritten }
    : { kind: "unsupported" };
}
