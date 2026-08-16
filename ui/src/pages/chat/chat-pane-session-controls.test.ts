/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat pane composer controls", () => {
  it("renders model and permission controls", () => {
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

    render(
      renderChatPaneComposerControls({
        state,
        selectedSession: undefined,
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" },
        effortAccess: { allowed: true, requiredScope: "operator.write" },
        permissionAccess: { allowed: true, requiredScope: "operator.write" },
        canSelectFull: true,
        onModelSetup,
      }),
      container,
    );

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-composer-model-control",
    ]);
    expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
    expect(container.querySelector('[data-chat-permission-select="true"]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("patches a keyboard-selected mode and locks full access without admin scope", async () => {
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

    render(
      renderChatPaneComposerControls({
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
        onModelSetup: vi.fn(),
      }),
      container,
    );

    const details = container.querySelector<HTMLDetailsElement>(
      ".chat-controls__permission-picker",
    );
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    const full = container.querySelector<HTMLButtonElement>('[data-chat-permission-option="full"]');
    expect(full?.disabled).toBe(true);
    expect(full?.getAttribute("aria-selected")).toBe("true");
    expect(full?.querySelector(".chat-controls__inline-select-check")).not.toBeNull();
    const listbox = container.querySelector<HTMLElement>("[data-chat-permission-list]");
    expect(listbox?.id).not.toBe("");
    expect(full?.id).not.toBe("");
    expect(listbox?.getAttribute("aria-activedescendant")).toBe(
      container.querySelector<HTMLElement>("[data-chat-permission-highlighted]")?.id,
    );
    expect(
      container
        .querySelector<HTMLElement>("[data-chat-permission-select]")
        ?.getAttribute("aria-controls"),
    ).toBe(listbox?.id);
    expect(full?.getAttribute("aria-label")).toContain("operator.admin");

    details!.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenCalledWith(
      "agent:main:permission-test",
      { permissionMode: "guarded" },
      {},
    );
    expect(details?.open).toBe(false);

    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));
    details!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(details?.open).toBe(false);
  });
});
