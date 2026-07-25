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
  it("notices critical health only for a non-selected session", async () => {
    const onOpen = vi.fn();
    const tracker = new CriticalObserverNoticeTracker();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const show = (sessionKey: string, health: string, revision: number) =>
      showCriticalSessionObserverNotice({
        payload: { sessionKey, headline: "Repeated test failure", health, revision },
        selectedSessionKey: "agent:main:selected",
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
