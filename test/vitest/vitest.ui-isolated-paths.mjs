// The shared UI runner reuses its module graph across fresh jsdom registries.
// Tests in this list depend on module singletons or custom-element registration
// matching the current registry, so they need a fresh graph in the isolated lane.
export const uiIsolatedTestFiles = [
  "ui/src/app/app-host.server-prefs.test.ts",
  "ui/src/app/bootstrap.gateway-credentials.test.ts",
  "ui/src/app/bootstrap.test.ts",
  "ui/src/app/router-outlet.test.ts",
  "ui/src/components/markdown-tables.test.ts",
  "ui/src/components/resizable-divider.test.ts",
  "ui/src/components/sidebar-update-card.test.ts",
  "ui/src/components/viewer-facepile.test.ts",
  "ui/src/pages/agents/memory/memory-panel.test.ts",
  "ui/src/pages/chat/chat-page-attachment-handoff.test.ts",
  "ui/src/pages/chat/chat-pane-attachment-handoff.test.ts",
  "ui/src/pages/chat/chat-pane-board.test.ts",
  "ui/src/pages/chat/chat-pane-catalog.test.ts",
  "ui/src/pages/chat/chat-pane-history.test.ts",
  "ui/src/pages/chat/chat-pane-identity.test.ts",
  "ui/src/pages/chat/chat-pane-keyboard-focus.test.ts",
  "ui/src/pages/chat/chat-pane-lifecycle.test.ts",
  "ui/src/pages/chat/chat-pane-pull-requests.test.ts",
  "ui/src/pages/chat/chat-pane-retained-presentation.test.ts",
  "ui/src/pages/chat/chat-pane.message-cut.test.ts",
  "ui/src/pages/chat/chat-pane.read-marker.test.ts",
  "ui/src/pages/chat/chat-pane.session-discussion.test.ts",
  "ui/src/pages/chat/chat-pane.test.ts",
  "ui/src/pages/chat/components/chat-picker-overlay.test.ts",
  "ui/src/pages/chat/components/chat-transcript-controller.test.ts",
  "ui/src/pages/chat/components/chat-transcript-invalidation.test.ts",
  "ui/src/pages/chat/components/chat-transcript-render.test.ts",
  "ui/src/pages/config/config-page.custom-theme.test.ts",
  "ui/src/pages/config/memory-mutation-owner.test.ts",
  "ui/src/pages/config/memory-page.test.ts",
  "ui/src/pages/new-session/draft-persistence.test.ts",
  "ui/src/pages/sessions/sessions-page.archived.test.ts",
  "ui/src/pages/workboard/view.test.ts",
];

const uiIsolatedTestFileSet = new Set(uiIsolatedTestFiles);

export function isUiIsolatedTestFile(value) {
  return uiIsolatedTestFileSet.has(value.replaceAll("\\", "/"));
}
