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
      agentId: undefined,
      visible: false,
    },
    {
      name: "canonical selected-agent global foreground",
      sessionKey: "global",
      agentId: "work",
      visible: false,
    },
    {
      name: "canonical other-agent global background",
      sessionKey: "global",
      agentId: "other",
      visible: true,
    },
    {
      name: "genuine selected-agent background session",
      sessionKey: "agent:work:investigation",
      agentId: undefined,
      visible: true,
    },
    {
      name: "genuine other-agent configured-main session",
      sessionKey: "agent:other:primary",
      agentId: undefined,
      visible: true,
    },
  ])("configured-global observer notice: $name", async (testCase) => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    showCriticalSessionObserverNotice({
      payload: {
        sessionKey: testCase.sessionKey,
        agentId: testCase.agentId,
        sessionId: "configured-session",
        lifecycleRevision: "configured-lifecycle",
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
        payload: { sessionKey, headline: "⚠️ Repeated test failure", health, revision },
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
      "Other work — ⚠️ Repeated test failure",
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

  describe.each([
    {
      name: "session replacement",
      before: { sessionId: "before-reset", lifecycleRevision: undefined },
      after: { sessionId: "after-reset", lifecycleRevision: undefined },
    },
    {
      name: "first clear",
      before: { sessionId: "cleared-session", lifecycleRevision: undefined },
      after: { sessionId: "cleared-session", lifecycleRevision: "after-clear" },
    },
    {
      name: "later clear",
      before: { sessionId: "cleared-session", lifecycleRevision: "before-clear" },
      after: { sessionId: "cleared-session", lifecycleRevision: "after-clear" },
    },
  ])("$name", ({ before, after }) => {
    it.each([1, 11])("announces unchanged critical health at revision %i", async (revision) => {
      const tracker = new CriticalObserverNoticeTracker();
      const toastHost = document.createElement("openclaw-toast-host");
      document.body.append(toastHost);
      const show = (identity: typeof before, nextRevision: number, runId: string) =>
        showCriticalSessionObserverNotice({
          payload: {
            ...identity,
            sessionKey: "agent:main:background",
            runId,
            headline: "Background task needs help",
            health: "stuck",
            revision: nextRevision,
          },
          selectedSessionKey: "agent:main:selected",
          sessionHost: {},
          sessions: [],
          tracker,
          onOpen: vi.fn(),
        });

      show(before, 10, "run-before-reset");
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast")).not.toBeNull();
      toastHost.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast")).toBeNull();

      show(after, revision, "run-after-reset");
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
        "Background task needs help",
      );
      toastHost.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
      await toastHost.updateComplete;

      show({ ...after }, revision, "run-after-reset");
      show(after, revision + 1, "next-run-in-same-lifecycle");
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast")).toBeNull();
    });
  });

  it.each(["sessionId", "lifecycleRevision"])(
    "rejects malformed %s before tracking",
    async (field) => {
      const tracker = new CriticalObserverNoticeTracker();
      const toastHost = document.createElement("openclaw-toast-host");
      document.body.append(toastHost);
      const show = (value: unknown) =>
        showCriticalSessionObserverNotice({
          payload: {
            sessionKey: "agent:main:background",
            [field]: value,
            headline: "Background task needs help",
            health: "stuck",
            revision: 1,
          },
          selectedSessionKey: "agent:main:selected",
          sessionHost: {},
          sessions: [],
          tracker,
          onOpen: vi.fn(),
        });

      for (const value of [null, 1, "", "   "]) {
        show(value);
        await toastHost.updateComplete;
        expect(toastHost.querySelector(".app-toast")).toBeNull();
      }
      show("valid-identity");
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast")).not.toBeNull();
    },
  );

  it("keeps reset history separate between agents sharing the global session key", () => {
    const tracker = new CriticalObserverNoticeTracker();
    const digest = { sessionKey: "global", sessionId: "same-id", health: "stuck", revision: 10 };
    expect(tracker.record({ ...digest, agentId: "work" })).toBe(true);
    expect(tracker.record({ ...digest, agentId: "other" })).toBe(true);
    expect(
      tracker.record({ ...digest, agentId: "work", lifecycleRevision: "after-clear", revision: 1 }),
    ).toBe(true);
    expect(tracker.record({ ...digest, agentId: "other", revision: 11 })).toBe(false);
    expect(
      tracker.record({ ...digest, agentId: "WORK", lifecycleRevision: "after-clear", revision: 2 }),
    ).toBe(false);
  });

  it("bounds history by session even when an existing session resets", () => {
    const tracker = new CriticalObserverNoticeTracker();
    const record = (index: number, lifecycleRevision?: string) =>
      tracker.record({
        sessionKey: `agent:main:session-${index}`,
        sessionId: `session-${index}`,
        lifecycleRevision,
        health: "stuck",
        revision: 1,
      });
    for (let index = 0; index < 256; index += 1) {
      expect(record(index)).toBe(true);
    }

    expect(record(255, "after-clear")).toBe(true);
    expect(record(0)).toBe(false);
    expect(record(256)).toBe(true);
    expect(record(0)).toBe(true);
    expect(record(255, "after-clear")).toBe(false);
  });
});
