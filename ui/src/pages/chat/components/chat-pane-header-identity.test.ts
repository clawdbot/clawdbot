/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatPaneHeaderSessionRow as row,
  mountChatPaneHeader,
  type ChatPaneHeaderProps,
} from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

describe("chat pane header identity links", () => {
  it("links the owner chip and each participant face to their activity feed", async () => {
    const navigate = vi.fn();
    const { container } = mountHeader({
      showOwnerChip: true,
      personActivity: { basePath: "", navigate },
      session: row({
        owner: { actor: { type: "human", id: "ada", label: "Ada King" } },
        participants: [
          { type: "human", id: "mira", label: "Mira" },
          { type: "human", id: "riley", label: "Riley" },
        ],
        participantCount: 2,
      }),
    });

    const facepile = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-viewer-facepile.chat-pane__participants",
    );
    await facepile?.updateComplete;
    const ownerLink = container.querySelector<HTMLAnchorElement>(
      "a.person-activity-avatar-link:has(openclaw-session-owner-chip)",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity?person=ada");
    const participantLinks = [
      ...container.querySelectorAll<HTMLAnchorElement>(
        ".chat-pane__participants a.person-activity-avatar-link",
      ),
    ];
    expect(participantLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/activity?person=mira",
      "/activity?person=riley",
    ]);

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("ada");
  });

  it("leaves identities unlinked when the header has no activity routing", () => {
    const { container } = mountHeader({
      showOwnerChip: true,
      session: row({
        owner: { actor: { type: "human", id: "ada", label: "Ada King" } },
        participants: [{ type: "human", id: "mira", label: "Mira" }],
        participantCount: 1,
      }),
    });

    expect(container.querySelector("a.person-activity-avatar-link")).toBeNull();
    expect(container.querySelector("openclaw-session-owner-chip")).not.toBeNull();
  });
});
