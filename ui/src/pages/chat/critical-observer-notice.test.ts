/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CriticalObserverNoticeTracker,
  showCriticalSessionObserverNotice,
} from "./critical-observer-notice.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("critical session observer notice", () => {
  it.each([
    {
      name: "configured selected-agent foreground alias",
      sessionKey: "agent:work:primary",
      visible: false,
    },
    {
      name: "canonical selected-agent global foreground",
      sessionKey: "global",
      visible: false,
    },
    {
      name: "genuine selected-agent background session",
      sessionKey: "agent:work:investigation",
      visible: true,
    },
    {
      name: "genuine other-agent configured-main session",
      sessionKey: "agent:other:primary",
      visible: true,
    },
  ])("configured-global observer notice: $name", async (testCase) => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    showCriticalSessionObserverNotice({
      payload: {
        sessionKey: testCase.sessionKey,
        headline: "Configured-global observer regression",
        health: "stuck",
        revision: 1,
      },
      selectedSessionKey: "global",
      sessionHost: {
        assistantAgentId: "work",
        agentsList: { defaultId: "work", mainKey: "primary", scope: "global" },
        hello: {
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "work",
              mainKey: "primary",
              mainSessionKey: "global",
            },
          },
        },
      },
      sessions: [
        { key: "global", label: "Global foreground", kind: "global", updatedAt: null },
        {
          key: "agent:work:investigation",
          label: "Selected-agent background",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:other:primary",
          label: "Other-agent configured main",
          kind: "direct",
          updatedAt: null,
        },
      ],
      tracker: new CriticalObserverNoticeTracker(),
      onOpen: vi.fn(),
    });

    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast") !== null).toBe(testCase.visible);
  });

  it("notices critical health only for a non-selected session", async () => {
    const onOpen = vi.fn();
    const tracker = new CriticalObserverNoticeTracker();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const show = (sessionKey: string, health: string, revision: number) =>
      showCriticalSessionObserverNotice({
        payload: { sessionKey, headline: "Repeated test failure", health, revision },
        selectedSessionKey: "agent:main:selected",
        sessionHost: {},
        sessions: [
          { key: "agent:main:other", label: "Other work", kind: "direct", updatedAt: null },
        ],
        tracker,
        onOpen,
      });

    show("agent:main:selected", "waiting-on-user", 1);
    show("agent:main:other", "on-track", 1);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    show("agent:main:other", "stuck", 2);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Repeated test failure",
    );

    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("agent:main:other");

    show("agent:main:other", "stuck", 3);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    // Broad-only recipients miss recovery digests. A revision gap distinguishes
    // the next critical transition from an exact subscriber's repeat update.
    show("agent:main:other", "stuck", 5);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).not.toBeNull();
  });
});
