import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  createTuiPluginApprovalController,
  parseTuiPluginApproval,
} from "./tui-plugin-approvals.js";

type TestSelector = Component & {
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex: ReturnType<typeof vi.fn<(index: number) => void>>;
};

function approvalPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin:skill-1",
    request: {
      title: "Apply workspace skill proposal",
      description: "Apply a pending workspace skill proposal into live workspace skills.",
      pluginId: "workspace-skills",
      severity: "warning",
      toolName: "skill_workshop",
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: "agent:main:main",
    },
    createdAtMs: 1_000,
    expiresAtMs: 6_000,
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
  const resolvePluginApproval = vi.fn().mockResolvedValue({ ok: true });
  const listPluginApprovals = vi.fn().mockResolvedValue([]);
  const clearTimeoutFn = vi.fn();
  const timers: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
  const setTimeoutFn = vi.fn(() => {
    const timer = { unref: vi.fn() };
    timers.push(timer);
    return timer as unknown as NodeJS.Timeout;
  });
  let agentId = "main";
  let sessionKey = "agent:main:main";
  let now = 1_000;
  const controller = createTuiPluginApprovalController({
    client: { listPluginApprovals, resolvePluginApproval },
    chatLog: { addSystem },
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    openOverlay,
    closeOverlay,
    requestRender,
    createSelector: (items) => {
      const selector = {
        items,
        setSelectedIndex: vi.fn<(index: number) => void>(),
        render: () => [],
        handleInput: () => undefined,
        invalidate: () => undefined,
      } satisfies TestSelector;
      selectors.push(selector);
      return selector;
    },
    nowMs: () => now,
    setTimeoutFn,
    clearTimeoutFn,
  });
  return {
    controller,
    selectors,
    addSystem,
    closeOverlay,
    openOverlay,
    overlayHandles,
    requestRender,
    resolvePluginApproval,
    listPluginApprovals,
    clearTimeoutFn,
    setTimeoutFn,
    timers,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("TUI plugin approvals", () => {
  it("parses the pending plugin approval gateway shape", () => {
    expect(parseTuiPluginApproval(approvalPayload())).toEqual(approvalPayload());
    expect(parseTuiPluginApproval({ id: "plugin:missing-request" })).toBeNull();
  });

  it("shows workspace skill approvals for the active session and resolves the selection", async () => {
    const harness = createHarness();

    harness.controller.handleEvent("plugin.approval.requested", approvalPayload());

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const renderedPrompt = stripAnsi(
      expectDefined(prompt, "prompt test invariant").render(80).join("\n"),
    );
    expect(renderedPrompt).toContain("workspace skill approval: Apply workspace skill proposal");
    expect(renderedPrompt).toContain("Severity: Warning");
    expect(renderedPrompt).toContain("Tool: skill_workshop");
    expect(renderedPrompt).toContain("Plugin: workspace-skills");
    expect(renderedPrompt).toContain(
      "Apply a pending workspace skill proposal into live workspace skills.",
    );
    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual(["allow-once", "deny"]);
    expect(harness.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(1);

    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    harness.selectors[0]?.onSelectionChange?.({ value: "allow-once", label: "Allow once" });
    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    await vi.waitFor(() => {
      expect(harness.resolvePluginApproval).toHaveBeenCalledWith("plugin:skill-1", "allow-once");
    });
    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.addSystem).toHaveBeenLastCalledWith("workspace skill approval: allowed once");
  });

  it("ignores other sessions and restores matching pending approvals after connect", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:other",
        request: {
          ...approvalPayload().request,
          sessionKey: "agent:other:main",
        },
      }),
    );
    expect(harness.openOverlay).not.toHaveBeenCalled();

    harness.setSessionKey("agent:other:main");
    harness.controller.sessionChanged();
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);

    harness.controller.handleEvent("plugin.approval.resolved", { id: "plugin:other" });
    harness.setSessionKey("agent:main:main");
    harness.listPluginApprovals.mockResolvedValueOnce([approvalPayload()]);
    await harness.controller.refresh();

    expect(harness.listPluginApprovals).toHaveBeenCalledTimes(1);
    expect(harness.openOverlay).toHaveBeenCalledTimes(2);
  });

  it("preserves requested events received while a refresh is in flight", async () => {
    const harness = createHarness();
    const pendingList = deferred<unknown[]>();
    harness.listPluginApprovals.mockReturnValueOnce(pendingList.promise);

    const refresh = harness.controller.refresh();
    harness.controller.handleEvent("plugin.approval.requested", approvalPayload());
    pendingList.resolve([]);
    await refresh;

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect resolved approvals from a stale refresh snapshot", async () => {
    const harness = createHarness();
    const pendingList = deferred<unknown[]>();
    harness.listPluginApprovals.mockReturnValueOnce(pendingList.promise);

    const refresh = harness.controller.refresh();
    harness.controller.handleEvent("plugin.approval.resolved", { id: "plugin:skill-1" });
    pendingList.resolve([approvalPayload()]);
    await refresh;

    expect(harness.openOverlay).not.toHaveBeenCalled();
  });

  it("reruns a refresh requested while another refresh is in flight", async () => {
    const harness = createHarness();
    const pendingList = deferred<unknown[]>();
    harness.listPluginApprovals.mockReturnValueOnce(pendingList.promise).mockResolvedValueOnce([]);

    const firstRefresh = harness.controller.refresh();
    const secondRefresh = harness.controller.refresh();
    pendingList.resolve([]);
    await Promise.all([firstRefresh, secondRefresh]);

    expect(harness.listPluginApprovals).toHaveBeenCalledTimes(2);
  });

  it("binds global-session approvals to the active agent", () => {
    const harness = createHarness();
    harness.setSessionKey("global");
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        request: {
          ...approvalPayload().request,
          agentId: "work",
          sessionKey: "global",
        },
      }),
    );

    expect(harness.openOverlay).not.toHaveBeenCalled();

    harness.setAgentId("work");
    harness.controller.sessionChanged();

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it.each(["plugin.approval.resolved", "plugin.approval.removed"])(
    "closes an active prompt on %s",
    (event) => {
      const harness = createHarness();
      harness.controller.handleEvent("plugin.approval.requested", approvalPayload());

      harness.controller.handleEvent(event, {
        id: "plugin:skill-1",
        decision: "deny",
      });

      expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
      expect(harness.closeOverlay).toHaveBeenCalledWith(harness.overlayHandles[0]);
    },
  );

  it("dismisses allow-only approvals without authorizing them", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["allow-once"],
        },
      }),
    );

    harness.selectors[0]?.onCancel?.();

    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval: dismissed; request remains pending",
    );

    harness.controller.sessionChanged();
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it("requires a visible second confirmation for allow-only approvals", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["allow-once"],
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({ value: "allow-once", label: "Allow once" });
    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });

    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    expect(
      stripAnsi(expectDefined(prompt, "prompt test invariant").render(80).join("\n")),
    ).toContain("Press Enter again to confirm Allow once.");

    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    await vi.waitFor(() => {
      expect(harness.resolvePluginApproval).toHaveBeenCalledWith("plugin:skill-1", "allow-once");
    });
  });

  it("reopens a pending approval when resolution fails", async () => {
    const harness = createHarness();
    harness.resolvePluginApproval
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ ok: true });
    harness.controller.handleEvent("plugin.approval.requested", approvalPayload());

    harness.selectors[0]?.onSelectionChange?.({ value: "allow-once", label: "Allow once" });
    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    expect(harness.addSystem).toHaveBeenLastCalledWith(
      "workspace skill approval failed: gateway unavailable",
    );

    harness.selectors[1]?.onSelectionChange?.({ value: "allow-once", label: "Allow once" });
    harness.selectors[1]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    await vi.waitFor(() => {
      expect(harness.resolvePluginApproval).toHaveBeenCalledTimes(2);
    });
    expect(harness.addSystem).toHaveBeenLastCalledWith("workspace skill approval: allowed once");
  });

  it("does not reopen an approval while its decision is in flight", async () => {
    const harness = createHarness();
    const pendingResolution = deferred<{ ok: true }>();
    harness.resolvePluginApproval.mockReturnValueOnce(pendingResolution.promise);
    harness.controller.handleEvent("plugin.approval.requested", approvalPayload());

    harness.selectors[0]?.onSelectionChange?.({ value: "allow-once", label: "Allow once" });
    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    await vi.waitFor(() => {
      expect(harness.resolvePluginApproval).toHaveBeenCalledTimes(1);
    });

    harness.listPluginApprovals.mockResolvedValueOnce([approvalPayload()]);
    await harness.controller.refresh();

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);

    pendingResolution.resolve({ ok: true });
    await vi.waitFor(() => {
      expect(harness.addSystem).toHaveBeenLastCalledWith("workspace skill approval: allowed once");
    });
  });

  it("removes and refreshes approvals that another client already resolved", async () => {
    const harness = createHarness();
    const staleError = Object.assign(new Error("approval already resolved"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    });
    harness.resolvePluginApproval.mockRejectedValueOnce(staleError);
    harness.controller.handleEvent("plugin.approval.requested", approvalPayload());

    harness.selectors[0]?.onSelectionChange?.({ value: "allow-once", label: "Allow once" });
    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });

    await vi.waitFor(() => {
      expect(harness.listPluginApprovals).toHaveBeenCalledTimes(1);
    });
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    expect(harness.addSystem).toHaveBeenLastCalledWith(
      "workspace skill approval: no longer pending",
    );
  });

  it("flattens and sanitizes untrusted approval text", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        request: {
          ...approvalPayload().request,
          title: "Apply\nAllow once\u202E\u001B]52;c;YWJj\u0007 skill",
          description: "Review\nPress Enter again\u2066\u001B[2J this\u0000 change",
        },
      }),
    );

    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const renderedPrompt = expectDefined(prompt, "prompt test invariant").render(80).join("\n");
    expect(renderedPrompt).not.toContain("\u001B]52");
    expect(renderedPrompt).not.toContain("\u0007");
    expect(renderedPrompt).not.toContain("\u0000");
    expect(renderedPrompt).not.toContain("\u202E");
    expect(renderedPrompt).not.toContain("\u2066");
    expect(stripAnsi(renderedPrompt)).toContain("workspace skill approval: Apply Allow once skill");
    expect(stripAnsi(renderedPrompt)).toContain("Request: Review Press Enter again this change");
  });

  it("clears the active prompt timer when disposed", () => {
    const harness = createHarness();
    harness.controller.handleEvent("plugin.approval.requested", approvalPayload());

    expect(harness.timers[0]?.unref).toHaveBeenCalledTimes(1);

    harness.controller.dispose();
    harness.controller.dispose();

    expect(harness.clearTimeoutFn).toHaveBeenCalledTimes(1);
    expect(harness.clearTimeoutFn).toHaveBeenCalledWith(harness.timers[0]);
    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
  });
});
