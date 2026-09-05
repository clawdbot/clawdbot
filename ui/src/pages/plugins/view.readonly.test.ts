/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createPlugin, createProps, createResult, mount } from "./view.test-support.ts";

const blockedReason = "Plugin changes require operator.admin access.";

function actionButton(container: Element, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      (button.getAttribute("aria-label") ?? button.textContent ?? "").includes(label),
    ) ?? null
  );
}

async function expectReasonedBlockedAction(button: HTMLButtonElement | null) {
  const action = expectDefined(button, "reason-blocked action");
  expect(action.disabled).toBe(false);
  expect(action.getAttribute("aria-disabled")).toBe("true");
  const tooltip = expectDefined(
    action.closest("openclaw-tooltip") as
      | (HTMLElement & { content?: string; updateComplete: Promise<unknown> })
      | null,
    "blocked-action tooltip",
  );
  await tooltip.updateComplete;
  expect(tooltip.content).toBe(blockedReason);
  expect(tooltip.hasAttribute("open-on-click")).toBe(true);
  expect(action.getAttribute("aria-describedby")).toBeTruthy();
  action.focus();
  expect(document.activeElement).toBe(action);
}

describe("renderPlugins read-only actions", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps discovery actions reachable without allowing mutations", async () => {
    const onInstall = vi.fn();
    const onSetEnabled = vi.fn();
    const onReload = vi.fn();
    const onUninstall = vi.fn();
    const onAddConnector = vi.fn();
    const available = createPlugin({
      id: "lobster",
      name: "Lobster",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "lobster" },
    });
    const container = mount(
      createProps({
        activeTab: "discover",
        result: createResult([createPlugin({ removable: true }), available]),
        detailPluginId: "workboard",
        canMutate: false,
        mutationBlockedReason: blockedReason,
        onInstall,
        onSetEnabled,
        onReload,
        onUninstall,
        onAddConnector,
      }),
    );

    expect(container.querySelector(".plugins-readonly")).toBeNull();
    const install = container.querySelector<HTMLButtonElement>('[aria-label="Install Lobster"]');
    const installedRow = container.querySelector<HTMLElement>('[data-plugin-id="workboard"]')!;
    const enable = actionButton(installedRow, "Enable");
    const reload = actionButton(installedRow, "Reload");
    const connector = container.querySelector<HTMLElement>('[data-connector-id="github"]')!;
    const connectorAdd = actionButton(connector, "Add");
    const detail = container.querySelector<HTMLElement>(".plugins-detail")!;
    const detailEnable = actionButton(detail, "Enable");
    const detailReload = actionButton(detail, "Reload");
    const detailRemove = actionButton(detail, "Remove");
    for (const action of [
      install,
      enable,
      reload,
      connectorAdd,
      detailEnable,
      detailReload,
      detailRemove,
    ]) {
      await expectReasonedBlockedAction(action);
      action?.click();
    }

    expect(onInstall).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(onUninstall).not.toHaveBeenCalled();
    expect(onAddConnector).not.toHaveBeenCalled();
  });

  it("keeps the MCP Add server action reachable without opening the form", async () => {
    const onMcpFormToggle = vi.fn();
    const container = mount(
      createProps({
        canMutate: false,
        mutationBlockedReason: blockedReason,
        onMcpFormToggle,
      }),
    );
    const addToggle = actionButton(container, "Add server");

    await expectReasonedBlockedAction(addToggle);
    addToggle?.click();
    expect(onMcpFormToggle).not.toHaveBeenCalled();
    expect(container.querySelector(".mcp-server-form")).toBeNull();
  });
});
