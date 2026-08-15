/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderSessionsHubTabs } from "./sessions-hub-tabs.ts";

type SessionsHubTabsProps = Parameters<typeof renderSessionsHubTabs>[0];

async function mount(props: SessionsHubTabsProps): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderSessionsHubTabs(props), container);
  const group = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "wa-tab-group",
  );
  await group?.updateComplete;
  return container;
}

describe("renderSessionsHubTabs", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the route hub with manual activation and a shared panel target", async () => {
    const container = await mount({ active: "worktrees", onSelect: () => undefined });
    const group = container.querySelector("wa-tab-group");
    const tabs = [...container.querySelectorAll<HTMLElement>("wa-tab")];

    expect(group?.getAttribute("activation")).toBe("manual");
    expect(tabs.map((tab) => tab.id)).toEqual(["sessions-tab-sessions", "sessions-tab-worktrees"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual([
      "sessions-hub-panel",
      "sessions-hub-panel",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  it("delegates cross-route selection", async () => {
    const onSelect = vi.fn();
    const container = await mount({ active: "sessions", onSelect });

    container
      .querySelector("#sessions-tab-worktrees")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

    expect(onSelect).toHaveBeenLastCalledWith("worktrees");
  });

  it("ignores setup-time tab-show events", async () => {
    const onSelect = vi.fn();
    const container = await mount({ active: "sessions", onSelect });
    container.querySelector("wa-tab-group")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        bubbles: true,
        composed: true,
        detail: { name: "worktrees" },
      }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hands focus to the destination strip after keyboard navigation", async () => {
    const source = await mount({ active: "sessions", onSelect: () => undefined });
    source
      .querySelector<HTMLElement>("#sessions-tab-worktrees")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    source.remove();

    const destination = await mount({ active: "worktrees", onSelect: () => undefined });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        destination.querySelector<HTMLElement>("#sessions-tab-worktrees"),
      );
    });
  });

  it("does not steal deliberate focus established before a queued route handoff", async () => {
    const source = await mount({ active: "sessions", onSelect: () => undefined });
    source
      .querySelector<HTMLElement>("#sessions-tab-worktrees")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    source.remove();

    await mount({ active: "worktrees", onSelect: () => undefined });
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    expect(document.activeElement).toBe(outside);
  });

  it("does not steal deliberate focus established before the destination mounts", async () => {
    const source = await mount({ active: "sessions", onSelect: () => undefined });
    const sourceTab = source.querySelector<HTMLElement>("#sessions-tab-worktrees");
    sourceTab?.focus();
    sourceTab?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
    );
    source.remove();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await mount({ active: "worktrees", onSelect: () => undefined });
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    expect(document.activeElement).toBe(outside);
  });

  it("keeps only the latest cross-route keyboard focus handoff", async () => {
    const first = await mount({ active: "sessions", onSelect: () => undefined });
    first
      .querySelector<HTMLElement>("#sessions-tab-worktrees")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    first.remove();
    const intermediate = await mount({ active: "worktrees", onSelect: () => undefined });
    intermediate
      .querySelector<HTMLElement>("#sessions-tab-sessions")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    intermediate.remove();
    const destination = await mount({ active: "sessions", onSelect: () => undefined });

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        destination.querySelector<HTMLElement>("#sessions-tab-sessions"),
      ),
    );
  });
});
