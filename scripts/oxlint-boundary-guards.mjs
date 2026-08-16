const EXPRESSION_WRAPPER_RE =
  /^(?:ChainExpression|ParenthesizedExpression|TSAsExpression|TSNonNullExpression|TSTypeAssertion)$/;
const BOUNDARY_GUARD_FIXTURE_ROOT = "test/fixtures/oxlint-boundary-guards";
// Shared test-path policy for guards that intentionally exclude fixture, mock, and harness code.
const TEST_FILE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
  ".test-utils.ts",
  ".test-utils.tsx",
  ".test-harness.ts",
  ".test-harness.tsx",
  ".e2e-harness.ts",
  ".e2e-harness.tsx",
];
const TEST_PATH_MARKERS = [
  "/test/",
  "/tests/",
  "__tests__",
  "/e2e/",
  "test-helpers",
  "test-support",
  "test-fixtures",
  "test-mocks",
  "test-utils",
  "mock-http",
  "-harness.",
  ".test-utils.",
  "/mocks/",
];

function pathMatchesRoot(repoPath, root) {
  return repoPath === root || repoPath.startsWith(`${root}/`);
}

function isSkippedTestPath(repoPath) {
  if (pathMatchesRoot(repoPath, BOUNDARY_GUARD_FIXTURE_ROOT)) {
    return false;
  }
  const slashPrefixedPath = `/${repoPath}`;
  return (
    TEST_FILE_SUFFIXES.some((suffix) => repoPath.endsWith(suffix)) ||
    TEST_PATH_MARKERS.some((marker) => slashPrefixedPath.includes(marker))
  );
}

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
        !roots.some((root) => pathMatchesRoot(repoPath, root)) ||
        TEST_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix)) ||
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
        !roots.some((root) => pathMatchesRoot(repoPath, root)) ||
        excludedRoots.some((root) => pathMatchesRoot(repoPath, root)) ||
        isSkippedTestPath(repoPath)
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
      roots: ["src", "extensions", "packages", "ui/src", "test/fixtures/oxlint-boundary-guards"],
    }),
    "no-chained-type-assertions": noChainedTypeAssertionsRule({
      roots: ["src", "extensions", "packages", "ui/src", BOUNDARY_GUARD_FIXTURE_ROOT],
      // Burn-down ledger — shrink only; see PR #124060/#124073/#124079/#124082.
      excludedRoots: [
        "extensions/amazon-bedrock-mantle/mantle-anthropic.runtime.ts", // duplicate SDK installs make the Anthropic client class nominal
        "extensions/anthropic-vertex/stream-runtime.ts", // Undici and DOM fetch return types use distinct body namespaces
        "extensions/browser/src/browser/bridge-server.ts", // Express app crosses the browser route registrar SDK seam
        "extensions/browser/src/browser/pw-session-actions.ts", // Playwright role overloads cannot express runtime-selected roles
        "extensions/browser/src/browser/pw-session.page-cdp.ts", // Playwright CDP typings require a closed method-name map
        "extensions/browser/src/browser/pw-tools-core.interactions.navigation.ts", // navigation observation uses a narrowed Playwright page capability
        "extensions/browser/src/browser/pw-tools-core.state.ts", // Playwright CDP typings require a closed method-name map
        "extensions/browser/src/browser/server-context.remote-tab-ops.harness.ts", // test support
        "extensions/browser/src/browser/system-chrome-cookies.ts", // SQLite row results cross the browser cookie schema boundary
        "extensions/browser/src/cli/browser-cli-actions-input/register.batch.ts", // batch budgeting intentionally sees permissive actions before route validation
        "extensions/browser/src/server.ts", // Express app crosses the browser route registrar SDK seam
        "extensions/codex/src/app-server/event-projector-tool-transcript.ts", // Codex transcript synthesis extends the public AgentMessage union
        "extensions/codex/src/app-server/run-attempt-resources.ts", // staged attempt resources initialize required lifecycle fields later
        "extensions/codex/src/app-server/run-attempt-runtime.ts", // supervised Codex models bridge the agent-harness model generic
        "extensions/copilot/harness.ts", // test support
        "extensions/copilot/src/attempt-execution.ts", // Copilot SDK session implementations expose incompatible private shapes
        "extensions/copilot/src/attempt-transcript-journal.ts", // OpenClaw transcript metadata extends the public AgentMessage union
        "extensions/copilot/src/byok-proxy.ts", // DOM and Node readable streams use distinct type namespaces
        "extensions/copilot/src/isolated-completion.ts", // Copilot SDK isolated sessions expose a narrower private shape
        "extensions/copilot/src/runtime.ts", // staged Copilot client state initializes after async acquisition
        "extensions/copilot/src/tool-bridge.ts", // plugin tool metadata crosses duplicate SDK package types
        "extensions/diagnostics-otel/src/service.ts", // optional diagnostics capabilities are private runtime extensions
        "extensions/diagnostics-prometheus/src/service.ts", // exporter health reporting is a private diagnostics bridge
        "extensions/discord/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/discord/src/components.modal.ts", // test-only fallback preserves partially mocked Discord module graphs
        "extensions/discord/src/monitor/gateway-plugin.ts", // Discord gateway lifecycle needs private SDK state
        "extensions/discord/src/monitor/message-handler.hydration.ts", // hydrated Discord messages bridge SDK constructor-private fields
        "extensions/discord/src/monitor/provider.startup-log.ts", // reconnect attempts are private Discord gateway diagnostics
        "extensions/discord/src/monitor/threading.starter.ts", // Discord thread channels narrow a dependency union after runtime checks
        "extensions/github-copilot/index.ts", // config merge patches are intentionally deeper than Partial<OpenClawConfig>
        "extensions/google/realtime-voice-provider.ts", // provider tool schemas and lifecycle fields bridge Google SDK versions
        "extensions/google/transport-stream.ts", // transport stream seam; needs API redesign
        "extensions/googlechat/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/imessage/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/line/src/outbound.ts", // LINE batch overload requires a bounded tuple that slice cannot retain
        "extensions/llm-task/index.ts", // tool factory bridges plugin-local and public AgentTool package types
        "extensions/matrix/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/matrix/src/matrix/client/logging.ts", // Matrix SDK logger singleton has an undeclared loglevel capability
        "extensions/matrix/src/test-runtime.ts", // test support
        "extensions/msteams/src/attachments/shared.ts", // Vitest mock metadata is intentionally probed in production test support
        "extensions/msteams/src/sdk-proactive.ts", // proactive sends require private Teams app transport internals
        "extensions/msteams/src/sdk.ts", // Teams SDK public and deep-import types disagree across package boundaries
        "extensions/qa-lab/src/harness-runtime.ts", // test harness runtime implements the public PluginRuntime surface
        "extensions/qa-lab/src/suite-runtime-agent-session.ts", // symbol-keyed session metadata extends transcript entries
        "extensions/reef/protocol/envelope.ts", // signed version fields authenticate before unsupported versions are rejected
        "extensions/signal/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/slack/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/slack/src/monitor/events/agent.ts", // Slack app typings omit the agent event registrar
        "extensions/slack/src/monitor/events/assistant.ts", // Slack app typings omit the assistant event registrar
        "extensions/slack/src/monitor/events/messages.ts", // app mentions adapt into the shared Slack message pipeline
        "extensions/slack/src/monitor/slash.ts", // Slack action and options overloads omit runtime middleware fields
        "extensions/slack/src/progress-blocks.ts", // Slack runtime supports url_source ahead of its published types
        "extensions/slack/src/streaming.ts", // failed-stream recovery clears a private Slack SDK buffer
        "extensions/sms/src/channel.ts", // channel runtime crosses the public plugin adapter seam
        "extensions/synology-chat/src/channel.ts", // plugin factory implementation carries a narrower runtime surface
        "extensions/synology-chat/src/test-http-utils.ts", // test support
        "extensions/telegram/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/telegram/src/client-fetch.ts", // Telegram and DOM fetch signatures use distinct body namespaces
        "extensions/telegram/src/doctor-contract.ts", // legacy doctor migration normalizes retired untyped config shapes
        "extensions/telegram/src/fetch.ts", // Node DNS and Undici fetch overloads bridge DOM-compatible runtime calls
        "extensions/telegram/src/outbound-media.ts", // Telegram API operation selection crosses overloaded method signatures
        "extensions/telegram/src/telegram-ingress-supersede-auth.ts", // Telegraf message input narrows into the ingress message contract
        "extensions/voice-call/src/webhook.ts", // voice runtime layers a core config subset into the full config contract
        "extensions/whatsapp/src/approval-native.ts", // approval runtime dynamically implements the public channel adapter seam
        "extensions/whatsapp/src/inbound/group-metadata-cache.ts", // Baileys event overloads are stricter than its emitted payloads
        "extensions/whatsapp/src/inbound/message-delivery.ts", // Baileys listener registration erases per-event callback parameters
        "extensions/whatsapp/src/inbound/socket-session.ts", // Baileys emitter typings omit generic listener and detach capabilities
        "extensions/whatsapp/src/session.ts", // Baileys WebSocket and emitter cleanup use undeclared runtime capabilities
        "extensions/workboard/src/store-core.ts", // legacy keyed store multiplexes cards, boards, subscriptions, and attachments
        "extensions/zalouser/src/zca-client.ts", // optional zca-js runtime is loaded through a local lazy module facade
        "packages/ai",
        "src/acp/client.ts", // Node and Web ReadableStream types live in separate namespaces.
        "src/acp/server.ts", // Node and Web ReadableStream types live in separate namespaces.
        "src/agents/agent-hooks/compaction-safeguard.ts", // AgentMessage custom roles exceed the Copilot header message contract.
        "src/agents/agent-model-discovery.ts", // Persisted registry rows need a fully resolved model parser owner.
        "src/agents/embedded-agent-helpers/images.ts", // Assistant blocks cross the tool-image sanitizer's narrower block namespace.
        "src/agents/embedded-agent-runner/run/attempt-stream.ts", // Synthetic yield stream metadata is wider than the provider model contract.
        "src/agents/embedded-agent-runner/run/images.ts", // Provider-only video blocks cross the canonical AgentMessage namespace.
        "src/agents/mcp-http-fetch.ts", // Undici Response crosses the DOM FetchLike type namespace.
        "src/agents/model-auth-model.ts", // Null Authorization sentinel crosses the SDK's string-only header type.
        "src/agents/model-provider-auth.ts", // Route-fact cache keys cross a config-only hash API.
        "src/agents/modes/interactive/theme/theme.ts", // Global symbol registry and Proxy receiver bridge duplicate module copies.
        "src/agents/subagents/spawn/subagent-depth.ts", // Generic session projections cross the fixed accessor entry type.
        "src/agents/tool-search-transcript.ts", // Synthetic target turns omit provider-owned assistant metadata.
        "src/channels/plugins/config-schema.ts", // Public SDK Zod generics preserve caller schema identity.
        "src/commands/channel-test-registry.ts", // Test support.
        "src/commands/doctor/cron/legacy-repair.ts", // Partially validated legacy rows cross the canonical cron store type.
        "src/commands/doctor/cron/legacy-store-migration.ts", // Legacy loader carries partial rows in the canonical store envelope.
        "src/commands/doctor/cron/warnings.ts", // Doctor inspects partially parsed cron rows.
        "src/config/schema.hints.ts", // Zod pipe internals cross its public type namespace.
        "src/config/sessions/store-entry-shape.ts", // Legacy projection accepts partially validated session records.
        "src/gateway/cli-session-history.claude.ts", // External CLI messages cross the canonical transcript redactor.
        "src/gateway/mcp-app-standalone.ts", // Generated standalone browser code bridges the DOM namespace.
        "src/gateway/server-methods/chat-transcript-inject.ts", // Gateway media blocks exceed the canonical message content union.
        "src/gateway/test-http-response.ts", // Test support.
        "src/infra/backup-volatile-stat-cache.ts", // node-tar's cache expects full Stats for a synthetic sentinel.
        "src/infra/diagnostic-trace-propagation.ts", // Global symbol registry crosses module copies.
        "src/infra/net/runtime-fetch.ts", // Undici and DOM fetch types live in separate namespaces.
        "src/infra/state-migrations.meeting-transcripts-files.ts", // Legacy summary validation does not prove element types.
        "src/infra/unhandled-rejections.ts", // Global symbol registry crosses module copies.
        "src/meeting-bot/browser-controller.ts", // Generic health fallbacks cannot construct arbitrary platform subtypes.
        "src/meeting-bot/platform-adapter.ts", // Generic parsers add adapter-owned health and transcript fields.
        "src/meeting-bot/plugin-shell.ts", // Type-only plugin namespace factory has no runtime value.
        "src/plugin-sdk/channel-config-helpers.ts", // Public SDK accessor generics are intentionally decoupled.
        "src/plugin-sdk/provider-stream-shared.ts", // Untyped normalizer events need a transport stream API redesign.
        "src/plugin-sdk/qa-runtime.ts", // Public SDK lazy module exposes a narrower runtime surface.
        "src/plugins/hook-isolation.ts", // Optional WebAssembly globals bridge runtime type namespaces.
        "src/plugins/interactive.ts", // Dynamic plugin context keys cross the generic handler seam.
        "src/plugins/loader-runtime-load.ts", // Discovery-only runtime is widened by the registry proxy.
        "src/plugins/registry-runtime.ts", // Bundled owner wrapper crosses the public inbound generic.
        "src/plugins/runtime/index.ts", // Lazy assembly adds required runtime capabilities after construction.
        "src/process/exec-spawn.ts", // Rebuilt Execa options cross its result generic.
        "src/proxy-capture/store.sqlite.ts", // Implementation preserves overloaded shipped constructor contracts.
        "src/trajectory/export.ts", // Legacy migration mutates pre-canonical transcript entries.
        "ui/src",
      ],
    }),
  },
};
