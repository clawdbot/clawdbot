import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
  navigateMarkdownSession,
  type SessionLinkTarget,
} from "./markdown-session-links.ts";

describe("markdown session links", () => {
  it("navigates through the canonical chat session route", () => {
    const navigate = vi.fn();
    const context = {
      basePath: "",
      sessions: { state: {} },
      agents: { state: {} },
      agentSelection: { state: {} },
      gateway: { snapshot: {} },
      navigate,
    } as unknown as ApplicationContext;
    const target: SessionLinkTarget = {
      sessionKey: "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6",
      agentId: "roboclaw",
    };

    navigateMarkdownSession(context, target);

    expect(navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/roboclaw/dashboard/2139bddb-3211-4641-b993-10f619f124e6",
      search: "?__openclawSessionFacePreference=1",
    });
  });
  it.each([
    ["click", "a"],
    ["Enter", "a"],
    [" ", "a"],
    ["click", "code"],
    ["Enter", "code"],
    [" ", "code"],
  ])("routes a public-origin URL with %s on %s before hovercard initialization", (action, tag) => {
    const provider = Object.assign(
      document.createElement("openclaw-session-progress-hovercard-provider"),
      {
        context: {
          basePath: "/control",
          runtimeConfig: {
            state: {
              configSnapshot: {
                runtimeConfig: { gateway: { publicOrigin: "https://CHAT.example:443/" } },
              },
            },
          },
        },
      },
    );
    const anchor = document.createElement(tag);
    const href = "https://chat.example/control/chat/roboclaw/d0effac9?view=full#latest";
    if (tag === "a") {
      anchor.setAttribute("href", href);
    } else {
      anchor.dataset.sessionHref = href;
    }
    provider.append(anchor);
    let resolved: SessionLinkTarget | null = null;
    anchor.addEventListener(action === "click" ? "click" : "keydown", (event) => {
      resolved =
        event instanceof KeyboardEvent
          ? markdownSessionLinkFromKeyboardEvent(event)
          : markdownSessionLinkFromEvent(event);
      if (event instanceof MouseEvent) {
        event.preventDefault();
      }
    });
    const event =
      action === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    expect(resolved).toEqual({
      namespace: "chat",
      pathname: "/control/chat/roboclaw/d0effac9",
      search: "?view=full",
      hash: "#latest",
    });
    expect(anchor.dataset.sessionKey).toBeUndefined();
    expect(anchor.getAttribute("href") ?? anchor.dataset.sessionHref).toBe(href);
    if (action !== "click") {
      expect(event.defaultPrevented).toBe(true);
    }
  });
});
