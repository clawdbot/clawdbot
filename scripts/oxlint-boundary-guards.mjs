const EXPRESSION_WRAPPER_RE =
  /^(?:ChainExpression|ParenthesizedExpression|TSAsExpression|TSNonNullExpression|TSTypeAssertion)$/;
const TEST_FILE_SUFFIXES = [".test.ts", ".test-utils.ts", ".test-harness.ts", ".e2e-harness.ts"];

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
        !roots.some((root) => repoPath === root || repoPath.startsWith(`${root}/`)) ||
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
  },
};
