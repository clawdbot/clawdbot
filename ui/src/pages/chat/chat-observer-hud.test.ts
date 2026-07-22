/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { resolveChatPaneObserverRunId } from "../../lib/observer-digest.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ChatObserverAskState,
  ChatObserverHudElement,
  ChatObserverHudState,
  type ObserverHudInput,
} from "./components/chat-observer-hud.ts";

function digest(health: SessionObserverDigest["health"] = "on-track"): SessionObserverDigest {
  return {
    sessionKey: "agent:main:run",
    runId: "run-1",
    revision: 1,
    updatedAt: 2_000,
    headline: "Reviewing the implementation",
    health,
  };
}

function input(overrides: Partial<ObserverHudInput> = {}): ObserverHudInput {
  return {
    running: true,
    activeRunId: "run-1",
    digest: digest(),
    sideChatOpen: false,
    ...overrides,
  };
}

describe("ChatObserverHudState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves between hidden, pill, and user-expanded card states", () => {
    const state = new ChatObserverHudState("pill");
    expect(state.mode(input({ running: false, digest: null }))).toBe("hidden");
    expect(state.mode(input({ digest: null }))).toBe("hidden");
    expect(state.mode(input())).toBe("pill");
    state.expand();
    expect(state.mode(input())).toBe("card");
    state.collapse();
    expect(state.mode(input())).toBe("pill");
  });

  it("suppresses missing and stale digests while a run is active", () => {
    const state = new ChatObserverHudState("card");
    expect(state.mode(input({ digest: null }))).toBe("hidden");
    expect(state.mode(input({ digest: { ...digest(), runId: undefined } }))).toBe("hidden");
    expect(state.mode(input({ digest: { ...digest(), runId: "previous-run" } }))).toBe("hidden");
    expect(state.mode(input())).toBe("card");
  });

  it("auto-expands a critical run at most once", () => {
    const state = new ChatObserverHudState("pill");
    expect(state.mode(input({ digest: digest("stuck") }))).toBe("card");
    state.collapse();
    expect(state.mode(input({ digest: digest("waiting-on-user") }))).toBe("pill");
  });

  it("yields expanded space to side chat without changing the preference", () => {
    const state = new ChatObserverHudState("card");
    expect(state.mode(input({ sideChatOpen: true }))).toBe("pill");
    expect(state.mode(input({ sideChatOpen: false }))).toBe("card");
  });

  it("keeps a final digest until read, then hides it", () => {
    const state = new ChatObserverHudState("pill");
    const finalDigest = digest("done");
    expect(
      state.mode(
        input({ running: false, activeRunId: null, digest: finalDigest, lastReadAt: 1_999 }),
      ),
    ).toBe("pill");
    expect(
      state.mode(
        input({ running: false, activeRunId: null, digest: finalDigest, lastReadAt: 2_000 }),
      ),
    ).toBe("hidden");
  });

  it("treats off as strict even for critical digests", () => {
    const state = new ChatObserverHudState("off");
    expect(state.mode(input({ digest: digest("stuck") }))).toBe("restore");
    state.show();
    expect(state.mode(input({ digest: digest("stuck") }))).toBe("card");
  });

  it("keeps the restore control during a digest-free running chat", () => {
    const state = new ChatObserverHudState("off");
    expect(state.mode(input({ digest: null }))).toBe("restore");
    expect(state.mode(input({ running: false, digest: null }))).toBe("hidden");
  });

  it("persists the three display preferences under the display key", () => {
    const state = new ChatObserverHudState("pill");
    state.expand();
    expect(localStorage.getItem("openclaw.chat.observerHud.display")).toBe("card");
    state.collapse();
    expect(localStorage.getItem("openclaw.chat.observerHud.display")).toBe("pill");
    state.hide();
    expect(localStorage.getItem("openclaw.chat.observerHud.display")).toBe("off");
    expect(localStorage.getItem("openclaw.chat.observerHud.expanded")).toBeNull();
  });
});

describe("observer hud run identity from row data", () => {
  it("shows a projected digest when attaching to an already-running session", () => {
    const projectedDigest = {
      sessionKey: "agent:main:current",
      runId: "server-run",
      revision: 1,
      updatedAt: 2_000,
      headline: "Already running",
      health: "on-track" as const,
    };
    const activeRunId = resolveChatPaneObserverRunId({
      localRunId: null,
      session: { hasActiveRun: true, activeRunIds: ["server-run"] },
      digest: projectedDigest,
    });

    expect(activeRunId).toBe("server-run");
    expect(
      new ChatObserverHudState("pill").mode({
        running: activeRunId !== null,
        activeRunId,
        digest: projectedDigest,
        sideChatOpen: false,
      }),
    ).toBe("pill");
  });
});

describe("observer hud auto-expand latch", () => {
  it("clears the critical-expansion latch when the hud hides", () => {
    const state = new ChatObserverHudState("pill");
    const stuck = {
      sessionKey: "agent:main:s1",
      runId: "r1",
      revision: 1,
      updatedAt: 10,
      headline: "Stuck on tests",
      health: "stuck",
    } as SessionObserverDigest;
    expect(
      state.mode({ running: true, activeRunId: "r1", digest: stuck, sideChatOpen: false }),
    ).toBe("card");
    expect(
      state.mode({ running: true, activeRunId: "r1", digest: null, sideChatOpen: false }),
    ).toBe("hidden");
    const benign = { ...stuck, revision: 2, health: "on-track" } as SessionObserverDigest;
    expect(
      state.mode({ running: true, activeRunId: "r1", digest: benign, sideChatOpen: false }),
    ).toBe("pill");
  });
});

describe("ChatObserverHudElement", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function mount(preference: "card" | "pill" | "off" = "pill") {
    localStorage.setItem("openclaw.chat.observerHud.display", preference);
    const element = new ChatObserverHudElement();
    element.sessionKey = "agent:main:run";
    element.digest = digest();
    element.running = true;
    element.activeRunId = "run-1";
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

  it("renders only the restore ghost button while off", async () => {
    const element = await mount("off");

    expect(element.querySelectorAll("button")).toHaveLength(1);
    expect(element.querySelector(".chat-observer-hud--restore")).not.toBeNull();
    expect(element.querySelector(".chat-observer-hud__status")).toBeNull();
  });

  it("hides to off and reports the visibility change", async () => {
    const element = await mount();
    const onVisibilityChange = vi.fn();
    element.onVisibilityChange = onVisibilityChange;
    await element.updateComplete;

    element.querySelector<HTMLButtonElement>('[aria-label="Hide session observer"]')?.click();
    await element.updateComplete;

    expect(localStorage.getItem("openclaw.chat.observerHud.display")).toBe("off");
    expect(onVisibilityChange).toHaveBeenCalledWith(false);
    expect(element.querySelector(".chat-observer-hud--restore")).not.toBeNull();
  });

  it("restores to a pill and reports the visibility change", async () => {
    const element = await mount("off");
    const onVisibilityChange = vi.fn();
    element.onVisibilityChange = onVisibilityChange;
    await element.updateComplete;

    element.querySelector<HTMLButtonElement>('[aria-label="Show session observer"]')?.click();
    await element.updateComplete;

    expect(localStorage.getItem("openclaw.chat.observerHud.display")).toBe("pill");
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
    expect(element.querySelector(".chat-observer-hud--pill")).not.toBeNull();
  });

  it("renders the health label in the status badge", async () => {
    const element = await mount();
    expect(element.querySelector(".chat-observer-hud__status")?.textContent?.trim()).toBe(
      "On track",
    );
  });

  it.each(["pill", "card"] as const)(
    "renders hide and toggle controls in %s mode",
    async (mode) => {
      const element = await mount(mode);

      expect(element.querySelector('[aria-label="Hide session observer"]')).not.toBeNull();
      expect(
        element.querySelector(
          `[aria-label="${mode === "pill" ? "Expand" : "Collapse"} session observer"]`,
        ),
      ).not.toBeNull();
    },
  );
});

describe("ChatObserverAskState", () => {
  it("moves a submitted question through pending to an answer", async () => {
    let resolveAnswer!: (value: { answer: string }) => void;
    const ask = vi.fn(
      () =>
        new Promise<{ answer: string }>((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    const state = new ChatObserverAskState();
    state.switchSession("agent:main:one");

    const pending = state.submit(" Why is it rerunning that test? ", ask);
    expect(state.pending).toBe(true);
    expect(state.exchanges).toEqual([{ question: "Why is it rerunning that test?" }]);
    expect(ask).toHaveBeenCalledWith("agent:main:one", "Why is it rerunning that test?");

    resolveAnswer({ answer: "It is verifying the same fix against the focused regression." });
    await pending;
    expect(state.pending).toBe(false);
    expect(state.exchanges).toEqual([
      {
        question: "Why is it rerunning that test?",
        answer: "It is verifying the same fix against the focused regression.",
      },
    ]);
  });

  it("maps the typed busy error to a muted hint", async () => {
    const state = new ChatObserverAskState();
    state.switchSession("agent:main:one");

    await state.submit("Is it stuck?", async () => {
      throw Object.assign(new Error("session observer busy"), {
        gatewayCode: "UNAVAILABLE",
        details: { code: "SESSION_OBSERVER_BUSY" },
      });
    });

    expect(state.exchanges).toEqual([{ question: "Is it stuck?", hint: "busy" }]);
  });

  it("clears the thread on session switch and ignores the old answer", async () => {
    let resolveAnswer!: (value: { answer: string }) => void;
    const state = new ChatObserverAskState();
    state.switchSession("agent:main:one");
    const pending = state.submit(
      "What is it doing?",
      () =>
        new Promise<{ answer: string }>((resolve) => {
          resolveAnswer = resolve;
        }),
    );

    state.switchSession("agent:main:two");
    expect(state.pending).toBe(false);
    expect(state.exchanges).toEqual([]);
    resolveAnswer({ answer: "An answer for the previous session." });
    await pending;
    expect(state.exchanges).toEqual([]);
  });
});
