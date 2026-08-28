/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { icons } from "../../components/icons.ts";
import {
  renderChatPaneComposerControls,
  resolveChatModelCatalogState,
} from "./chat-pane-session-controls.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatPermissionPicker } from "./components/chat-permission-picker.ts";

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));

vi.mock("../../lib/toast.ts", () => ({ showToast: showToastMock }));

function iconMarkup(icon: unknown): string | undefined {
  const container = document.createElement("div");
  render(icon as never, container);
  return container.querySelector("svg")?.innerHTML;
}

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
      label: "ready with a cached snapshot",
      state: {
        chatModelCatalog: cachedCatalog,
        chatModelCatalogError: null,
        chatModelsLoading: false,
        connected: true,
      },
      expected: { hasSnapshot: true, status: "ready" },
    },
    {
      label: "loading without a cached snapshot",
      state: {
        chatModelCatalog: [],
        chatModelCatalogError: null,
        chatModelsLoading: true,
        connected: true,
      },
      expected: { hasSnapshot: false, status: "loading" },
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
      sessions: { state: { modelOverrides: {} }, think: () => undefined, patch: vi.fn() },
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

  it("renders a distinct active icon for every permission mode", () => {
    const activeIcons = new Set<string>();
    for (const mode of [undefined, "read-only", "guarded", "workspace", "full"] as const) {
      const container = document.createElement("div");
      render(
        renderChatPermissionPicker({
          canSelectFull: true,
          mode,
          onSelect: () => undefined,
        }),
        container,
      );
      const icon = container.querySelector(".chat-controls__permission-icon svg");
      expect(icon).not.toBeNull();
      activeIcons.add(icon?.outerHTML ?? "");
    }
    expect(activeIcons.size).toBe(5);
  });

  it("links the permission picker to the permission modes guide", () => {
    const container = document.createElement("div");
    render(
      renderChatPermissionPicker({
        canSelectFull: true,
        mode: "workspace",
        onSelect: () => undefined,
      }),
      container,
    );

    const docsLink = container.querySelector<HTMLAnchorElement>(
      ".chat-controls__permission-learn-more",
    );
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.href).toBe("https://docs.openclaw.ai/gateway/permission-modes");
    expect(docsLink?.target).toBe("_blank");
    expect(docsLink?.rel.split(/\s+/).toSorted()).toEqual(["noopener", "noreferrer"]);
  });

  it("patches a rootless session, clears to default, and locks full access", async () => {
    const container = document.createElement("div");
    const patch = vi.fn(async () => ({}));
    const state = {
      chatRunId: null,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} }, think: () => undefined, patch },
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
    const permissionIcons = {
      default: icons.shieldCheck,
      "read-only": icons.shieldEllipsis,
      guarded: icons.shieldLock,
      workspace: icons.shieldCog,
      full: icons.shieldAlert,
    };
    for (const [mode, icon] of Object.entries(permissionIcons)) {
      const renderedIcon = container.querySelector<SVGElement>(
        `[data-chat-permission-option="${mode}"] .chat-controls__permission-option-icon svg`,
      );
      expect(renderedIcon?.innerHTML).toBe(iconMarkup(icon));
      expect(renderedIcon?.getAttribute("fill")).toBe("none");
      expect(renderedIcon?.getAttribute("stroke-width")).toBe("2");
    }
    expect(defaultOption?.textContent).toContain("Follow the agent's configured policy");
    expect(full?.hasAttribute("disabled")).toBe(true);
    expect(full?.getAttribute("aria-checked")).toBe("true");
    expect(full?.querySelector(".chat-controls__permission-shortcut")).toBeNull();
    expect(full?.querySelector(".chat-controls__permission-lock")).not.toBeNull();
    expect(full?.querySelector(".chat-controls__inline-select-check")).toBeNull();
    expect(full?.getAttribute("aria-label")).toContain("operator.admin");

    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenCalledWith(
      "agent:main:permission-test",
      { permissionMode: "guarded" },
      expect.objectContaining({ agentId: undefined }),
    );

    dropdown?.setAttribute("open", "");
    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenLastCalledWith(
      "agent:main:permission-test",
      { permissionMode: null },
      expect.objectContaining({ agentId: undefined }),
    );
  });

  it.each([
    { label: "running", chatRunId: null, hasActiveRun: true, status: "running", toastCount: 1 },
    {
      label: "locally running with a stale idle session row",
      chatRunId: "run-active",
      hasActiveRun: false,
      status: "done",
      toastCount: 1,
    },
    { label: "idle", chatRunId: null, hasActiveRun: false, status: "done", toastCount: 0 },
  ] as const)("shows the next-run notice only for a $label session", async (sessionCase) => {
    showToastMock.mockClear();
    const patch = vi.fn(async () => ({}));
    const toastAnchor = document.createElement("div");
    const state = {
      chatRunId: sessionCase.chatRunId,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} }, think: () => undefined, patch },
      chatModelSwitchPromises: {},
      sessionKey: "agent:main:permission-notice",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
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

    await controls.permissionPicker.onSelect("guarded");

    expect(showToastMock).toHaveBeenCalledTimes(sessionCase.toastCount);
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

  it("holds the session send barrier until a Full Access selection settles", async () => {
    const pending = createDeferred<Record<string, never>>();
    const state = {
      chatRunId: null,
      connected: true,
      connectionEpoch: 1,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: {
        state: { modelOverrides: {} },
        think: () => undefined,
        patch: vi.fn(() => pending.promise),
      },
      chatModelSwitchPromises: {},
      sessionKey: "agent:main:remote-worker",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: { key: state.sessionKey, kind: "direct" },
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      toastAnchor: document.createElement("div"),
      onModelSetup: vi.fn(),
    });

    const selection = controls.permissionPicker.onSelect("full");
    expect(getPendingChatPickerPatch(state, state.sessionKey)).toBeDefined();

    pending.resolve({});
    await selection;
    expect(getPendingChatPickerPatch(state, state.sessionKey)).toBeUndefined();
  });

  it.each([
    {
      label: "successful update after switching sessions",
      result: "success",
      invalidate: (state: ChatPageHost) => {
        state.sessionKey = "agent:main:other-session";
      },
    },
    {
      label: "failed update after switching sessions",
      result: "failure",
      invalidate: (state: ChatPageHost) => {
        state.sessionKey = "agent:main:other-session";
      },
    },
    {
      label: "successful global-session update after switching agents",
      result: "success",
      initialSessionKey: "global",
      invalidate: (state: ChatPageHost) => {
        state.assistantAgentId = "research";
      },
    },
    {
      label: "successful update after reconnecting",
      result: "success",
      invalidate: (state: ChatPageHost) => {
        state.connectionEpoch += 1;
      },
    },
    {
      label: "successful update after replacing the Gateway client",
      result: "success",
      invalidate: (state: ChatPageHost) => {
        state.client = {} as ChatPageHost["client"];
      },
    },
    {
      label: "unavailable update after switching sessions",
      result: "null",
      invalidate: (state: ChatPageHost) => {
        state.sessionKey = "agent:main:other-session";
      },
    },
  ] as const)("suppresses alerts for a $label", async (lifecycleCase) => {
    const { invalidate, result } = lifecycleCase;
    showToastMock.mockClear();
    const pending = createDeferred<Record<string, never> | null>();
    const state = {
      assistantAgentId: "main",
      chatRunId: "remote-worker-run",
      chatError: null,
      connected: true,
      connectionEpoch: 1,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: {
        state: { modelOverrides: {} },
        think: () => undefined,
        patch: vi.fn(() => pending.promise),
      },
      chatModelSwitchPromises: {},
      sessionKey:
        "initialSessionKey" in lifecycleCase
          ? lifecycleCase.initialSessionKey
          : "agent:main:remote-worker",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: { key: state.sessionKey, kind: "direct", hasActiveRun: true },
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      toastAnchor: document.createElement("div"),
      onModelSetup: vi.fn(),
    });

    const selection = controls.permissionPicker.onSelect("full");
    invalidate(state);
    if (result === "failure") {
      pending.reject(new Error("original remote worker disconnected"));
    } else {
      pending.resolve(result === "null" ? null : {});
    }
    await selection;

    expect(showToastMock).not.toHaveBeenCalled();
    expect(state.chatError).toBeNull();
  });

  it("reports an unavailable permission update on the current session", async () => {
    showToastMock.mockClear();
    const state = {
      chatRunId: "remote-worker-run",
      chatError: null,
      connected: true,
      connectionEpoch: 1,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: {
        state: { modelOverrides: {} },
        think: () => undefined,
        patch: vi.fn(async () => null),
      },
      chatModelSwitchPromises: {},
      sessionKey: "agent:main:remote-worker",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: { key: state.sessionKey, kind: "direct", hasActiveRun: true },
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      toastAnchor: document.createElement("div"),
      onModelSetup: vi.fn(),
    });

    await controls.permissionPicker.onSelect("full");

    expect(showToastMock).not.toHaveBeenCalled();
    expect(state.chatError).toContain("Failed to update permissions");
    expect(state.requestUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "warm",
      cachedModels: [{ id: "cached-model", name: "Cached Model", provider: "openai" }],
    },
    { label: "cold", cachedModels: [] },
  ])(
    "revalidates the $label configured model catalog when the picker opens",
    async ({ cachedModels }) => {
      const container = document.createElement("div");
      const catalog = createDeferred<{ models: typeof cachedModels }>();
      const request = vi.fn(() => catalog.promise);
      const state = {
        chatRunId: null,
        connected: true,
        connectionEpoch: 1,
        client: { request },
        chatLoading: false,
        chatModelCatalog: cachedModels,
        chatModelCatalogError: null,
        sessions: {
          state: { modelOverrides: {} },
          think: () => undefined,
          patch: vi.fn(),
          refresh: vi.fn().mockResolvedValue(undefined),
        },
        chatModelSwitchPromises: {},
        sessionKey: "main",
        chatModelsLoading: false,
        chatSending: false,
        sessionsResult: null,
        chatStream: null,
        requestUpdate: vi.fn(),
      } as unknown as ChatPageHost;
      const controlParams = {
        state,
        selectedSession: undefined,
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" } as const,
        effortAccess: { allowed: true, requiredScope: "operator.write" } as const,
        permissionAccess: { allowed: true, requiredScope: "operator.write" } as const,
        canSelectFull: true,
        toastAnchor: document.createElement("div"),
        onModelSetup: vi.fn(),
      };
      render(renderChatPaneComposerControls(controlParams).composerControls, container);

      const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
      picker!.open = true;
      picker!.dispatchEvent(new Event("toggle"));

      expect(state.chatModelPickerOpenSessionKey).toBe("main");
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith("models.list", {
        view: "configured",
        agentId: "main",
        refresh: true,
      });
      expect(state.chatModelsLoading).toBe(cachedModels.length === 0);
      render(renderChatPaneComposerControls(controlParams).composerControls, container);
      if (cachedModels.length > 0) {
        expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
        expect(
          container.querySelector<HTMLButtonElement>("[data-chat-model-option]")?.disabled,
        ).toBe(false);
        expect(container.textContent).toContain("Cached Model");
      } else {
        expect(container.querySelector('[data-chat-model-catalog-state="loading"]')).not.toBeNull();
        expect(container.textContent).toContain("Loading models…");
      }
      const freshModels = [{ id: "fresh-model", name: "Fresh Model", provider: "openai" }];
      catalog.resolve({ models: freshModels });
      await vi.waitFor(() => expect(state.chatModelCatalog).toEqual(freshModels));
    },
  );
});
