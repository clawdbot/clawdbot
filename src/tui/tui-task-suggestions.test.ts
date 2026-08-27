import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import { createTuiTaskSuggestionController } from "./tui-task-suggestions.js";

type TestSelector = Component & {
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex: ReturnType<typeof vi.fn<(index: number) => void>>;
};

function suggestionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "task_1",
    title: "Remove stale adapter",
    prompt: "Delete the stale adapter and update its tests.",
    tldr: "The adapter is unreachable and adds maintenance cost.",
    cwd: "/repo/project",
    sessionKey: "agent:main:main",
    agentId: "main",
    createdAt: 1_000,
    ...overrides,
  };
}

function createHarness() {
  const selectors: TestSelector[] = [];
  const addSystem = vi.fn();
  const closeOverlay = vi.fn();
  const overlayHandles: OverlayHandle[] = [];
  const openOverlay = vi.fn((_component: Component) => {
    const handle = {
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: vi.fn(() => true),
    } satisfies OverlayHandle;
    overlayHandles.push(handle);
    return handle;
  });
  const requestRender = vi.fn();
  const listTaskSuggestions = vi.fn().mockResolvedValue([]);
  const listCloudWorkerProfiles = vi.fn().mockResolvedValue([]);
  const acceptTaskSuggestion = vi
    .fn()
    .mockResolvedValue({ taskId: "task_1", key: "agent:main:task" });
  const dismissTaskSuggestion = vi.fn().mockResolvedValue({ taskId: "task_1", dismissed: true });
  const onAccepted = vi.fn().mockResolvedValue(undefined);
  let agentId = "main";
  let sessionKey = "agent:main:main";
  let actionCapabilities = { canAccept: true, canAcceptModes: true, canDismiss: true };
  const controller = createTuiTaskSuggestionController({
    client: {
      getTaskSuggestionActionCapabilities: () => actionCapabilities,
      listTaskSuggestions,
      listCloudWorkerProfiles,
      acceptTaskSuggestion,
      dismissTaskSuggestion,
    },
    chatLog: { addSystem },
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    openOverlay,
    closeOverlay,
    requestRender,
    onAccepted,
    createSelector: (items) => {
      const selector = {
        items,
        setSelectedIndex: vi.fn<(index: number) => void>(),
        render: () => ["TASK ACTIONS"],
        handleInput: () => undefined,
        invalidate: () => undefined,
      } satisfies TestSelector;
      selectors.push(selector);
      return selector;
    },
  });
  return {
    controller,
    selectors,
    addSystem,
    closeOverlay,
    openOverlay,
    overlayHandles,
    requestRender,
    listTaskSuggestions,
    listCloudWorkerProfiles,
    acceptTaskSuggestion,
    dismissTaskSuggestion,
    onAccepted,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
    setActionCapabilities: (value: {
      canAccept: boolean;
      canAcceptModes: boolean;
      canDismiss: boolean;
    }) => {
      actionCapabilities = value;
    },
  };
}

describe("TUI task suggestions", () => {
  it("ignores malformed Gateway suggestion payloads", () => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: { id: "task_missing_fields" },
    });
    expect(harness.openOverlay).not.toHaveBeenCalled();
  });

  it("shows an active-session suggestion and starts it after confirmation", async () => {
    const harness = createHarness();

    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const renderedPrompt = stripAnsi(
      expectDefined(prompt, "prompt test invariant").render(80).join("\n"),
    );
    expect(renderedPrompt).toContain("Suggested follow-up: Remove stale adapter");
    expect(renderedPrompt).toContain("Project: /repo/project");
    expect(renderedPrompt).toContain("Why: The adapter is unreachable");
    expect(renderedPrompt).toContain("Instructions:");
    expect(renderedPrompt).toContain("Delete the stale adapter and update its tests.");
    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual([
      "accept-local",
      "accept-session",
      "accept",
      "dismiss",
    ]);
    expect(harness.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(3);

    const accept = { value: "accept", label: "Start in worktree" };
    harness.selectors[0]?.onSelect?.(accept);
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
    expect(
      stripAnsi(expectDefined(prompt, "prompt test invariant").render(80).join("\n")),
    ).toContain("Press Enter again");
    harness.selectors[0]?.onSelect?.(accept);

    await vi.waitFor(() => {
      expect(harness.acceptTaskSuggestion).toHaveBeenCalledWith("task_1", "worktree", undefined);
      expect(harness.onAccepted).toHaveBeenCalledWith("agent:main:task");
    });
    expect(harness.addSystem).toHaveBeenCalledWith("follow-up task started in agent:main:task");
  });

  it.each([
    { value: "accept-local", mode: "local" as const },
    { value: "accept-session", mode: "session" as const },
  ])("forwards $mode acceptance after double Enter", async ({ value, mode }) => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });
    const action = expectDefined(
      harness.selectors[0]?.items.find((item) => item.value === value),
      `${mode} action`,
    );

    harness.selectors[0]?.onSelect?.(action);
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
    harness.selectors[0]?.onSelect?.(action);

    await vi.waitFor(() => {
      expect(harness.acceptTaskSuggestion).toHaveBeenCalledWith("task_1", mode, undefined);
    });
    if (mode === "session") {
      expect(harness.onAccepted).not.toHaveBeenCalled();
    }
  });

  it("offers one cloud action per profile and forwards the selected profile", async () => {
    const harness = createHarness();
    const suggestion = suggestionPayload();
    harness.listTaskSuggestions.mockResolvedValueOnce([suggestion]);
    harness.listCloudWorkerProfiles.mockResolvedValueOnce(["build", "review"]);

    await harness.controller.refresh();

    const cloudActions = harness.selectors[0]?.items.filter(
      (item) => item.value === "accept-cloud",
    );
    expect(cloudActions?.map((item) => item.label)).toEqual([
      "Send to cloud · build",
      "Send to cloud · review",
    ]);
    const review = expectDefined(cloudActions?.[1], "review cloud action");
    harness.selectors[0]?.onSelect?.(review);
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
    harness.selectors[0]?.onSelect?.(review);

    await vi.waitFor(() => {
      expect(harness.acceptTaskSuggestion).toHaveBeenCalledWith("task_1", "cloud", "review");
    });
  });

  it("keeps actions visible while paging through long instructions", () => {
    const harness = createHarness();
    const promptLines = Array.from(
      { length: 20 },
      (_, index) => `instruction-${String(index + 1).padStart(2, "0")}`,
    );
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload({ prompt: promptLines.join("\n") }),
    });

    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const firstPage = stripAnsi(
      expectDefined(prompt, "prompt test invariant").render(80).join("\n"),
    );
    expect(firstPage).toContain("instruction-01");
    expect(firstPage).not.toContain("instruction-20");
    expect(firstPage).toContain("PgUp/PgDn to inspect");
    expect(firstPage).toContain("TASK ACTIONS");

    const pages = [firstPage];
    for (let page = 0; page < 3; page += 1) {
      expectDefined(prompt, "prompt test invariant").handleInput?.("\u001b[6~");
      const rendered = stripAnsi(
        expectDefined(prompt, "prompt test invariant").render(80).join("\n"),
      );
      pages.push(rendered);
      expect(rendered).toContain("TASK ACTIONS");
    }
    expect(pages.join("\n")).toContain("instruction-20");
    expect(harness.requestRender).toHaveBeenCalled();
  });

  it("keeps every project path segment inspectable before acceptance", () => {
    const harness = createHarness();
    const cwd = `/repo/${"nested-segment/".repeat(20)}distinguishing-project`;
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload({ cwd }),
    });

    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const pages: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const rendered = stripAnsi(
        expectDefined(prompt, "prompt test invariant").render(24).join("\n"),
      );
      pages.push(rendered);
      expect(rendered).toContain("TASK ACTIONS");
      expectDefined(prompt, "prompt test invariant").handleInput?.("\u001b[6~");
    }
    expect(pages.join("\n").replace(/\s/g, "")).toContain("distinguishing-project");
  });

  it("strips bidi controls from every displayed confirmation field", () => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload({
        title: "safe\u202eevil",
        cwd: "/repo/\u2066project",
        tldr: "why\u200f now",
        prompt: "run\u202d exactly",
      }),
    });

    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const rendered = stripAnsi(
      expectDefined(prompt, "prompt test invariant").render(80).join("\n"),
    );
    expect(rendered).toContain("safeevil");
    expect(rendered).toContain("/repo/project");
    expect(rendered).toContain("why now");
    expect(rendered).toContain("run exactly");
    expect(rendered).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("dismisses a suggestion without starting work", async () => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });

    harness.selectors[0]?.onSelect?.({ value: "dismiss", label: "Dismiss" });

    await vi.waitFor(() => {
      expect(harness.dismissTaskSuggestion).toHaveBeenCalledWith("task_1");
    });
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith("follow-up task dismissed");
  });

  it("offers only actions allowed by the connected operator scopes", () => {
    const writeHarness = createHarness();
    writeHarness.setActionCapabilities({
      canAccept: false,
      canAcceptModes: true,
      canDismiss: true,
    });
    writeHarness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });
    expect(writeHarness.selectors[0]?.items.map((item) => item.value)).toEqual(["dismiss"]);
    expect(writeHarness.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(0);

    const readHarness = createHarness();
    readHarness.setActionCapabilities({
      canAccept: false,
      canAcceptModes: true,
      canDismiss: false,
    });
    readHarness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });
    expect(readHarness.openOverlay).not.toHaveBeenCalled();
  });

  it("offers only worktree acceptance when modes are not advertised", () => {
    const harness = createHarness();
    harness.setActionCapabilities({
      canAccept: true,
      canAcceptModes: false,
      canDismiss: true,
    });

    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });

    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual(["accept", "dismiss"]);
  });

  it("rebuilds an active selector when reconnect changes action scopes", async () => {
    const harness = createHarness();
    const suggestion = suggestionPayload();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion,
    });
    const staleSelector = harness.selectors[0];

    harness.setActionCapabilities({
      canAccept: false,
      canAcceptModes: true,
      canDismiss: true,
    });
    harness.listTaskSuggestions.mockResolvedValueOnce([suggestion]);
    await harness.controller.refresh();

    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandles[0]);
    expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    expect(harness.selectors[1]?.items.map((item) => item.value)).toEqual(["dismiss"]);
    staleSelector?.onSelect?.({ value: "accept", label: "Start in worktree" });
    staleSelector?.onSelect?.({ value: "accept", label: "Start in worktree" });
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
  });

  it("rebuilds an active selector when cloud profile identity changes", async () => {
    const harness = createHarness();
    const suggestion = suggestionPayload();
    harness.listTaskSuggestions.mockResolvedValue([suggestion]);
    harness.listCloudWorkerProfiles.mockResolvedValueOnce(["build"]);

    await harness.controller.refresh();
    expect(harness.selectors[0]?.items.map((item) => item.label)).toContain(
      "Send to cloud · build",
    );

    harness.listCloudWorkerProfiles.mockResolvedValueOnce(["review"]);
    await harness.controller.refresh();

    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandles[0]);
    expect(harness.selectors[1]?.items.map((item) => item.label)).toContain(
      "Send to cloud · review",
    );
  });

  it("shows a still-pending suggestion again when its action fails", async () => {
    const harness = createHarness();
    harness.acceptTaskSuggestion.mockRejectedValueOnce(new Error("gateway unavailable"));
    harness.listTaskSuggestions.mockResolvedValueOnce([suggestionPayload()]);
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });

    const accept = { value: "accept", label: "Start in worktree" };
    harness.selectors[0]?.onSelect?.(accept);
    harness.selectors[0]?.onSelect?.(accept);

    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    expect(harness.addSystem).toHaveBeenCalledWith("follow-up task failed: gateway unavailable");
  });

  it("does not switch sessions after the operator navigates away during acceptance", async () => {
    const harness = createHarness();
    const pendingAccept = deferred<{ taskId: string; key: string }>();
    harness.acceptTaskSuggestion.mockReturnValueOnce(pendingAccept.promise);
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });

    const accept = { value: "accept", label: "Start in worktree" };
    harness.selectors[0]?.onSelect?.(accept);
    harness.selectors[0]?.onSelect?.(accept);
    harness.setSessionKey("agent:main:other");
    harness.controller.sessionChanged();
    pendingAccept.resolve({ taskId: "task_1", key: "agent:main:task" });

    await vi.waitFor(() => {
      expect(harness.addSystem).toHaveBeenCalledWith("follow-up task started in agent:main:task");
    });
    expect(harness.onAccepted).not.toHaveBeenCalled();
  });

  it.each(["accept", "dismiss"])(
    "keeps an in-flight %s hidden across navigation and refresh",
    async (value) => {
      const harness = createHarness();
      const pending = deferred<{ taskId: string; key: string; dismissed: boolean }>();
      const action =
        value === "accept" ? harness.acceptTaskSuggestion : harness.dismissTaskSuggestion;
      action.mockReturnValueOnce(pending.promise);
      harness.listTaskSuggestions.mockResolvedValue([suggestionPayload()]);
      await harness.controller.refresh();
      const item = expectDefined(
        harness.selectors[0]?.items.find((entry) => entry.value === value),
        "pending task action",
      );
      harness.selectors[0]?.onSelect?.(item);
      if (value === "accept") {
        harness.selectors[0]?.onSelect?.(item);
      }
      expect(action).toHaveBeenCalledTimes(1);

      harness.setSessionKey("agent:main:other");
      harness.controller.sessionChanged();
      harness.setSessionKey("agent:main:main");
      harness.controller.sessionChanged();
      await harness.controller.refresh();
      harness.controller.handleEvent("task.suggestion", {
        action: "created",
        suggestion: suggestionPayload(),
      });
      expect(harness.openOverlay).toHaveBeenCalledTimes(1);

      pending.resolve({ taskId: "task_1", key: "agent:main:task", dismissed: true });
      await new Promise(setImmediate);
      expect(action).toHaveBeenCalledTimes(1);
      expect(harness.openOverlay).toHaveBeenCalledTimes(1);
      expect(harness.addSystem).toHaveBeenCalledWith(
        value === "accept"
          ? "follow-up task started in agent:main:task"
          : "follow-up task dismissed",
      );
    },
  );

  it.each([
    { value: "accept", fails: false },
    { value: "accept", fails: true },
    { value: "dismiss", fails: false },
    { value: "dismiss", fails: true },
  ])("ignores $value completion after disposal (fails=$fails)", async ({ value, fails }) => {
    const harness = createHarness();
    const pending = deferred<{ taskId: string; key: string; dismissed: boolean }>();
    const action =
      value === "accept" ? harness.acceptTaskSuggestion : harness.dismissTaskSuggestion;
    action.mockReturnValueOnce(pending.promise);
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });
    const item = expectDefined(
      harness.selectors[0]?.items.find((entry) => entry.value === value),
      "pending task action",
    );
    harness.selectors[0]?.onSelect?.(item);
    if (value === "accept") {
      harness.selectors[0]?.onSelect?.(item);
    }
    expect(action).toHaveBeenCalledTimes(1);
    harness.controller.dispose();
    harness.requestRender.mockClear();
    if (fails) {
      pending.reject(new Error("gateway unavailable"));
    } else {
      pending.resolve({ taskId: "task_1", key: "agent:main:task", dismissed: true });
    }
    await new Promise(setImmediate);

    expect(harness.onAccepted).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(harness.listTaskSuggestions).not.toHaveBeenCalled();
    expect(harness.requestRender).not.toHaveBeenCalled();
  });

  it("ignores a failed recovery refresh after disposal", async () => {
    const harness = createHarness();
    const pending = deferred<unknown[]>();
    harness.dismissTaskSuggestion.mockRejectedValueOnce(new Error("gateway unavailable"));
    harness.listTaskSuggestions.mockReturnValueOnce(pending.promise);
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });
    harness.selectors[0]?.onSelect?.({ value: "dismiss", label: "Dismiss" });
    await vi.waitFor(() => expect(harness.listTaskSuggestions).toHaveBeenCalledTimes(1));
    harness.controller.dispose();
    harness.addSystem.mockClear();
    pending.reject(new Error("refresh unavailable"));
    await new Promise(setImmediate);

    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it("shows only suggestions for the active session", () => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload({ sessionKey: "agent:other:main", agentId: "other" }),
    });
    expect(harness.openOverlay).not.toHaveBeenCalled();

    harness.setSessionKey("agent:other:main");
    harness.setAgentId("other");
    harness.controller.sessionChanged();

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "shows a fixed-store alias owned by the active agent",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      suggestionAgent: "main",
      suggestionSession: "support",
      visible: true,
    },
    {
      label: "rejects a fixed-store alias owned by another agent",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      suggestionAgent: "work",
      suggestionSession: "support",
      visible: false,
    },
    {
      label: "rejects a fixed-store alias without explicit owner evidence",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      suggestionAgent: undefined,
      suggestionSession: "support",
      visible: false,
    },
    {
      label: "rejects a matching canonical key with a contradictory explicit owner",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      suggestionAgent: "work",
      suggestionSession: "agent:main:support",
      visible: false,
    },
    {
      label: "accepts a canonical key whose parsed owner identifies the active agent",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      suggestionAgent: undefined,
      suggestionSession: "agent:main:support",
      visible: true,
    },
    {
      label: "rejects a foreign canonical key against a bare selected alias",
      selectedAgent: "main",
      selectedSession: "support",
      suggestionAgent: "main",
      suggestionSession: "agent:work:support",
      visible: false,
    },
    {
      label: "rejects a global suggestion without explicit owner evidence",
      selectedAgent: "main",
      selectedSession: "global",
      suggestionAgent: undefined,
      suggestionSession: "global",
      visible: false,
    },
    {
      label: "preserves case-sensitive opaque session references",
      selectedAgent: "main",
      selectedSession: "agent:main:matrix:group:!Room:example.org",
      suggestionAgent: "main",
      suggestionSession: "matrix:group:!room:example.org",
      visible: false,
    },
  ])(
    "$label",
    ({ selectedAgent, selectedSession, suggestionAgent, suggestionSession, visible }) => {
      const harness = createHarness();
      harness.setAgentId(selectedAgent);
      harness.setSessionKey(selectedSession);

      harness.controller.handleEvent("task.suggestion", {
        action: "created",
        suggestion: suggestionPayload({ agentId: suggestionAgent, sessionKey: suggestionSession }),
      });

      expect(harness.openOverlay).toHaveBeenCalledTimes(visible ? 1 : 0);
    },
  );

  it("closes a suggestion resolved by another client", () => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });

    harness.controller.handleEvent("task.suggestion", {
      action: "resolved",
      taskId: "task_1",
      resolution: "accepted",
    });

    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandles[0]);
  });

  it("does not resurrect a resolved suggestion from a stale refresh", async () => {
    const harness = createHarness();
    const pendingList = deferred<unknown[]>();
    harness.listTaskSuggestions.mockReturnValueOnce(pendingList.promise);

    const refresh = harness.controller.refresh();
    harness.controller.handleEvent("task.suggestion", {
      action: "resolved",
      taskId: "task_1",
      resolution: "dismissed",
    });
    pendingList.resolve([suggestionPayload()]);
    await refresh;

    expect(harness.openOverlay).not.toHaveBeenCalled();
  });
});
