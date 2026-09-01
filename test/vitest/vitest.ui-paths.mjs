// These files launch Playwright from Node; all other .browser tests run in Chromium.
export const uiNodeDrivenBrowserTestFiles = [
  "ui/src/pages/chat/chat-responsive.browser.test.ts",
  "ui/src/pages/chat/chat-working-indicator.browser.test.ts",
  "ui/src/pages/chat/chat-composer-undo-redo.browser.test.ts",
  "ui/src/pages/chat/components/chat-swarm-progress.browser.test.ts",
  "ui/src/components/form-controls.browser.test.ts",
  "ui/src/components/sidebar-footer-layout.browser.test.ts",
  "ui/src/pages/sessions/view.browser.test.ts",
  "ui/src/styles/corner-shape.browser.test.ts",
  "ui/src/styles/cursor-policy.browser.test.ts",
  "ui/src/styles/chat-file-link-presentation.browser.test.ts",
  "ui/src/styles/chat-github-link-presentation.browser.test.ts",
  "ui/src/styles/shimmer.browser.test.ts",
  "ui/src/styles/sr-only.browser.test.ts",
];

export function isUiBrowserTestFile(relative) {
  return (
    isUiTestTarget(relative) &&
    !/[*?[\]{}]|[@+!]\(/u.test(relative) &&
    relative.endsWith(".browser.test.ts") &&
    !uiNodeDrivenBrowserTestFiles.includes(relative)
  );
}

export function isUiTestTarget(relative) {
  return (
    relative.startsWith("ui/src/") &&
    relative.endsWith(".test.ts") &&
    !relative.endsWith(".e2e.test.ts")
  );
}
