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

describe("ChatSessionRailState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves between restore-icon, pill, and expanded modes", () => {
    const state = new ChatSessionRailState("pill");
    // Idle with nothing to show keeps the restore icon: the companion must
    // stay one click away at any point, never fully hidden.
    expect(state.mode(input({ running: false, digest: null }))).toBe("restore-icon");
    expect(state.mode(input())).toBe("pill");
    state.expand();
    expect(state.mode(input())).toBe("expanded");
    state.collapse();
    expect(state.mode(input())).toBe("pill");
    state.hide();
    expect(state.mode(input())).toBe("restore-icon");
  });

  it("opens digest-less from the restore icon and resets per session", () => {
    const state = new ChatSessionRailState("pill");
    const idle = { running: false, activeRunId: null, digest: null } as const;
    state.show();
    expect(state.mode(input(idle))).toBe("pill");
    state.resetManualOpen();
    expect(state.mode(input(idle))).toBe("restore-icon");
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

    await requestSessionCompanionAnswer(client, "one", "Question");
    await requestSessionCompanionState(client, "one");
    await resetSessionCompanion(client, "one");

    expect(request.mock.calls).toEqual([
      ["sessions.companion.ask", { sessionKey: "one", question: "Question" }],
      ["sessions.companion.state", { sessionKey: "one" }],
      ["sessions.companion.reset", { sessionKey: "one" }],
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
      });
    });

    expect(threads.view("one")).toMatchObject({
      failedQuestion: "Is it stuck?",
      hint: "busy",
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
});

describe("ChatSessionRailElement", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw.chat.observerHud.display", "card");
    vi.spyOn(Date, "now").mockReturnValue(600_000);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(overrides: Partial<ChatSessionRailElement> = {}) {
    const element = new ChatSessionRailElement();
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

  it("freezes terminal relative time from digest.updatedAt", async () => {
    const element = await mount({
      digest: digest("done"),
      running: false,
      activeRunId: null,
      companion: {
        exchanges: [{ question: "Q", answer: "A", ts: 1 }],
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

  it("collapses on Escape", async () => {
    const element = await mount();
    element
      .querySelector(".chat-session-rail--expanded")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".chat-session-rail--pill")).not.toBeNull();
  });
});
