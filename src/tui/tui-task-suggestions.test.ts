import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  const acceptTaskSuggestion = vi
    .fn()
    .mockResolvedValue({ taskId: "task_1", key: "agent:main:task" });
  const dismissTaskSuggestion = vi.fn().mockResolvedValue({ taskId: "task_1", dismissed: true });
  const onAccepted = vi.fn().mockResolvedValue(undefined);
  let agentId = "main";
  let sessionKey = "agent:main:main";
  let actionCapabilities = { canAccept: true, canDismiss: true };
  const controller = createTuiTaskSuggestionController({
    client: {
      getTaskSuggestionActionCapabilities: () => actionCapabilities,
      listTaskSuggestions,
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
    acceptTaskSuggestion,
    dismissTaskSuggestion,
    onAccepted,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
    setActionCapabilities: (value: { canAccept: boolean; canDismiss: boolean }) => {
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
    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual(["accept", "dismiss"]);
    expect(harness.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(1);

    const accept = { value: "accept", label: "Start in worktree" };
    harness.selectors[0]?.onSelect?.(accept);
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
    expect(
      stripAnsi(expectDefined(prompt, "prompt test invariant").render(80).join("\n")),
    ).toContain("Press Enter again");
    harness.selectors[0]?.onSelect?.(accept);

    await vi.waitFor(() => {
      expect(harness.acceptTaskSuggestion).toHaveBeenCalledWith("task_1");
      expect(harness.onAccepted).toHaveBeenCalledWith("agent:main:task");
    });
    expect(harness.addSystem).toHaveBeenCalledWith("follow-up task started in agent:main:task");
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
    writeHarness.setActionCapabilities({ canAccept: false, canDismiss: true });
    writeHarness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });
    expect(writeHarness.selectors[0]?.items.map((item) => item.value)).toEqual(["dismiss"]);
    expect(writeHarness.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(0);

    const readHarness = createHarness();
    readHarness.setActionCapabilities({ canAccept: false, canDismiss: false });
    readHarness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });
    expect(readHarness.openOverlay).not.toHaveBeenCalled();
  });

  it("rebuilds an active selector when reconnect changes action scopes", async () => {
    const harness = createHarness();
    const suggestion = suggestionPayload();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion,
    });
    const staleSelector = harness.selectors[0];

    harness.setActionCapabilities({ canAccept: false, canDismiss: true });
    harness.listTaskSuggestions.mockResolvedValueOnce([suggestion]);
    await harness.controller.refresh();

    expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandles[0]);
    expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    expect(harness.selectors[1]?.items.map((item) => item.value)).toEqual(["dismiss"]);
    staleSelector?.onSelect?.({ value: "accept", label: "Start in worktree" });
    staleSelector?.onSelect?.({ value: "accept", label: "Start in worktree" });
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
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
