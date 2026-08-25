/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderChatPaneComposerControls,
  resolveChatModelCatalogState,
} from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatPermissionPicker } from "./components/chat-permission-picker.ts";

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));

vi.mock("../../lib/toast.ts", () => ({ showToast: showToastMock }));

describe("chat model catalog state", () => {
  const cachedCatalog = [
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      provider: "openai",
      available: false,
    },
  ];

  it.each([
    {
      label: "ready",
      state: {
        chatModelCatalog: [],
        chatModelCatalogError: null,
        chatModelsLoading: false,
        connected: true,
      },
      expected: { hasSnapshot: true, status: "ready" },
    },
    {
      label: "refreshing with a cached snapshot",
      state: {
        chatModelCatalog: cachedCatalog,
        chatModelCatalogError: null,
        chatModelsLoading: true,
        connected: true,
      },
      expected: { hasSnapshot: true, status: "refreshing" },
    },
    {
      label: "offline",
      state: {
        chatModelCatalog: cachedCatalog,
        chatModelCatalogError: null,
        chatModelsLoading: false,
        connected: false,
      },
      expected: { hasSnapshot: true, status: "offline" },
    },
    {
      label: "error",
      state: {
        chatModelCatalog: cachedCatalog,
        chatModelCatalogError: "metadata unavailable",
        chatModelsLoading: false,
        connected: true,
      },
      expected: { hasSnapshot: true, status: "error" },
    },
  ])("resolves $label", ({ state, expected }) => {
    expect(resolveChatModelCatalogState(state)).toEqual(expected);
  });
});

describe("chat pane composer controls", () => {
  it("assembles model and permission controls as separate footer inputs", () => {
    const container = document.createElement("div");
    const state = {
      chatRunId: null,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} }, patch: vi.fn() },
      chatModelSwitchPromises: {},
      sessionKey: "main",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
    } as unknown as ChatPageHost;
    const onModelSetup = vi.fn();
    const toastAnchor = document.createElement("div");

    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: undefined,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      toastAnchor,
      onModelSetup,
    });
    render(controls.composerControls, container);

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-composer-model-control",
    ]);
    expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
    expect(container.querySelector('[data-chat-permission-select="true"]')).toBeNull();
    const permissionContainer = document.createElement("div");
    render(renderChatPermissionPicker(controls.permissionPicker), permissionContainer);
    expect(
      permissionContainer.querySelector('[data-chat-permission-select="true"]'),
    ).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("patches a keyboard-selected mode, clears to default, and locks full access", async () => {
    const container = document.createElement("div");
    const patch = vi.fn(async () => ({}));
    const state = {
      chatRunId: null,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} }, patch },
      chatModelSwitchPromises: {},
      sessionKey: "agent:main:permission-test",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
    } as unknown as ChatPageHost;

    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: {
        key: "agent:main:permission-test",
        kind: "direct",
        permissionMode: "full",
        sessionRoot: "/workspace/projects/openclaw",
      },
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: false,
      toastAnchor: document.createElement("div"),
      onModelSetup: vi.fn(),
    });
    render(renderChatPermissionPicker(controls.permissionPicker), container);

    const dropdown = container.querySelector<HTMLElement>(".chat-controls__permission-picker");
    dropdown?.setAttribute("open", "");
    const full = container.querySelector<HTMLElement>('[data-chat-permission-option="full"]');
    const defaultOption = container.querySelector<HTMLElement>(
      '[data-chat-permission-option="default"]',
    );
    expect(defaultOption?.textContent).toContain("Follow the agent's configured policy");
    expect(full?.hasAttribute("disabled")).toBe(true);
    expect(full?.getAttribute("aria-checked")).toBe("true");
    expect(full?.querySelector(".chat-controls__inline-select-check")).not.toBeNull();
    expect(full?.getAttribute("aria-label")).toContain("operator.admin");

    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenCalledWith(
      "agent:main:permission-test",
      { permissionMode: "guarded" },
      {},
    );

    dropdown?.setAttribute("open", "");
    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenLastCalledWith(
      "agent:main:permission-test",
      { permissionMode: null },
      {},
    );
  });

  it.each([
    {
      label: "running",
      chatRunId: null,
      hasActiveRun: true,
      status: "running",
      outcome: "success",
      sessionError: null,
      toastCount: 1,
      expectedError: null,
    },
    {
      label: "locally running with a stale idle session row",
      chatRunId: "run-active",
      hasActiveRun: false,
      status: "done",
      outcome: "success",
      sessionError: null,
      toastCount: 1,
      expectedError: null,
    },
    {
      label: "idle",
      chatRunId: null,
      hasActiveRun: false,
      status: "done",
      outcome: "success",
      sessionError: null,
      toastCount: 0,
      expectedError: null,
    },
    {
      label: "running with an unavailable permission update",
      chatRunId: "run-active",
      hasActiveRun: true,
      status: "running",
      outcome: "unavailable",
      sessionError: "The previous gateway connection closed.",
      toastCount: 0,
      expectedError: "Failed to update permissions: Error: The previous gateway connection closed.",
    },
    {
      label: "idle with an unavailable permission update",
      chatRunId: null,
      hasActiveRun: false,
      status: "done",
      outcome: "unavailable",
      sessionError: null,
      toastCount: 0,
      expectedError:
        "Failed to update permissions: Error: Connect to the gateway to change session capabilities.",
    },
    {
      label: "running with a rejected permission update",
      chatRunId: "run-active",
      hasActiveRun: true,
      status: "running",
      outcome: "rejected",
      sessionError: null,
      toastCount: 0,
      expectedError: "Failed to update permissions: Error: Gateway rejected the update.",
    },
  ] as const)("reports the permission update outcome for a $label session", async (sessionCase) => {
    showToastMock.mockClear();
    const patch = vi.fn(async () => {
      if (sessionCase.outcome === "rejected") {
        throw new Error("Gateway rejected the update.");
      }
      return sessionCase.outcome === "success" ? {} : null;
    });
    const requestUpdate = vi.fn();
    const toastAnchor = document.createElement("div");
    const state = {
      chatRunId: sessionCase.chatRunId,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {}, error: sessionCase.sessionError }, patch },
      chatModelSwitchPromises: {},
      sessionKey: "agent:main:permission-notice",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      chatError: null,
      requestUpdate,
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: {
        key: state.sessionKey,
        kind: "direct",
        permissionMode: "read-only",
        hasActiveRun: sessionCase.hasActiveRun,
        status: sessionCase.status,
      },
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      toastAnchor,
      onModelSetup: vi.fn(),
    });

    const container = document.createElement("div");
    render(renderChatPermissionPicker(controls.permissionPicker), container);
    const dropdown = container.querySelector<HTMLElement>(".chat-controls__permission-picker");
    expect(dropdown).not.toBeNull();
    dropdown?.setAttribute("open", "");
    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    await vi.waitFor(() => {
      expect(patch).toHaveBeenCalledOnce();
      expect(state.chatError).toBe(sessionCase.expectedError);
      expect(showToastMock).toHaveBeenCalledTimes(sessionCase.toastCount);
    });

    expect(requestUpdate).toHaveBeenCalledTimes(sessionCase.expectedError ? 1 : 0);
    if (sessionCase.toastCount === 1) {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          anchor: toastAnchor,
          durationMs: 5_000,
          message: "New permissions apply to the next run.",
        }),
      );
    }
  });

  it("refreshes the configured model catalog when the picker opens", async () => {
    const container = document.createElement("div");
    const request = vi.fn(async () => ({ models: [] }));
    const state = {
      chatRunId: null,
      connected: true,
      connectionEpoch: 1,
      client: { request },
      chatLoading: false,
      chatModelCatalog: [],
      chatModelCatalogError: null,
      sessions: { state: { modelOverrides: {} }, patch: vi.fn() },
      chatModelSwitchPromises: {},
      sessionKey: "main",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: undefined,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      toastAnchor: document.createElement("div"),
      onModelSetup: vi.fn(),
    });
    render(controls.composerControls, container);

    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    picker!.open = true;
    picker!.dispatchEvent(new Event("toggle"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "main",
      refresh: true,
    });
  });
});
