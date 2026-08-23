import {
  BOUNDARY_GUARD_FIXTURE_ROOT,
  CHAINED_ASSERTION_EXCLUDED_ROOTS,
  TYPE_ASSERTION_PRODUCTION_ROOTS,
  TYPE_ASSERTION_TEST_FILE_SUFFIXES,
  isSkippedTypeAssertionTestPath,
  pathMatchesTypeAssertionRoot,
} from "./lib/type-assertion-guard-scope.mjs";

const EXPRESSION_WRAPPER_RE =
  /^(?:ChainExpression|ParenthesizedExpression|TSAsExpression|TSNonNullExpression|TSTypeAssertion)$/;

function unwrapExpression(node) {
  let current = node;
  while (EXPRESSION_WRAPPER_RE.test(current.type)) {
    current = current.expression;
  }
  return current;
}

function restrictedCallRule({ allowedFiles = [], message, objects, property, roots }) {
  return {
    create(context) {
      const filename = context.physicalFilename.replaceAll("\\", "/");
      const cwd = context.cwd.replaceAll("\\", "/");
      const repoPath = filename.startsWith(`${cwd}/`) ? filename.slice(cwd.length + 1) : filename;
      if (
        !filename.endsWith(".ts") ||
        !roots.some((root) => pathMatchesTypeAssertionRoot(repoPath, root)) ||
        TYPE_ASSERTION_TEST_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix)) ||
        allowedFiles.includes(repoPath)
      ) {
        return {};
      }
      return {
        CallExpression(node) {
          const callee = unwrapExpression(node.callee);
          if (
            callee.type !== "MemberExpression" ||
            callee.computed ||
            callee.property.type !== "Identifier" ||
            callee.property.name !== property
          ) {
            return;
          }
          const receiver = unwrapExpression(callee.object);
          if (objects && (receiver.type !== "Identifier" || !objects.includes(receiver.name))) {
            return;
          }
          context.report({ message, node: node.callee });
        },
      };
    },
  };
}

// Adapted from dmmulroy/anti-slop@446268e5d15baa968eaec669ff65358d36ae6259, MIT.
function isTypeAssertionExpression(node) {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function isConstAssertion(node) {
  const { typeAnnotation } = node;
  return (
    typeAnnotation.type === "TSTypeReference" &&
    typeAnnotation.typeName.type === "Identifier" &&
    typeAnnotation.typeName.name === "const"
  );
}

function isOutermostAssertionInChain(node) {
  let current = node;
  let parent = node.parent;

  while (parent.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }

  return !isTypeAssertionExpression(parent) || parent.expression !== current;
}

function isForbiddenAssertionChain(node) {
  let assertionCount = 0;
  let hasNonConstAssertion = false;
  let current = node;

  while (isTypeAssertionExpression(current)) {
    assertionCount += 1;
    hasNonConstAssertion ||= !isConstAssertion(current);
    current = unwrapExpressionParentheses(current.expression);
  }

  return assertionCount > 1 && hasNonConstAssertion;
}

function noChainedTypeAssertionsRule({ excludedRoots = [], roots }) {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow chained TypeScript as and angle-bracket assertions, including parenthesized chains.",
      },
      messages: {
        chained:
          "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.",
      },
    },
    create(context) {
      const filename = context.physicalFilename.replaceAll("\\", "/");
      const cwd = context.cwd.replaceAll("\\", "/");
      const repoPath = filename.startsWith(`${cwd}/`) ? filename.slice(cwd.length + 1) : filename;
      if (
        !roots.some((root) => pathMatchesTypeAssertionRoot(repoPath, root)) ||
        excludedRoots.some((root) => pathMatchesTypeAssertionRoot(repoPath, root)) ||
        isSkippedTypeAssertionTestPath(repoPath)
      ) {
        return {};
      }

      const checkTypeAssertion = (node) => {
        if (!isOutermostAssertionInChain(node) || !isForbiddenAssertionChain(node)) {
          return;
        }
        context.report({ node, messageId: "chained" });
      };

      return {
        TSAsExpression: checkTypeAssertion,
        TSTypeAssertion: checkTypeAssertion,
      };
    },
  };
}

// Adapted from dmmulroy/anti-slop, MIT.
const FUNCTION_BOUNDARY_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);
const MAX_TRANSPARENT_ALIAS_DEPTH = 32;

function unwrapExpressionParentheses(expression) {
  let current = expression;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

function unwrapTypeParentheses(type) {
  let current = type;
  while (current.type === "TSParenthesizedType") {
    current = current.typeAnnotation;
  }
  return current;
}

function typeReferenceName(type) {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isUnknownOrAnyType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  return unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword";
}

function isBroadRecordKeyType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.every(isBroadRecordKeyType);
  }
  return unwrapped.type === "TSTypeReference" && typeReferenceName(unwrapped) === "PropertyKey";
}

function isBroadRecordType(type) {
  const unwrapped = unwrapTypeParentheses(type);

  if (unwrapped.type === "TSTypeReference") {
    if (typeReferenceName(unwrapped) === "Readonly") {
      const [inner] = unwrapped.typeArguments?.params ?? [];
      return inner !== undefined && isBroadRecordType(inner);
    }

    if (typeReferenceName(unwrapped) !== "Record") {
      return false;
    }
    const parameters = unwrapped.typeArguments?.params ?? [];
    return (
      parameters.length === 2 &&
      parameters[0] !== undefined &&
      parameters[1] !== undefined &&
      isBroadRecordKeyType(parameters[0]) &&
      isUnknownOrAnyType(parameters[1])
    );
  }

  if (unwrapped.type !== "TSTypeLiteral" || unwrapped.members.length !== 1) {
    return false;
  }
  const [member] = unwrapped.members;
  const [parameter] = member?.type === "TSIndexSignature" ? member.parameters : [];
  return (
    member?.type === "TSIndexSignature" &&
    member.parameters.length === 1 &&
    parameter !== undefined &&
    isBroadRecordKeyType(parameter.typeAnnotation.typeAnnotation) &&
    isUnknownOrAnyType(member.typeAnnotation.typeAnnotation)
  );
}

function broadTypeKind(type) {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword") {
    return "top";
  }
  if (unwrapped.type === "TSObjectKeyword") {
    return "object";
  }
  return isBroadRecordType(unwrapped) ? "record" : null;
}

function assertedExpression(node) {
  return unwrapExpressionParentheses(node.expression);
}

function assertedIdentifier(node) {
  let expression = assertedExpression(node);
  while (expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") {
    expression = assertedExpression(expression);
  }
  return expression.type === "Identifier" ? expression : null;
}

function isNestedAssertion(node) {
  let parent = node.parent;
  while (parent?.type === "ParenthesizedExpression") {
    parent = parent.parent;
  }
  return (
    (parent?.type === "TSAsExpression" || parent?.type === "TSTypeAssertion") &&
    assertedExpression(parent) === node
  );
}

function assertionFromExpression(expression) {
  const unwrapped = unwrapExpressionParentheses(expression);
  return unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion"
    ? unwrapped
    : null;
}

function normalizedTypeText(sourceText, type) {
  return sourceText.slice(type.start, type.end).replaceAll(/\s+/gu, "");
}

function typesHaveSameSyntax(sourceText, left, right) {
  return (
    left !== null &&
    normalizedTypeText(sourceText, unwrapTypeParentheses(left)) ===
      normalizedTypeText(sourceText, unwrapTypeParentheses(right))
  );
}

function isDefinitelyObjectType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  switch (unwrapped.type) {
    case "TSArrayType":
    case "TSConstructorType":
    case "TSFunctionType":
    case "TSMappedType":
    case "TSObjectKeyword":
    case "TSTupleType":
      return true;
    case "TSTypeLiteral":
      return unwrapped.members.length > 0;
    case "TSIntersectionType":
      return unwrapped.types.every(isDefinitelyObjectType);
    case "TSTypeOperator":
      return unwrapped.operator === "readonly" && isDefinitelyObjectType(unwrapped.typeAnnotation);
    default:
      return false;
  }
}

function isDefinitelyNarrowerRecordType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type !== "TSIndexSignature");
  }

  if (unwrapped.type !== "TSTypeReference") {
    return false;
  }
  if (typeReferenceName(unwrapped) === "Readonly") {
    const [inner] = unwrapped.typeArguments?.params ?? [];
    return inner !== undefined && isDefinitelyNarrowerRecordType(inner);
  }
  if (typeReferenceName(unwrapped) !== "Record") {
    return false;
  }

  const parameters = unwrapped.typeArguments?.params ?? [];
  return (
    parameters.length === 2 && parameters[1] !== undefined && !isUnknownOrAnyType(parameters[1])
  );
}

function functionBoundary(node) {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (FUNCTION_BOUNDARY_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function resolvedVariableForIdentifier(scopes, identifier) {
  for (const scope of scopes) {
    const reference = scope.references.find(
      (candidate) =>
        candidate.identifier.start === identifier.start &&
        candidate.identifier.end === identifier.end,
    );
    if (reference !== undefined) {
      return reference.resolved;
    }
  }
  return null;
}

function variableDeclarator(variable) {
  for (const definition of variable.defs) {
    if (definition.type === "Variable" && definition.node.type === "VariableDeclarator") {
      return definition.node;
    }
  }
  return null;
}

function knownValueEvidence(expression, scopes, boundary, visitedVariables) {
  const unwrapped = unwrapExpressionParentheses(expression);

  if (unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion") {
    if (broadTypeKind(unwrapped.typeAnnotation) !== null) {
      return null;
    }
    return { type: unwrapped.typeAnnotation };
  }

  if (unwrapped.type === "Literal" || unwrapped.type === "TemplateLiteral") {
    return { type: null };
  }

  if (
    unwrapped.type === "ArrayExpression" ||
    unwrapped.type === "ArrowFunctionExpression" ||
    unwrapped.type === "ClassExpression" ||
    unwrapped.type === "FunctionExpression" ||
    unwrapped.type === "NewExpression" ||
    unwrapped.type === "ObjectExpression"
  ) {
    return { type: null };
  }

  if (unwrapped.type !== "Identifier") {
    return null;
  }
  const variable = resolvedVariableForIdentifier(scopes, unwrapped);
  if (variable === null || visitedVariables.has(variable)) {
    return null;
  }

  const annotatedIdentifier = variable.identifiers.find(
    (identifier) => identifier.typeAnnotation !== null && identifier.typeAnnotation !== undefined,
  );
  const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
  if (annotation !== undefined && annotatedIdentifier !== undefined) {
    if (functionBoundary(annotatedIdentifier) !== boundary || broadTypeKind(annotation) !== null) {
      return null;
    }
    return { type: annotation };
  }

  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.init === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init) ||
    functionBoundary(declarator) !== boundary
  ) {
    return null;
  }

  return knownValueEvidence(
    declarator.init,
    scopes,
    boundary,
    new Set([...visitedVariables, variable]),
  );
}

function widenedBinding(variable, scopes) {
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return null;
  }

  const boundary = functionBoundary(declarator);
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroadKind =
    initializerAssertion === null ? null : broadTypeKind(initializerAssertion.typeAnnotation);
  const declaredBroadKind = declaredType === undefined ? null : broadTypeKind(declaredType);
  const broadKind = declaredBroadKind ?? initializerBroadKind;
  if (broadKind === null) {
    return null;
  }

  const originalExpression =
    initializerAssertion !== null && initializerBroadKind !== null
      ? assertedExpression(initializerAssertion)
      : declarator.init;
  const evidence = knownValueEvidence(originalExpression, scopes, boundary, new Set([variable]));
  return evidence === null ? null : { broadKind, evidence, declaredAt: declarator.end, boundary };
}

function resolveWidenedBinding(variable, scopes, boundary, assertedAt) {
  const visitedVariables = new Set();
  let current = variable;
  for (let depth = 0; depth < MAX_TRANSPARENT_ALIAS_DEPTH; depth += 1) {
    if (visitedVariables.has(current)) {
      return null;
    }
    visitedVariables.add(current);

    const widened = widenedBinding(current, scopes);
    if (widened !== null) {
      return widened;
    }

    const declarator = variableDeclarator(current);
    if (
      declarator === null ||
      declarator.parent.type !== "VariableDeclaration" ||
      declarator.parent.kind !== "const" ||
      declarator.id.type !== "Identifier" ||
      (declarator.id.typeAnnotation !== null && declarator.id.typeAnnotation !== undefined) ||
      declarator.init === null ||
      declarator.end >= assertedAt ||
      current.references.some((reference) => reference.isWrite() && !reference.init) ||
      functionBoundary(declarator) !== boundary
    ) {
      return null;
    }

    const initializer = unwrapExpressionParentheses(declarator.init);
    if (initializer.type !== "Identifier") {
      return null;
    }
    current = resolvedVariableForIdentifier(scopes, initializer);
    if (current === null) {
      return null;
    }
  }
  return null;
}

function assertionIsNarrower(sourceText, broadKind, evidence, assertedType) {
  if (broadTypeKind(assertedType) !== null) {
    return false;
  }
  if (broadKind === "top") {
    return true;
  }
  if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) {
    return true;
  }
  if (broadKind === "object") {
    return isDefinitelyObjectType(assertedType);
  }
  return isDefinitelyNarrowerRecordType(assertedType);
}

function noWidenThenAssertRule({ roots }) {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
      },
      messages: {
        widenThenAssert:
          'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
      },
    },
    create(context) {
      const filename = context.physicalFilename.replaceAll("\\", "/");
      const cwd = context.cwd.replaceAll("\\", "/");
      const repoPath = filename.startsWith(`${cwd}/`) ? filename.slice(cwd.length + 1) : filename;
      if (!roots.some((root) => repoPath === root || repoPath.startsWith(`${root}/`))) {
        return {};
      }

      let scopes = [];
      const checkAssertion = (node) => {
        if (isNestedAssertion(node)) {
          return;
        }
        const expression = assertedIdentifier(node);
        if (expression === null) {
          return;
        }

        const variable = resolvedVariableForIdentifier(scopes, expression);
        if (variable === null) {
          return;
        }
        const boundary = functionBoundary(node);
        const widened = resolveWidenedBinding(variable, scopes, boundary, node.start);
        if (
          widened === null ||
          node.start <= widened.declaredAt ||
          boundary !== widened.boundary ||
          !assertionIsNarrower(
            context.sourceCode.text,
            widened.broadKind,
            widened.evidence,
            node.typeAnnotation,
          )
        ) {
          return;
        }

        context.report({
          node,
          messageId: "widenThenAssert",
          data: { name: expression.name },
        });
      };

      return {
        Program() {
          scopes = context.sourceCode.scopeManager.scopes;
        },
        TSAsExpression: checkAssertion,
        TSTypeAssertion: checkAssertion,
      };
    },
  };
}

export default {
  meta: { name: "openclaw-boundaries" },
  rules: {
    "no-raw-window-open-call": restrictedCallRule({
      allowedFiles: ["ui/src/lib/editor-links.ts", "ui/src/lib/open-external-url.ts"],
      roots: ["ui/src", "test/fixtures/oxlint-boundary-guards"],
      property: "open",
      objects: ["window", "globalThis"],
      message: "Use openExternalUrlSafe(...) from ui/src/lib/open-external-url.ts instead.",
    }),
    "no-register-http-handler-call": restrictedCallRule({
      roots: ["src", "extensions", "test/fixtures/oxlint-boundary-guards"],
      property: "registerHttpHandler",
      message:
        "Use registerHttpRoute({ path, auth, match, handler }) and registerPluginHttpRoute for dynamic webhook paths.",
    }),
    "no-widen-then-assert": noWidenThenAssertRule({
      roots: [...TYPE_ASSERTION_PRODUCTION_ROOTS, BOUNDARY_GUARD_FIXTURE_ROOT],
    }),
    "no-chained-type-assertions": noChainedTypeAssertionsRule({
      roots: [...TYPE_ASSERTION_PRODUCTION_ROOTS, BOUNDARY_GUARD_FIXTURE_ROOT],
      excludedRoots: CHAINED_ASSERTION_EXCLUDED_ROOTS,
    }),
  },
};
