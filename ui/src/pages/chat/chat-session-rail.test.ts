/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  ChatSessionCompanionThreads,
  requestSessionCompanionAnswer,
  requestSessionCompanionState,
  resetSessionCompanion,
} from "./chat-session-companion.ts";
import {
  ChatSessionRailElement,
  ChatSessionRailState,
  type SessionRailInput,
} from "./components/chat-session-rail.ts";

function digest(health: SessionObserverDigest["health"] = "on-track"): SessionObserverDigest {
  return {
    sessionKey: "agent:main:run",
    runId: "run-1",
    revision: 1,
    updatedAt: 300_000,
    headline: "Reviewing the implementation",
    health,
  };
}

function input(overrides: Partial<SessionRailInput> = {}): SessionRailInput {
  return {
    running: true,
    activeRunId: "run-1",
    digest: digest(),
    hasCompanionActivity: false,
    ...overrides,
  };
}

const displayPreferenceKey = "openclaw.chat.observerHud.display";

describe("ChatSessionRailState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves between hidden, pill, and expanded modes", () => {
    const state = new ChatSessionRailState("pill");
    // Idle with nothing to show renders nothing over the thread; the pane
    // header toggle is the always-present way back in.
    expect(state.mode(input({ running: false, digest: null }))).toBe("hidden");
    expect(state.mode(input())).toBe("pill");
    state.expand();
    expect(state.mode(input())).toBe("expanded");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("card");
    state.collapse();
    expect(state.mode(input())).toBe("pill");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
    state.hide();
    expect(state.mode(input())).toBe("hidden");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("off");
  });

  it("opens the panel from a hidden rail without persisting card", () => {
    const state = new ChatSessionRailState("pill");
    state.hide();

    state.openExplicitly();

    expect(state.mode(input())).toBe("expanded");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
    // A fresh state reads the stored preference: the next session gets the
    // ambient pill, not a sticky panel.
    expect(new ChatSessionRailState().mode(input())).toBe("pill");
  });

  it("opens digest-less on an idle session and resets per session", () => {
    const state = new ChatSessionRailState("pill");
    const idle = { running: false, activeRunId: null, digest: null } as const;
    state.openExplicitly();
    expect(state.mode(input(idle))).toBe("expanded");
    state.resetTransientState();
    expect(state.mode(input(idle))).toBe("hidden");
  });

  it("closes an idle panel to nothing and a running panel to its digest pill", () => {
    const idleState = new ChatSessionRailState("pill");
    idleState.openExplicitly();
    idleState.collapse();
    expect(idleState.mode(input({ running: false, activeRunId: null, digest: null }))).toBe(
      "hidden",
    );

    const runningState = new ChatSessionRailState("pill");
    runningState.openExplicitly();
    runningState.collapse();
    expect(runningState.mode(input())).toBe("pill");
  });

  it("auto-opens pill transiently without changing the persisted preference", () => {
    localStorage.setItem(displayPreferenceKey, "pill");
    const state = new ChatSessionRailState();

    expect(state.tryAutoOpen()).toBe(true);
    expect(state.mode(input())).toBe("expanded");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
    expect(new ChatSessionRailState().mode(input())).toBe("pill");
  });

  it("rejects auto-open while hidden and preserves the off preference", () => {
    localStorage.setItem(displayPreferenceKey, "off");
    const state = new ChatSessionRailState();

    expect(state.tryAutoOpen()).toBe(false);
    expect(state.mode(input())).toBe("hidden");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("off");
    expect(new ChatSessionRailState().mode(input())).toBe("hidden");
  });

  it("persists explicit collapse and hide after transient auto-open", () => {
    const state = new ChatSessionRailState("pill");

    expect(state.tryAutoOpen()).toBe(true);
    expect(state.mode(input())).toBe("expanded");
    state.collapse();
    expect(state.mode(input())).toBe("pill");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");

    expect(state.tryAutoOpen()).toBe(true);
    state.hide();
    expect(state.mode(input())).toBe("hidden");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("off");
    expect(state.tryAutoOpen()).toBe(false);
  });

  it("clears transient auto-open when the session changes", () => {
    localStorage.setItem(displayPreferenceKey, "pill");
    const state = new ChatSessionRailState();

    expect(state.tryAutoOpen()).toBe(true);
    expect(state.mode(input())).toBe("expanded");
    state.resetTransientState();
    expect(state.mode(input())).toBe("pill");
    expect(state.tryAutoOpen()).toBe(true);
    expect(state.mode(input())).toBe("expanded");
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
  });

  it("keeps a companion thread renderable without an observer digest", () => {
    const state = new ChatSessionRailState("pill");
    expect(
      state.mode(
        input({ running: false, activeRunId: null, digest: null, hasCompanionActivity: true }),
      ),
    ).toBe("pill");
  });

  it("auto-expands a critical run only once", () => {
    const state = new ChatSessionRailState("pill");
    expect(state.mode(input({ digest: digest("stuck") }))).toBe("expanded");
    state.collapse();
    expect(state.mode(input({ digest: digest("waiting-on-user") }))).toBe("pill");
  });
});

describe("ChatSessionCompanionThreads", () => {
  it("uses the exact companion RPC methods and payloads", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.companion.ask") {
        return { answer: "Answer", ts: 1 };
      }
      if (method === "sessions.companion.state") {
        return { exchanges: [] };
      }
      return { ok: true as const };
    });
    const client = { request: request as GatewayBrowserClient["request"] };

    await requestSessionCompanionAnswer(client, "one", "Question", "work");
    await requestSessionCompanionState(client, "one", "work");
    await resetSessionCompanion(client, "one", "work");

    expect(request.mock.calls).toEqual([
      [
        "sessions.companion.ask",
        { sessionKey: "one", agentId: "work", question: "Question" },
        { timeoutMs: 70_000 },
      ],
      ["sessions.companion.state", { sessionKey: "one", agentId: "work" }],
      ["sessions.companion.reset", { sessionKey: "one", agentId: "work" }],
    ]);
  });

  it("hydrates and retains independent per-session threads", async () => {
    const threads = new ChatSessionCompanionThreads();
    const load = vi.fn(async (sessionKey: string) => ({
      exchanges: [
        {
          question: `Question for ${sessionKey}`,
          answer: `Answer for ${sessionKey}`,
          ts: sessionKey === "one" ? 1 : 2,
        },
      ],
    }));

    await threads.hydrate("one", load);
    await threads.hydrate("two", load);

    expect(threads.view("one").exchanges[0]?.answer).toBe("Answer for one");
    expect(threads.view("two").exchanges[0]?.answer).toBe("Answer for two");
  });

  it("records hydration until the authoritative companion state settles", async () => {
    let resolveLoad!: (value: { exchanges: [] }) => void;
    const threads = new ChatSessionCompanionThreads();
    const pending = threads.hydrate(
      "one",
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    expect(threads.view("one").loading).toBe(true);
    resolveLoad({ exchanges: [] });
    await pending;
    expect(threads.view("one").loading).toBe(false);
  });

  it("keeps matching bare session keys isolated by agent", () => {
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("global", "main draft", "main");
    threads.setDraft("global", "work draft", "work");

    expect(threads.view("global", "main").draft).toBe("main draft");
    expect(threads.view("global", "work").draft).toBe("work draft");
  });

  it("moves a composer submission through pending to a timestamped answer", async () => {
    let resolveAnswer!: (value: { answer: string; ts: number }) => void;
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("one", "Why is it rerunning that test?");
    const pending = threads.submit(
      "one",
      threads.view("one").draft,
      () =>
        new Promise((resolve) => {
          resolveAnswer = resolve;
        }),
    );

    expect(threads.view("one").pendingQuestion).toBe("Why is it rerunning that test?");
    expect(threads.view("one").draft).toBe("");
    resolveAnswer({ answer: "It is verifying the focused regression.", ts: 42 });
    await pending;

    expect(threads.view("one")).toMatchObject({
      pendingQuestion: null,
      exchanges: [
        {
          question: "Why is it rerunning that test?",
          answer: "It is verifying the focused regression.",
          ts: 42,
        },
      ],
    });
  });

  it("maps the typed busy error to the rail hint", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Is it stuck?", async () => {
      throw Object.assign(new Error("busy"), {
        details: { code: "SESSION_COMPANION_BUSY" },
        retryable: true,
      });
    });

    expect(threads.view("one")).toMatchObject({
      failedQuestion: "Is it stuck?",
      hint: "busy",
      retryable: true,
    });
  });

  it("preserves a context failure for an explicit retry", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "What changed?", async () => {
      throw Object.assign(new Error("history unavailable"), {
        details: { reason: "context-unavailable" },
        retryable: true,
      });
    });

    expect(threads.view("one")).toMatchObject({
      failedQuestion: "What changed?",
      hint: "history-unavailable",
      pendingQuestion: null,
      retryable: true,
    });
    await threads.hydrate("one", async () => ({ exchanges: [] }));
    expect(threads.view("one")).toMatchObject({
      failedQuestion: "What changed?",
      hint: "history-unavailable",
      retryable: true,
    });
  });

  it.each([
    { reason: "rate-limited", retryable: true, hint: "rate-limited" },
    { reason: "utility-model-unavailable", retryable: false, hint: "model-unavailable" },
    { reason: "unavailable", retryable: false, hint: "unavailable" },
  ] as const)("maps $reason to its specific retry state", async (expected) => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "What changed?", async () => {
      throw Object.assign(new Error(expected.reason), {
        details: { reason: expected.reason },
        retryable: expected.retryable,
      });
    });

    expect(threads.view("one")).toMatchObject({
      hint: expected.hint,
      retryable: expected.retryable,
    });
  });

  it("hydrates only a newly committed repeated question after a lost response", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "What changed?", answer: "Earlier answer.", ts: 1 }],
    }));
    await threads.submit("one", "What changed?", async () => {
      throw new Error("socket closed");
    });
    expect(threads.view("one")).toMatchObject({
      failedQuestion: "What changed?",
      hint: "unavailable",
      retryable: true,
    });

    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "What changed?", answer: "Earlier answer.", ts: 1 }],
    }));
    expect(threads.view("one")).toMatchObject({
      failedQuestion: "What changed?",
      hint: "unavailable",
      retryable: true,
    });

    await threads.hydrate("one", async () => ({
      exchanges: [
        { question: "What changed?", answer: "Earlier answer.", ts: 1 },
        { question: "What changed?", answer: "The fix committed.", ts: 4 },
      ],
    }));

    expect(threads.view("one")).toMatchObject({
      failedQuestion: null,
      hint: null,
      retryable: false,
      exchanges: [
        { question: "What changed?", answer: "Earlier answer.", ts: 1 },
        { question: "What changed?", answer: "The fix committed.", ts: 4 },
      ],
    });
  });

  it("clears local state only after the reset RPC succeeds", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "Q", answer: "A", ts: 1 }],
    }));
    await expect(
      threads.reset("one", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(threads.view("one").exchanges).toHaveLength(1);

    await threads.reset("one", async () => ({ ok: true as const }));
    expect(threads.view("one").exchanges).toEqual([]);
  });

  it("retires one session without clearing unrelated companion state", () => {
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("one", "retire me", "main");
    threads.setDraft("two", "keep me", "main");

    threads.retire("one", "main");

    expect(threads.view("one", "main").draft).toBe("");
    expect(threads.view("two", "main").draft).toBe("keep me");
  });

  it("adopts an empty restarted-Gateway thread without discarding its local draft", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "Before restart", answer: "Old answer", ts: 1 }],
    }));
    threads.setDraft("one", "unsent local draft");

    await threads.hydrate("one", async () => ({ exchanges: [] }));

    expect(threads.view("one")).toMatchObject({
      draft: "unsent local draft",
      exchanges: [],
    });
  });

  it.each(["resolve", "reject"] as const)(
    "does not resurrect a reset request after a late $outcome",
    async (outcome) => {
      let resolveAnswer!: (value: { answer: string; ts: number }) => void;
      let rejectAnswer!: (error: Error) => void;
      const threads = new ChatSessionCompanionThreads();
      const pending = threads.submit(
        "one",
        "Will reset keep this?",
        () =>
          new Promise((resolve, reject) => {
            resolveAnswer = resolve;
            rejectAnswer = reject;
          }),
      );

      await threads.reset("one", async () => ({ ok: true as const }));
      if (outcome === "resolve") {
        resolveAnswer({ answer: "late answer", ts: 5 });
      } else {
        rejectAnswer(new Error("late error"));
      }
      await pending;

      expect(threads.view("one")).toMatchObject({
        exchanges: [],
        failedQuestion: null,
        pendingQuestion: null,
      });
    },
  );
});

describe("ChatSessionRailElement", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(displayPreferenceKey, "card");
    vi.spyOn(Date, "now").mockReturnValue(600_000);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(overrides: Partial<ChatSessionRailElement> = {}) {
    const element = document.createElement("openclaw-chat-session-rail") as ChatSessionRailElement;
    element.sessionKey = "agent:main:run";
    element.digest = digest();
    element.running = true;
    element.activeRunId = "run-1";
    element.startedAt = 500_000;
    element.connected = true;
    Object.assign(element, overrides);
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

  it("spaces compound durations in the rendered rail timing", async () => {
    const element = await mount({ startedAt: 508_000 });

    expect(element.querySelector(".chat-session-rail__timing")?.textContent).toBe("1m 32s");
  });

  it("uses the shared surface empty state before the first side-chat exchange", async () => {
    const element = await mount();
    const empty = element.querySelector("openclaw-panel-empty-state");
    await empty?.updateComplete;

    expect(empty?.shadowRoot?.querySelector(".empty-state__title")?.textContent).toBe("Side chat");
    expect(empty?.querySelector("svg")).not.toBeNull();
  });

  it("submits the rail composer and renders sanitized markdown answers", async () => {
    const onSubmit = vi.fn();
    const element = await mount({
      onSubmit,
      companion: {
        exchanges: [
          {
            question: "What changed?",
            answer: "**Only** the UI. <script>bad()</script>",
            ts: 300_000,
          },
        ],
        loading: false,
        pendingQuestion: null,
        failedQuestion: null,
        hint: null,
        draft: "What should I verify?",
      },
    });

    element.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith("What should I verify?");
    expect(element.querySelector(".chat-session-rail__answer strong")?.textContent).toBe("Only");
    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector(".chat-session-rail__timestamp")?.textContent).toContain("as of");
  });

  it("renders one pending state and retries a retryable failure", async () => {
    const onSubmit = vi.fn();
    const element = await mount({
      onSubmit,
      companion: {
        exchanges: [],
        loading: false,
        pendingQuestion: "What changed?",
        failedQuestion: null,
        hint: null,
        draft: "",
      },
    });
    expect(element.textContent).toContain("Answering from this session…");

    element.companion = {
      exchanges: [],
      loading: false,
      pendingQuestion: null,
      failedQuestion: "What changed?",
      hint: "history-unavailable",
      retryable: true,
      draft: "",
    };
    await element.updateComplete;
    expect(element.textContent).toContain("Couldn't load this session's history.");
    (element.querySelector(".chat-session-rail__retry") as HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledWith("What changed?");
  });

  it("freezes terminal relative time from digest.updatedAt", async () => {
    const element = await mount({
      digest: digest("done"),
      running: false,
      activeRunId: null,
      companion: {
        exchanges: [{ question: "Q", answer: "A", ts: 1 }],
        loading: false,
        pendingQuestion: null,
        failedQuestion: null,
        hint: null,
        draft: "",
      },
    });
    expect(element.textContent).toContain("Finished 5m ago");

    vi.mocked(Date.now).mockReturnValue(3_600_000);
    element.requestUpdate();
    await element.updateComplete;
    expect(element.textContent).toContain("Finished 5m ago");
  });

  it("uses an uppercase chip only for stuck and waiting states", async () => {
    const element = await mount({ digest: digest("stuck") });
    expect(element.querySelector(".chat-session-rail__status--critical")).not.toBeNull();

    element.digest = digest("on-track");
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail__status--critical")).toBeNull();
  });

  it("shows the shared chat skeleton instead of the empty state during hydration", async () => {
    const element = await mount({
      companion: {
        exchanges: [],
        loading: true,
        pendingQuestion: null,
        failedQuestion: null,
        hint: null,
        draft: "",
      },
    });

    const skeleton = element.querySelector("openclaw-panel-loading-skeleton");
    await skeleton?.updateComplete;
    expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("chat");
    expect(element.querySelector("openclaw-panel-empty-state")).toBeNull();
  });

  it("collapses on Escape", async () => {
    const element = await mount();
    element
      .querySelector(".chat-session-rail--expanded")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--pill")).not.toBeNull();
  });

  it("keeps the ticking rail section out of screen-reader live regions", async () => {
    const element = await mount();
    const section = element.querySelector(".chat-session-rail--expanded");
    // The section wraps a 1Hz elapsed clock; aria-live here would announce
    // every tick. The message thread owns the polite region instead.
    expect(section?.hasAttribute("aria-live")).toBe(false);
    expect(element.querySelector(".chat-session-rail__thread")?.getAttribute("aria-live")).toBe(
      "polite",
    );
  });

  it("does not reopen or report visible after hide when an automatic open arrives", async () => {
    const onVisibilityChange = vi.fn();
    const onCommandConsumed = vi.fn();
    const element = await mount({ onCommandConsumed, onVisibilityChange });

    (element.querySelector(".chat-session-rail__hide") as HTMLButtonElement | null)?.click();
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail")).toBeNull();
    expect(localStorage.getItem(displayPreferenceKey)).toBe("off");

    onVisibilityChange.mockClear();
    element.command = { generation: 1, intent: "open" };
    await element.updateComplete;

    expect(element.querySelector(".chat-session-rail")).toBeNull();
    expect(localStorage.getItem(displayPreferenceKey)).toBe("off");
    expect(onCommandConsumed).toHaveBeenCalledWith(1);
    expect(onVisibilityChange).not.toHaveBeenCalled();
  });

  it("opens a hidden rail straight to the panel when the header toggle asks", async () => {
    const onVisibilityChange = vi.fn();
    const element = await mount({ onVisibilityChange });
    (element.querySelector(".chat-session-rail__hide") as HTMLButtonElement | null)?.click();
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail")).toBeNull();
    onVisibilityChange.mockClear();

    element.command = { generation: 1, intent: "toggle" };
    await element.updateComplete;

    // One command, panel open: no pill step, and no persisted card.
    expect(element.querySelector(".chat-session-rail--expanded")).not.toBeNull();
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
    expect(onVisibilityChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("closes the panel when the header toggle asks again", async () => {
    const onVisibilityChange = vi.fn();
    const element = await mount({ onVisibilityChange });
    expect(element.querySelector(".chat-session-rail--expanded")).not.toBeNull();
    onVisibilityChange.mockClear();

    element.command = { generation: 1, intent: "toggle" };
    await element.updateComplete;

    // A running session keeps its digest pill; observer visibility stays true
    // so the gateway keeps producing the digest the pill is showing.
    expect(element.querySelector(".chat-session-rail--pill")).not.toBeNull();
    expect(onVisibilityChange).not.toHaveBeenCalled();
  });

  it("offers starter questions instead of an empty thread, and asks the tapped one", async () => {
    const onSubmit = vi.fn();
    const element = await mount({ onSubmit });

    const starters = [...element.querySelectorAll(".chat-session-rail__starter")];
    expect(starters.map((starter) => starter.textContent?.trim())).toEqual([
      "What changed?",
      "Why did it stop?",
      "What's left?",
    ]);

    (starters[1] as HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Why did it stop?");
  });

  it("replaces the starters once the thread has an exchange", async () => {
    const element = await mount({
      companion: {
        exchanges: [{ question: "What changed?", answer: "The rail toggle.", ts: 300_000 }],
        loading: false,
        pendingQuestion: null,
        failedQuestion: null,
        hint: null,
        draft: "",
      },
    });

    expect(element.querySelector(".chat-session-rail__starter")).toBeNull();
    expect(element.querySelector(".chat-session-rail__exchange")).not.toBeNull();
  });

  it("drops the digest band when there is no digest to show", async () => {
    const withDigest = await mount({ digest: { ...digest(), assessment: "Steady progress." } });
    expect(withDigest.querySelector(".chat-session-rail__digest")).not.toBeNull();

    const withoutDigest = await mount({
      digest: null,
      running: false,
      activeRunId: null,
      companion: {
        exchanges: [],
        loading: false,
        pendingQuestion: null,
        failedQuestion: null,
        hint: null,
        draft: "What changed?",
      },
    });
    expect(withoutDigest.querySelector(".chat-session-rail--expanded")).not.toBeNull();
    expect(withoutDigest.querySelector(".chat-session-rail__digest")).toBeNull();
  });

  it("auto-opens from pill without persisting card, then collapses persistently", async () => {
    localStorage.setItem(displayPreferenceKey, "pill");
    const onCommandConsumed = vi.fn();
    const onVisibilityChange = vi.fn();
    const element = await mount({ onCommandConsumed, onVisibilityChange });
    expect(element.querySelector(".chat-session-rail--pill")).not.toBeNull();

    element.command = { generation: 1, intent: "open" };
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--expanded")).not.toBeNull();
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
    expect(onCommandConsumed).toHaveBeenCalledWith(1);
    expect(onVisibilityChange).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    element
      .querySelector(".chat-session-rail--expanded")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--pill")).not.toBeNull();
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
  });

  it("does not replay a retained command after a session round trip", async () => {
    localStorage.setItem(displayPreferenceKey, "pill");
    let consumedGeneration = 0;
    const onCommandConsumed = vi.fn((generation: number) => {
      consumedGeneration = generation;
    });
    const onVisibilityChange = vi.fn();
    const element = await mount({ onCommandConsumed, onVisibilityChange });

    element.command = { generation: 1, intent: "open" };
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--expanded")).not.toBeNull();
    expect(consumedGeneration).toBe(1);
    expect(onVisibilityChange).toHaveBeenCalledOnce();

    element.sessionKey = "agent:main:other";
    element.command = null;
    element.consumedCommandGeneration = consumedGeneration;
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--pill")).not.toBeNull();

    element.sessionKey = "agent:main:run";
    element.command = { generation: 1, intent: "open" };
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--pill")).not.toBeNull();
    expect(onVisibilityChange).toHaveBeenCalledOnce();

    element.command = { generation: 2, intent: "open" };
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--expanded")).not.toBeNull();
    expect(onCommandConsumed).toHaveBeenCalledTimes(2);
    expect(onVisibilityChange).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(displayPreferenceKey)).toBe("pill");
  });
});
