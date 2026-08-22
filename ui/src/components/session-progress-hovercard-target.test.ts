/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionProgressHoverTargetFromEvent } from "./session-progress-hovercard-target.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sessionProgressHoverTargetFromEvent", () => {
  it.each([
    ["a chat link", "a", "markdown-session-link"],
    ["a sidebar row", "div", "sidebar-recent-session"],
  ])("matches %s", (_label, tagName, className) => {
    const host = document.body.appendChild(document.createElement("div"));
    const target = host.appendChild(document.createElement(tagName));
    target.className = className;
    target.dataset.sessionKey = "agent:main:other-session";
    const child = target.appendChild(document.createElement("span"));
    let matched: HTMLElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverTargetFromEvent(event);
    });

    child.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));

    expect(matched).toBe(target);
  });

  it("ignores unrelated data carriers", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const candidate = host.appendChild(document.createElement("button"));
    candidate.className = "custom-session-control";
    candidate.dataset.sessionKey = "agent:main:other-session";
    let matched: HTMLElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverTargetFromEvent(event);
    });

    candidate.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));

    expect(matched).toBeNull();
  });

  it("ignores touch pointer events", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const row = host.appendChild(document.createElement("div"));
    row.className = "sidebar-recent-session";
    row.dataset.sessionKey = "agent:main:other-session";
    let matched: HTMLElement | null = null;
    host.addEventListener("pointerover", (event) => {
      matched = sessionProgressHoverTargetFromEvent(event);
    });

    row.dispatchEvent(
      new PointerEvent("pointerover", {
        bubbles: true,
        composed: true,
        pointerType: "touch",
      }),
    );

    expect(matched).toBeNull();
  });
});
