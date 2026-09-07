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

export const pluginControlUiPathGlob = "extensions/*/browser/**";
export const controlUiTestGlobs = ["ui/src/**/*.test.ts", "extensions/*/browser/**/*.test.ts"];
export const controlUiE2eTestGlobs = [
  "ui/src/**/*.e2e.test.ts",
  "extensions/*/browser/**/*.e2e.test.ts",
];

/** Browser plugin source and tests share the Control UI owner, regardless of plugin id.
 * @param {string} file
 */
export function isPluginControlUiPath(file) {
  return /^extensions\/[^/]+\/browser(?:\/|$)/u.test(file);
}

/** @param {string} file */
export function isControlUiSourcePath(file) {
  return file.startsWith("ui/src/") || isPluginControlUiPath(file);
}

/** @param {string} relative */
export function isUiTestTarget(relative) {
  return (
    isControlUiSourcePath(relative) &&
    relative.endsWith(".test.ts") &&
    !relative.endsWith(".e2e.test.ts")
  );
}
