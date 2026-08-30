/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  document.body.replaceChildren();
});

describe("chat pane embedded panels", () => {
  it("does not offer Discussion when no provider is available", () => {
    expect(discussionSlots(false)).not.toContain("discussion");
  });

  it("offers Discussion after the provider reports it available", () => {
    expect(discussionSlots(true)).toContain("discussion");
  });

  it("enumerates a structural loading variant for every side-panel tab", async () => {
    const expected = {
      browser: "browser",
      chat: "chat",
      companion: "chat",
      desktop: "desktop",
      detail: "review",
      discussion: "discussion",
      tasks: "tasks",
      terminal: "terminal",
      workspace: "files",
    } as const;

    const definitions = sidebarPanelDefinitions();
    expect(definitions.map((definition) => definition.slot)).toEqual([
      "detail",
      "terminal",
      "browser",
      "workspace",
      "companion",
      "tasks",
      "desktop",
      "discussion",
      "chat",
    ]);
    for (const definition of definitions) {
      const mount = document.body.appendChild(document.createElement("div"));
      render(definition.loading, mount);
      const skeleton = mount.querySelector("openclaw-panel-loading-skeleton");
      await skeleton?.updateComplete;
      expect(skeleton?.getAttribute("data-panel-skeleton")).toBe(expected[definition.slot]);
    }
  });
});
