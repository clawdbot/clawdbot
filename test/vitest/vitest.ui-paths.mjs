export const unitUiIncludePatterns = [
  "ui/src/ui/app-chat.test.ts",
  "ui/src/ui/chat/**/*.test.ts",
  "ui/src/ui/views/agents-utils.test.ts",
  "ui/src/ui/views/channels.test.ts",
  "ui/src/ui/views/chat.test.ts",
  "ui/src/ui/views/dreaming.test.ts",
  "ui/src/ui/views/usage-render-details.test.ts",
  "ui/src/ui/controllers/agents.test.ts",
  "ui/src/ui/controllers/chat.test.ts",
];

export function isUnitUiTestTarget(relative) {
  if (!relative.endsWith(".test.ts")) {
    return false;
  }
  return (
    relative === "ui/src/ui/app-chat.test.ts" ||
    relative.startsWith("ui/src/ui/chat/") ||
    relative === "ui/src/ui/views/agents-utils.test.ts" ||
    relative === "ui/src/ui/views/channels.test.ts" ||
    relative === "ui/src/ui/views/chat.test.ts" ||
    relative === "ui/src/ui/views/dreaming.test.ts" ||
    relative === "ui/src/ui/views/usage-render-details.test.ts" ||
    relative === "ui/src/ui/controllers/agents.test.ts" ||
    relative === "ui/src/ui/controllers/chat.test.ts"
  );
}

export function isUiTestTarget(relative) {
  return (
    relative.startsWith("ui/src/") &&
    relative.endsWith(".test.ts") &&
    !relative.endsWith(".e2e.test.ts")
  );
}
