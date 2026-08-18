/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionProgressHoverAnchorFromEvent } from "./session-progress-hovercard-target.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sessionProgressHoverAnchorFromEvent", () => {
  it("matches only markdown session-reference anchors", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const anchor = host.appendChild(document.createElement("a"));
    anchor.className = "markdown-session-link";
    anchor.dataset.sessionKey = "agent:main:other-session";
    const code = anchor.appendChild(document.createElement("code"));
    let matched: HTMLAnchorElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverAnchorFromEvent(event);
    });

    code.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(matched).toBe(anchor);
  });

  it.each([
    ["a sidebar row", "div", "sidebar-recent-session"],
    ["another data carrier", "button", "custom-session-control"],
    ["an unmarked anchor", "a", "sidebar-recent-session__link"],
  ])("ignores %s", (_label, tagName, className) => {
    const host = document.body.appendChild(document.createElement("div"));
    const candidate = host.appendChild(document.createElement(tagName));
    candidate.className = className;
    candidate.dataset.sessionKey = "agent:main:other-session";
    let matched: HTMLAnchorElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverAnchorFromEvent(event);
    });

    candidate.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(matched).toBeNull();
  });
});
