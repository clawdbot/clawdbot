/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { availableSidebarSlots, sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";

function discussionSlots(discussionAvailable: boolean) {
  const discussion = {} as SessionDiscussionPanelConfig;
  const definitions = sidebarPanelDefinitions({
    discussion,
    discussionAvailable,
  } as Parameters<typeof sidebarPanelDefinitions>[0]);
  return availableSidebarSlots(definitions);
}

describe("chat pane embedded panels", () => {
  it("does not offer Discussion when no provider is available", () => {
    expect(discussionSlots(false)).not.toContain("discussion");
  });

  it("offers Discussion after the provider reports it available", () => {
    expect(discussionSlots(true)).toContain("discussion");
  });
});
