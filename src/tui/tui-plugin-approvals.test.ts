import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createTuiPluginApprovalController } from "./tui-plugin-approvals.js";

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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHarness() {
  const selectors: TestSelector[] = [];
  const addSystem = vi.fn();
  const addPendingSystem = vi.fn();
  const dismissPendingSystem = vi.fn(() => true);
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
  const prepareExternalPluginApproval = vi.fn().mockResolvedValue({
    intent: "start",
    actionToken: "action-1",
  });
  const startExternalPluginApproval = vi.fn().mockResolvedValue({
    outcome: "started",
    presentations: ["Scan this challenge"],
  });
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
    client: {
      listPluginApprovals,
      prepareExternalPluginApproval,
      resolvePluginApproval,
      startExternalPluginApproval,
    },
    chatLog: { addSystem, addPendingSystem, dismissPendingSystem },
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    openOverlay,
    closeOverlay,
    requestRender,
    createSelector: (items) => {
      const selector = {
        items,
        setSelectedIndex: vi.fn<(index: number) => void>(),
        render: () => items.map((item) => item.label),
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
    addPendingSystem,
    dismissPendingSystem,
    closeOverlay,
    openOverlay,
    overlayHandles,
    requestRender,
    resolvePluginApproval,
    prepareExternalPluginApproval,
    startExternalPluginApproval,
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
  it("ignores malformed plugin approval gateway payloads", () => {
    const harness = createHarness();
    harness.controller.handleEvent("plugin.approval.requested", {
      id: "plugin:missing-request",
    });
    expect(harness.openOverlay).not.toHaveBeenCalled();
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
          agentId: "other",
          sessionKey: "agent:other:main",
        },
      }),
    );
    expect(harness.openOverlay).not.toHaveBeenCalled();

    harness.setAgentId("other");
    harness.setSessionKey("agent:other:main");
    harness.controller.sessionChanged();
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);

    harness.controller.handleEvent("plugin.approval.resolved", { id: "plugin:other" });
    harness.setAgentId("main");
    harness.setSessionKey("agent:main:main");
    harness.listPluginApprovals.mockResolvedValueOnce([approvalPayload()]);
    await harness.controller.refresh();

    expect(harness.listPluginApprovals).toHaveBeenCalledTimes(1);
    expect(harness.openOverlay).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "shows a fixed-store alias owned by the active agent",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      approvalAgent: "main",
      approvalSession: "support",
      visible: true,
    },
    {
      label: "matches normalized agent identities for a fixed-store alias",
      selectedAgent: "Main",
      selectedSession: "agent:main:support",
      approvalAgent: " MAIN ",
      approvalSession: "support",
      visible: true,
    },
    {
      label: "rejects a fixed-store alias owned by another agent",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      approvalAgent: "work",
      approvalSession: "support",
      visible: false,
    },
    {
      label: "rejects a fixed-store alias without explicit owner evidence",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      approvalAgent: null,
      approvalSession: "support",
      visible: false,
    },
    {
      label: "rejects a missing session key even with explicit owner evidence",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      approvalAgent: "main",
      approvalSession: null,
      visible: false,
    },
    {
      label: "rejects a matching canonical key with a contradictory explicit owner",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      approvalAgent: "work",
      approvalSession: "agent:main:support",
      visible: false,
    },
    {
      label: "accepts a canonical key whose parsed owner identifies the active agent",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      approvalAgent: null,
      approvalSession: "agent:main:support",
      visible: true,
    },
    {
      label: "rejects a different agent's canonical key with a colliding alias",
      selectedAgent: "main",
      selectedSession: "agent:main:support",
      approvalAgent: "work",
      approvalSession: "agent:work:support",
      visible: false,
    },
    {
      label: "rejects an ownerless foreign canonical key against a bare selected alias",
      selectedAgent: "main",
      selectedSession: "support",
      approvalAgent: null,
      approvalSession: "agent:work:support",
      visible: false,
    },
    {
      label: "rejects a foreign canonical key with a misleading explicit owner",
      selectedAgent: "main",
      selectedSession: "support",
      approvalAgent: "main",
      approvalSession: "agent:work:support",
      visible: false,
    },
    {
      label: "rejects a global approval without explicit owner evidence",
      selectedAgent: "main",
      selectedSession: "global",
      approvalAgent: null,
      approvalSession: "global",
      visible: false,
    },
    {
      label: "preserves case-sensitive opaque session references",
      selectedAgent: "main",
      selectedSession: "agent:main:matrix:group:!Room:example.org",
      approvalAgent: "main",
      approvalSession: "matrix:group:!room:example.org",
      visible: false,
    },
  ])("$label", ({ selectedAgent, selectedSession, approvalAgent, approvalSession, visible }) => {
    const harness = createHarness();
    harness.setAgentId(selectedAgent);
    harness.setSessionKey(selectedSession);

    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        request: {
          ...approvalPayload().request,
          agentId: approvalAgent,
          sessionKey: approvalSession,
        },
      }),
    );

    expect(harness.openOverlay).toHaveBeenCalledTimes(visible ? 1 : 0);
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

  it("renders and dispatches canonical external verification choices", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          title: "World proof required for exec",
          description: `Authorize this protected action. ${"context ".repeat(500)}`,
          pluginId: "openclaw-agentkit",
          toolName: "exec",
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once", "allow-always"],
          },
        },
      }),
    );

    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const promptLines = expectDefined(prompt, "prompt test invariant").render(100);
    const renderedPrompt = stripAnsi(promptLines.join("\n"));
    expect(promptLines.length).toBeLessThanOrEqual(24);
    expect(renderedPrompt).toContain("plugin approval: World proof required for exec");
    expect(renderedPrompt).toContain("Severity: Warning");
    expect(renderedPrompt).toContain("Tool: exec");
    expect(renderedPrompt).toContain("Plugin: openclaw-agentkit");
    expect(renderedPrompt).toContain("Request:");
    expect(renderedPrompt).toContain("Verify with World");
    expect(renderedPrompt).not.toContain("/approve");
    expect(renderedPrompt).toContain("Press Escape to dismiss; the request remains pending.");
    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual([
      "external:allow-once",
      "external:allow-always",
      "deny",
    ]);
    expect(harness.prepareExternalPluginApproval).not.toHaveBeenCalled();

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });

    await vi.waitFor(() => {
      expect(harness.startExternalPluginApproval).toHaveBeenCalledWith(
        "plugin:world-1",
        "allow-once",
        "action-1",
      );
    });
    expect(harness.prepareExternalPluginApproval).toHaveBeenCalledWith(
      "plugin:world-1",
      "allow-once",
    );
    expect(harness.addPendingSystem).toHaveBeenCalledWith(
      "plugin-external-verification:plugin:world-1",
      "Scan this challenge",
    );
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
  });

  it("never exposes generic allow actions for an external approval", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-no-generic-decisions",
        request: {
          ...approvalPayload().request,
          allowedDecisions: undefined,
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual([
      "external:allow-once",
      "deny",
    ]);
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
  });

  it("rejects malformed external verification metadata instead of exposing generic allows", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-invalid-external",
        request: {
          ...approvalPayload().request,
          allowedDecisions: undefined,
          externalResolution: {
            label: "Verify with World",
            decisions: [],
          },
        },
      }),
    );

    expect(harness.openOverlay).not.toHaveBeenCalled();
    expect(harness.selectors).toHaveLength(0);
  });

  it("does not invent denial when an external approval explicitly omits it", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-external-only",
        request: {
          ...approvalPayload().request,
          allowedDecisions: [],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual(["external:allow-once"]);
  });

  it.each([[[]], [["unsupported"]]])(
    "keeps generic approvals actionable when allowedDecisions is %j",
    (allowedDecisions: string[]) => {
      const harness = createHarness();
      harness.controller.handleEvent(
        "plugin.approval.requested",
        approvalPayload({
          request: {
            ...approvalPayload().request,
            allowedDecisions,
          },
        }),
      );

      expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual([
        "allow-once",
        "allow-always",
        "deny",
      ]);
    },
  );

  it("closes the card after a successful dispatch and routes refusal through chat", async () => {
    const harness = createHarness();
    const qrLines = Array.from(
      { length: 200 },
      (_, index) => ` QR row ${index + 1}${index === 0 ? "\u202e" : ""} `,
    );
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "started",
      presentations: [
        [
          "Verify with World",
          "Scan with World App",
          "```text",
          ...qrLines,
          "```",
          "Link: worldapp://verify/example",
        ].join("\n"),
      ],
    });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-qr",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-qr",
        expect.stringContaining("QR row 200"),
      );
    });

    // The dispatched challenge owns the approval: the card closes so the QR in
    // chat stays scannable and a stray Enter cannot mint a replacement.
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    expect(harness.closeOverlay).toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      expect.stringContaining("/approve plugin:world-qr deny"),
    );
  });

  it("publishes the full challenge to chat instead of re-rendering it in the card", async () => {
    const harness = createHarness();
    const qrLines = Array.from({ length: 200 }, (_, index) => ` QR row ${index + 1} `);
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "started",
      presentations: [["```text", ...qrLines, "```"].join("\n")],
    });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-qr-only",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-qr-only",
        expect.stringContaining("QR row 200"),
      );
    });

    // A cropped QR is invalid; the complete challenge lives in the chat log and
    // the card never re-renders it.
    expect(harness.addPendingSystem).toHaveBeenCalledWith(
      "plugin-external-verification:plugin:world-qr-only",
      expect.stringContaining("QR row 1"),
    );
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch after the approval resolves during action preparation", async () => {
    const harness = createHarness();
    const pending = deferred<{ intent: "start"; actionToken: string }>();
    harness.prepareExternalPluginApproval.mockReturnValueOnce(pending.promise);
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-resolves-during-prepare",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.controller.handleEvent("plugin.approval.resolved", {
      id: "plugin:world-resolves-during-prepare",
    });

    pending.resolve({ intent: "start", actionToken: "stale-action" });
    await pending.promise;
    await Promise.resolve();
    expect(harness.startExternalPluginApproval).not.toHaveBeenCalled();
  });

  it("discards a verifier challenge when the approval resolves during dispatch", async () => {
    const harness = createHarness();
    const pending = deferred<{ outcome: "started"; presentations: string[] }>();
    harness.startExternalPluginApproval.mockReturnValueOnce(pending.promise);
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-resolves-during-dispatch",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.startExternalPluginApproval).toHaveBeenCalledOnce();
    });
    harness.controller.handleEvent("plugin.approval.resolved", {
      id: "plugin:world-resolves-during-dispatch",
    });
    const renderCountAfterResolution = harness.requestRender.mock.calls.length;

    pending.resolve({ outcome: "started", presentations: ["Stale challenge"] });
    await vi.waitFor(() => {
      expect(harness.requestRender.mock.calls.length).toBeGreaterThan(renderCountAfterResolution);
    });
    expect(harness.addPendingSystem).not.toHaveBeenCalled();
  });

  it.each(["resolved", "disposed"] as const)(
    "suppresses verifier failure after the approval controller is %s",
    async (transition) => {
      const harness = createHarness();
      const pending = deferred<{ outcome: "started"; presentations: string[] }>();
      const id = `plugin:world-fails-after-${transition}`;
      harness.startExternalPluginApproval.mockReturnValueOnce(pending.promise);
      harness.controller.handleEvent(
        "plugin.approval.requested",
        approvalPayload({
          id,
          request: {
            ...approvalPayload().request,
            allowedDecisions: ["deny"],
            externalResolution: {
              label: "Verify with World",
              decisions: ["allow-once"],
            },
          },
        }),
      );

      harness.selectors[0]?.onSelectionChange?.({
        value: "external:allow-once",
        label: "Verify once",
      });
      harness.selectors[0]?.onSelect?.({
        value: "external:allow-once",
        label: "Verify once",
      });
      await vi.waitFor(() => {
        expect(harness.startExternalPluginApproval).toHaveBeenCalledOnce();
      });
      if (transition === "resolved") {
        harness.controller.handleEvent("plugin.approval.resolved", { id });
      } else {
        harness.controller.dispose();
      }

      pending.reject(new Error("late verifier failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.addSystem).not.toHaveBeenCalled();
    },
  );

  it("reopens with a fresh action instead of rendering a stale-action response", async () => {
    const harness = createHarness();
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "stale-action",
      presentations: ["Stale challenge"],
    });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-stale-action",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.selectors).toHaveLength(2);
    });
    expect(harness.addPendingSystem).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval failed: external approval action is stale; retry from the current prompt",
    );
  });

  it("dismisses external verification without denying", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onCancel?.();

    expect(harness.startExternalPluginApproval).not.toHaveBeenCalled();
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval: dismissed; request remains pending",
    );
  });

  it("reopens external verification with a fresh action after setup failure", async () => {
    const harness = createHarness();
    harness.prepareExternalPluginApproval
      .mockResolvedValueOnce({ intent: "start", actionToken: "action-1" })
      .mockResolvedValueOnce({ intent: "start", actionToken: "action-2" });
    harness.startExternalPluginApproval
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce({
        outcome: "started",
        presentations: ["Scan replacement challenge"],
      });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.selectors).toHaveLength(2);
    });
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval failed: broker unavailable",
    );

    harness.selectors[1]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[1]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.startExternalPluginApproval).toHaveBeenNthCalledWith(
        2,
        "plugin:world-1",
        "allow-once",
        "action-2",
      );
    });
    expect(harness.addPendingSystem).toHaveBeenCalledWith(
      "plugin-external-verification:plugin:world-1",
      "Scan replacement challenge",
    );
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
  });

  it("holds queued approvals while a dispatched ceremony awaits its scan", async () => {
    const harness = createHarness();
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "started",
      presentations: ["Scan challenge one"],
    });
    const external = {
      label: "Verify with World",
      decisions: ["allow-once"],
    };
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-first",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: external,
        },
      }),
    );
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-second",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: external,
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-first",
        expect.stringContaining("Scan challenge one"),
      );
    });

    // The reviewer is mid-ceremony: the second approval must not compete for
    // the screen until the first resolves.
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);

    harness.controller.handleEvent("plugin.approval.resolved", { id: "plugin:world-first" });
    expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    const secondPrompt = harness.openOverlay.mock.calls[1]?.[0];
    const rendered = stripAnsi(
      expectDefined(secondPrompt, "held prompt test invariant").render(80).join("\n"),
    );
    expect(rendered).toContain("workspace skill approval:");
  });

  it("keeps the card for retry after a failed dispatch and closes it on success", async () => {
    const harness = createHarness();
    harness.prepareExternalPluginApproval
      .mockResolvedValueOnce({ intent: "start", actionToken: "action-1" })
      .mockResolvedValueOnce({ intent: "retry", actionToken: "action-2" });
    harness.startExternalPluginApproval
      .mockRejectedValueOnce(new Error("dispatch unavailable"))
      .mockResolvedValueOnce({
        outcome: "started",
        presentations: ["Fresh challenge after retry"],
      });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    // A failed dispatch keeps deny one keypress away: the card re-presents.
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval failed: dispatch unavailable",
    );

    harness.selectors[1]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[1]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-1",
        expect.stringContaining("Fresh challenge after retry"),
      );
    });
    // The successful retry dispatch closes the card like any first dispatch.
    expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    expect(harness.addSystem).toHaveBeenCalledWith(
      expect.stringContaining("/approve plugin:world-1 deny"),
    );
  });

  it("keeps explicit denial available for external verification approvals", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelect?.({ value: "deny", label: "Deny" });

    await vi.waitFor(() => {
      expect(harness.resolvePluginApproval).toHaveBeenCalledWith("plugin:world-1", "deny");
    });
    expect(harness.addSystem).toHaveBeenLastCalledWith("workspace skill approval: denied");
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
