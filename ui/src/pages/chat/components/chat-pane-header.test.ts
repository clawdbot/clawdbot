/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type {
  NativeGatewaysCapability,
  NativeGatewaysSnapshot,
} from "../../../app/native-gateways.runtime.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneParentSession,
  resolveChatPaneWorkspace,
} from "./chat-pane-header.ts";

type ChatPaneHeaderProps = Parameters<typeof renderChatPaneHeader>[0];

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
});

function nativeGateways(snapshot: NativeGatewaysSnapshot): NativeGatewaysCapability {
  return {
    snapshot,
    subscribe: () => () => undefined,
    select: vi.fn(),
    openWindow: vi.fn(),
    setPrimary: vi.fn(),
    openSettings: vi.fn(),
  };
}

const gatewaySnapshot: NativeGatewaysSnapshot = {
  gateways: [
    {
      id: "primary",
      name: "Local Gateway",
      kind: "local",
      isPrimary: true,
      canPromote: false,
      health: "ok",
    },
    {
      id: "profile:studio",
      name: "Studio",
      kind: "remote",
      isPrimary: false,
      canPromote: true,
      health: "unknown",
    },
  ],
  currentId: "primary",
};

function row(patch: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: "agent:main:test", kind: "direct", updatedAt: 0, ...patch };
}

function mount(patch: Partial<ChatPaneHeaderProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const props: ChatPaneHeaderProps = {
    paneId: "pane-1",
    narrow: false,
    mergedChrome: false,
    title: "Session title",
    session: row(),
    catalog: false,
    editing: false,
    renameValue: "Session title",
    workspaceRoot: "/repo/openclaw",
    workspaceLabel: "openclaw",
    workspaceIcon: null,
    parentSession: null,
    branch: "feature/header",
    branches: [],
    branchSwitchDisabledReason: null,
    platform: "darwin",
    canReveal: true,
    copiedAction: null,
    renameDisabledReason: undefined,
    panelActions: nothing,
    discussionAction: nothing,
    diffAction: nothing,
    backgroundTasksAction: nothing,
    workspaceAction: nothing,
    sessionRailAction: nothing,
    sessionMenuAction: nothing,
    onBeginRename: vi.fn(),
    onRenameInput: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onMenuOpenChange: vi.fn(),
    onMenuAction: vi.fn(),
    onOpenParentSession: vi.fn(),
    onBranchSelect: vi.fn(),
    ...patch,
  };
  props.gatewaysSnapshot ??= props.nativeGateways?.snapshot;
  render(html`${renderChatPaneHeader(props)}`, container);
  return { container, props };
}

describe("chat pane header", () => {
  it("hides the gateway picker without capability and with one gateway", () => {
    Object.assign(window, { __OPENCLAW_NATIVE_WEB_CHROME__: true });
    expect(mount().container.querySelector(".chat-pane__gateway-menu")).toBeNull();
    const one = nativeGateways({ gateways: [gatewaySnapshot.gateways[0]!], currentId: "primary" });
    expect(
      mount({ nativeGateways: one }).container.querySelector(".chat-pane__gateway-menu"),
    ).toBeNull();
  });

  it("renders gateway rows, primary tag, and current checkmark", () => {
    Object.assign(window, { __OPENCLAW_NATIVE_WEB_CHROME__: true });
    const { container } = mount({ nativeGateways: nativeGateways(gatewaySnapshot) });
    const rows = container.querySelectorAll(".chat-pane__gateway-item");
    expect(rows).toHaveLength(2);
    expect(container.querySelectorAll(".chat-pane__gateway-menu-item")).toHaveLength(4);
    expect(rows[0]?.textContent).toContain("Local Gateway");
    expect(rows[0]?.textContent).toContain("primary");
    expect(rows[0]?.querySelector(".chat-pane__gateway-check")).not.toBeNull();
  });

  it("selects normally and opens a new window on alt-click", () => {
    Object.assign(window, { __OPENCLAW_NATIVE_WEB_CHROME__: true });
    const select = vi.fn();
    const openWindow = vi.fn();
    const capability = { ...nativeGateways(gatewaySnapshot), select, openWindow };
    const first = mount({ nativeGateways: capability }).container.querySelectorAll(
      ".chat-pane__gateway-item",
    )[1];
    first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(select).toHaveBeenCalledWith("profile:studio");
    const second = mount({ nativeGateways: capability }).container.querySelectorAll(
      ".chat-pane__gateway-item",
    )[1];
    second?.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    expect(openWindow).toHaveBeenCalledWith("profile:studio");
  });

  it("opens a new window when alt-clicking the current gateway", () => {
    Object.assign(window, { __OPENCLAW_NATIVE_WEB_CHROME__: true });
    const select = vi.fn();
    const openWindow = vi.fn();
    const capability = { ...nativeGateways(gatewaySnapshot), select, openWindow };
    const current = mount({ nativeGateways: capability }).container.querySelector(
      ".chat-pane__gateway-item",
    );
    current?.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    expect(openWindow).toHaveBeenCalledWith("primary");
    expect(select).not.toHaveBeenCalled();
  });

  it("re-renders gateway rows from a changed snapshot property", () => {
    Object.assign(window, { __OPENCLAW_NATIVE_WEB_CHROME__: true });
    let current = gatewaySnapshot;
    const capability = {
      ...nativeGateways(gatewaySnapshot),
      get snapshot() {
        return current;
      },
    };
    const mounted = mount({ nativeGateways: capability, gatewaysSnapshot: current });
    const next = {
      ...gatewaySnapshot,
      gateways: [
        ...gatewaySnapshot.gateways,
        {
          id: "profile:backup",
          name: "Backup",
          kind: "remote" as const,
          isPrimary: false,
          canPromote: true,
          health: "unknown" as const,
        },
      ],
    };
    current = next;
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", { detail: next }));

    const props = { ...mounted.props, gatewaysSnapshot: capability.snapshot };
    render(html`${renderChatPaneHeader(props)}`, mounted.container);

    expect(mounted.container.querySelectorAll(".chat-pane__gateway-item")).toHaveLength(3);
    expect(mounted.container.textContent).toContain("Backup");
  });

  it("disables set-primary when the viewed gateway cannot be promoted", () => {
    Object.assign(window, { __OPENCLAW_NATIVE_WEB_CHROME__: true });
    const snapshot = {
      ...gatewaySnapshot,
      gateways: gatewaySnapshot.gateways.map((gateway) =>
        Object.assign({}, gateway, { canPromote: false }),
      ),
      currentId: "profile:studio",
    };
    const { container } = mount({ nativeGateways: nativeGateways(snapshot) });
    const item = Array.from(container.querySelectorAll("wa-dropdown-item")).find((candidate) =>
      candidate.textContent?.includes("Set as primary"),
    );
    expect(item?.hasAttribute("disabled")).toBe(true);
  });

  it("renders and dispatches merged chrome actions for catalog sessions", () => {
    const drawerEvents: CustomEvent<ShellNavDrawerToggleDetail>[] = [];
    const paletteEvents: Event[] = [];
    const onDrawer = (event: Event) =>
      drawerEvents.push(event as CustomEvent<ShellNavDrawerToggleDetail>);
    const onPalette = (event: Event) => paletteEvents.push(event);
    window.addEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onPalette);
    const { container } = mount({ mergedChrome: true, catalog: true, session: undefined });
    const drawer = container.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]');
    const palette = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open command palette"]',
    );

    drawer?.click();
    palette?.click();

    expect(drawer).not.toBeNull();
    expect(palette).not.toBeNull();
    expect(drawerEvents).toHaveLength(1);
    expect(drawerEvents[0]?.detail.trigger).toBe(drawer);
    expect(paletteEvents).toHaveLength(1);
    window.removeEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
    window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onPalette);
  });

  it("omits shell chrome actions when the header is not merged", () => {
    const { container } = mount();
    expect(container.querySelector(".chat-pane__nav-toggle")).toBeNull();
    expect(container.querySelector(".chat-pane__palette-open")).toBeNull();
  });

  it("places the session menu last in the header action row", () => {
    const { container } = mount({
      mergedChrome: true,
      onClosePane: vi.fn(),
      sessionMenuAction: html`<button data-action="session-menu"></button>`,
    });
    const actions = container.querySelector(".chat-pane__actions");

    expect(actions?.lastElementChild?.getAttribute("data-action")).toBe("session-menu");
    expect(actions?.querySelector(".chat-pane__palette-open")).not.toBeNull();
    expect(actions?.querySelector(".chat-pane__close-pane")).not.toBeNull();
  });

  it("moves session panel shortcuts out of a narrow header while keeping shell actions", () => {
    const { container } = mount({
      narrow: true,
      mergedChrome: true,
      panelActions: html`<button data-action="terminal"></button>`,
      discussionAction: html`<button data-action="discussion"></button>`,
      diffAction: html`<button data-action="diff"></button>`,
      backgroundTasksAction: html`<button data-action="tasks"></button>`,
      workspaceAction: html`<button data-action="workspace"></button>`,
      sessionRailAction: html`<button data-action="rail"></button>`,
      sessionMenuAction: html`<button data-action="session-menu"></button>`,
    });

    expect(container.querySelector('[data-action="terminal"]')).toBeNull();
    expect(container.querySelector('[data-action="discussion"]')).toBeNull();
    expect(container.querySelector('[data-action="diff"]')).toBeNull();
    expect(container.querySelector('[data-action="tasks"]')).toBeNull();
    expect(container.querySelector('[data-action="workspace"]')).toBeNull();
    expect(container.querySelector('[data-action="rail"]')).toBeNull();
    expect(container.querySelector('[data-action="session-menu"]')).not.toBeNull();
    expect(container.querySelector(".chat-pane__nav-toggle")).not.toBeNull();
    expect(container.querySelector(".chat-pane__palette-open")).not.toBeNull();
  });

  it("keeps narrow catalog panel shortcuts visible without a session menu", () => {
    const { container } = mount({
      narrow: true,
      catalog: true,
      session: undefined,
      panelActions: html`<button data-action="terminal"></button>`,
    });

    expect(container.querySelector('[data-action="terminal"]')).not.toBeNull();
  });

  it("renders an editable title and workspace chip", () => {
    const { container, props } = mount();
    const title = container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button");
    const chip = container.querySelector<HTMLButtonElement>(".chat-pane__workspace-chip");
    expect(title?.textContent?.trim()).toBe("Session title");
    expect(chip?.textContent?.trim()).toContain("openclaw");
    title?.click();
    expect(props.onBeginRename).toHaveBeenCalledOnce();
  });

  it("renders a quiet cloud placement chip with the canonical stop action", () => {
    const onPlacementReclaim = vi.fn();
    const { container } = mount({
      session: row({
        placement: {
          state: "active",
          generation: 1,
          createdAtMs: 100_000,
          updatedAtMs: 300_000,
          stateChangedAtMs: 300_000,
          environmentId: "worker:one",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "base-manifest",
          remoteWorkspaceDir: "/worker/repo",
        },
      }),
      onPlacementReclaim,
    });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Runs on Cloud",
    );
    expect(container.querySelector(".chat-pane__placement-state")).toBeNull();
    expect(container.querySelector(".chat-pane__placement-note")).toBeNull();
    const actions = container.querySelectorAll(".chat-pane__placement-menu wa-dropdown-item");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent?.trim()).toBe("Stop cloud worker…");
    expect(actions[0]?.classList.contains("session-menu__item--destructive")).toBe(true);
    expect(actions[0]?.getAttribute("variant")).toBe("danger");
    expect(actions[0]?.querySelector(".session-menu__icon")).not.toBeNull();
    actions[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPlacementReclaim).toHaveBeenCalledOnce();
  });

  it.each(["local", "reclaimed"] as const)("hides the placement chip for %s state", (state) => {
    const { container } = mount({
      session: row({
        placement: {
          state,
          generation: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
          stateChangedAtMs: 1,
        },
      }),
    });
    expect(container.querySelector(".chat-pane__placement-chip")).toBeNull();
  });

  it("places pane presence between the identity trail and face control", () => {
    const { container } = mount({
      presence: html`<span data-slot="presence"></span>`,
      faceControl: html`<span data-slot="face"></span>`,
    });
    const crumbs = container.querySelector(".chat-pane__crumbs");
    expect(crumbs?.nextElementSibling?.getAttribute("data-slot")).toBe("presence");
    expect(crumbs?.nextElementSibling?.nextElementSibling?.getAttribute("data-slot")).toBe("face");
  });

  it("leads with the project, then a separator, then the session title", () => {
    const { container } = mount();
    const crumbs = container.querySelector(".chat-pane__crumbs");
    const segments = [...(crumbs?.children ?? [])].map((child) => child.className);
    expect(segments).toEqual([
      "chat-pane__workspace-menu",
      "chat-pane__crumb-sep",
      "chat-pane__session-title chat-pane__session-title-button",
    ]);
    expect(crumbs?.querySelector(".chat-pane__crumb-sep")?.textContent).toBe("/");
    expect(crumbs?.querySelector(".chat-pane__crumb-sep")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("places a clickable parent between the project and child session", () => {
    const parentSession = { key: "agent:main:parent", title: "Release prep" };
    const { container, props } = mount({ parentSession });
    const crumbs = container.querySelector(".chat-pane__crumbs");

    expect([...(crumbs?.children ?? [])].map((child) => child.className)).toEqual([
      "chat-pane__workspace-menu",
      "chat-pane__crumb-sep",
      "chat-pane__parent-session",
      "chat-pane__crumb-sep",
      "chat-pane__session-title chat-pane__session-title-button",
    ]);
    const parent = crumbs?.querySelector<HTMLButtonElement>(".chat-pane__parent-session");
    expect(parent?.textContent?.trim()).toBe("Release prep");
    parent?.click();
    expect(props.onOpenParentSession).toHaveBeenCalledExactlyOnceWith("agent:main:parent");
  });

  it("drops the separator when the session has no project segment", () => {
    const { container } = mount({ workspaceLabel: null, workspaceRoot: null });
    expect(container.querySelector(".chat-pane__crumb-sep")).toBeNull();
    expect(container.querySelector(".chat-pane__crumbs")?.firstElementChild?.className).toContain(
      "chat-pane__session-title",
    );
  });

  it("keeps the rename input inside the trail so the project stays visible", () => {
    const { container } = mount({ editing: true, renameValue: "Renaming" });
    const crumbs = container.querySelector(".chat-pane__crumbs");
    expect(crumbs?.querySelector(".chat-pane__workspace-chip")).not.toBeNull();
    expect(crumbs?.querySelector<HTMLInputElement>(".chat-pane__session-title-input")?.value).toBe(
      "Renaming",
    );
  });

  it("renders the permanent owner chip only when attribution chrome is enabled", () => {
    const shown = mount({
      showOwnerChip: true,
      session: row({ createdActor: { type: "human", id: "profile-ada", label: "Ada" } }),
    });
    expect(shown.container.querySelector("openclaw-session-owner-chip")).not.toBeNull();

    const dormant = mount({
      showOwnerChip: false,
      session: row({ createdActor: { type: "human", id: "profile-ada", label: "Ada" } }),
    });
    expect(dormant.container.querySelector("openclaw-session-owner-chip")).toBeNull();
  });

  it("renders the durable session actor avatar with the header attribution semantics", async () => {
    const mounted = mount({
      showOwnerChip: true,
      session: row({
        createdActor: {
          type: "human",
          id: "profile-ada",
          label: "Ada",
          avatarUrl: "/api/users/profile-ada/avatar?v=7",
        },
      }),
    });

    await vi.waitFor(() => {
      expect(mounted.container.querySelector("openclaw-session-owner-chip img")).not.toBeNull();
    });
    const chip = mounted.container.querySelector(".session-owner-chip--header");
    expect(chip?.getAttribute("aria-label")).toBe("Created by Ada");
    expect(chip?.getAttribute("title")).toBe("Created by Ada");
  });

  it("routes Enter and Escape from the rename input", () => {
    const enter = mount({ editing: true, renameValue: "  Updated  " });
    const enterInput = enter.container.querySelector<HTMLInputElement>("input");
    enterInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(enter.props.onCommitRename).toHaveBeenCalledOnce();

    const escape = mount({ editing: true });
    escape.container
      .querySelector("input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(escape.props.onCancelRename).toHaveBeenCalledOnce();
    expect(escape.props.onCommitRename).not.toHaveBeenCalled();
  });

  it("keeps catalog sessions static and without a workspace chip", () => {
    const { container } = mount({
      catalog: true,
      session: undefined,
      panelActions: html`<span data-action="terminal"></span>`,
      diffAction: html`<span data-action="diff"></span>`,
      backgroundTasksAction: html`<span data-action="tasks"></span>`,
      workspaceAction: html`<span data-action="workspace"></span>`,
      sessionRailAction: html`<span data-action="rail"></span>`,
    });
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(container.querySelector(".chat-pane__session-title")?.textContent).toContain(
      "Session title",
    );
    expect(container.querySelector(".chat-pane__workspace-chip")).toBeNull();
    expect(container.querySelector('[data-action="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-action="diff"]')).toBeNull();
    expect(container.querySelector('[data-action="tasks"]')).toBeNull();
    expect(container.querySelector('[data-action="workspace"]')).toBeNull();
    expect(container.querySelector('[data-action="rail"]')).toBeNull();
  });

  it("keeps read-only gateway session titles static", () => {
    const { container } = mount({ renameDisabledReason: "Operator write access is required." });
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(container.querySelector(".chat-pane__session-title")?.textContent).toContain(
      "Session title",
    );
    expect(container.querySelector(".chat-pane__session-title")?.getAttribute("title")).toBe(
      "Operator write access is required.",
    );
  });

  it("shows copied feedback on the workspace chip", () => {
    const { container } = mount({ copiedAction: "copy-path" });
    expect(container.querySelector(".chat-pane__workspace-chip")?.textContent).toContain("Copied");
  });

  it("shows cloud placement and hides reveal when disabled", () => {
    const { container } = mount({
      session: row({
        placement: { state: "active" } as GatewaySessionRow["placement"],
      }),
      canReveal: false,
    });
    expect(container.querySelector(".chat-pane__placement-chip")).not.toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="reveal"]')).toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="copy-path"]')).not.toBeNull();
  });

  it("shows an incognito indicator for in-memory threads", () => {
    const { container } = mount({ session: row({ incognito: true }) });
    expect(container.querySelector(".chat-pane__incognito")?.getAttribute("aria-label")).toBe(
      "Incognito session",
    );
  });

  it("hides one branch and lists multiple branches with the active tip marked", () => {
    const one = mount({
      branches: [{ leafEntryId: "only", headline: "Only path", messageCount: 1, active: true }],
    });
    expect(one.container.querySelector(".chat-pane__branches-trigger")).toBeNull();

    const multiple = mount({
      branches: [
        { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
        {
          leafEntryId: "other",
          headline: "Earlier idea",
          messageCount: 2,
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
          active: false,
        },
      ],
    });
    const items = multiple.container.querySelectorAll(".chat-pane__branch-item");
    expect(multiple.container.querySelector(".chat-pane__branches-trigger")).not.toBeNull();
    // wa-popup anchors to the first slot="trigger" element; a display:contents
    // wrapper (like openclaw-tooltip) has a zero rect and pins the menu to the
    // window's top-left corner, so the slotted trigger must be the button itself.
    expect(
      multiple.container
        .querySelector('.chat-pane__branches-menu > [slot="trigger"]')
        ?.classList.contains("chat-pane__branches-trigger"),
    ).toBe(true);
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Current work");
    expect(items[0]?.getAttribute("data-active")).toBe("true");
    expect(items[0]?.querySelector(".chat-pane__branch-active")).not.toBeNull();
    expect(items[1]?.textContent).toContain("Earlier idea");

    multiple.container.querySelector(".chat-pane__branches-menu")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "other" } },
      }),
    );
    expect(multiple.props.onBranchSelect).toHaveBeenCalledWith("other");
  });

  it("disables branch switching while the agent is working", () => {
    const { container, props } = mount({
      branchSwitchDisabledReason: "Branch switch is unavailable while the agent is working.",
      branches: [
        { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
        { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
      ],
    });
    const trigger = container.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger");
    expect(trigger?.disabled).toBe(true);
    container.querySelector(".chat-pane__branches-menu")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "other" } },
      }),
    );
    expect(props.onBranchSelect).not.toHaveBeenCalled();
  });
});

describe("chat pane parent resolution", () => {
  it("uses the navigation parent and its canonical display name", () => {
    const parent = row({
      key: "agent:main:parent",
      label: "Release prep",
    });
    const controlOwner = row({
      key: "agent:main:control-owner",
      label: "Coordinator",
    });

    expect(
      resolveChatPaneParentSession(
        row({
          key: "agent:main:child",
          parentSessionKey: parent.key,
          spawnedBy: controlOwner.key,
        }),
        [controlOwner, parent],
      ),
    ).toEqual({ key: parent.key, title: "Release prep" });
  });

  it("omits unresolved and self-referential parents", () => {
    const child = row({ key: "agent:main:child", parentSessionKey: "agent:main:missing" });
    expect(resolveChatPaneParentSession(child, [child])).toBeNull();
    expect(
      resolveChatPaneParentSession({ ...child, parentSessionKey: child.key }, [child]),
    ).toBeNull();
  });
});

describe("chat pane workspace chip icon", () => {
  async function mountChip(workspaceIcon: ChatPaneHeaderProps["workspaceIcon"]) {
    const { container } = mount({ workspaceIcon });
    const element = container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;
    await element?.updateComplete;
    return { container, element };
  }

  it("keeps the folder glyph when the gateway resolved no project icon", async () => {
    const { container, element } = await mountChip(null);
    expect(element).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
  });

  it("keeps the folder glyph while credentials are not ready", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: [],
      authReady: false,
    });
    expect(element).not.toBeNull();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps the folder glyph when the icon route fails", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("workspace icon unavailable"));
    const { container } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
    fetchSpy.mockRestore();
  });

  it("does not refetch a missing project icon when the header rerenders", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 404 } as Response);
    const workspaceIcon = {
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    };
    const mounted = mount({ workspaceIcon });
    const element = mounted.container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await element?.updateComplete;
    render(
      html`${renderChatPaneHeader({ ...mounted.props, title: "Updated title", workspaceIcon })}`,
      mounted.container,
    );
    await element?.updateComplete;
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    render(
      html`${renderChatPaneHeader({
        ...mounted.props,
        workspaceIcon: { ...workspaceIcon, authTokens: ["new-token"] },
      })}`,
      mounted.container,
    );
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    fetchSpy.mockRestore();
  });

  it("retries the next credential when a stale token is rejected", async () => {
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => png,
      } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:workspace-icon");

    await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["stale-token", "session-password"],
      authReady: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer session-password" },
    });
    vi.restoreAllMocks();
  });
});

describe("chat pane workspace resolution", () => {
  it("uses worktree repo vocabulary with spawned cwd", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({
          spawnedCwd: "/tmp/worktrees/title-bar",
          worktree: { id: "wt-1", branch: "title-bar", repoRoot: "/src/openclaw" },
        }),
      }),
    ).toEqual({ root: "/tmp/worktrees/title-bar", label: "openclaw" });
  });

  it("does not substitute the agent workspace for a missing worktree checkout", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({
          worktree: { id: "wt-missing", branch: "feature", repoRoot: "/src/openclaw" },
        }),
        agentWorkspace: "/src/default-agent-workspace",
        worktreePath: null,
      }),
    ).toEqual({ root: null, label: "openclaw" });
  });

  it("matches the gateway root order: spawned workspace before spawned cwd", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({
          spawnedWorkspaceDir: "/src/openclaw",
          spawnedCwd: "/src/openclaw/packages/nested",
        }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
    // execCwd is exec-node routing state; it never overrides local facts.
    expect(
      resolveChatPaneWorkspace({
        session: row({ execCwd: "/remote/stale", spawnedCwd: "/src/openclaw" }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
  });

  it("prefers exec cwd and falls back to the agent workspace", () => {
    expect(
      resolveChatPaneWorkspace({
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        agentWorkspace: "/local/default",
      }),
    ).toEqual({ root: "/remote/build", label: "build" });
    // Without execCwd, gateway-local facts must not stand in for a path that
    // lives on another machine.
    expect(
      resolveChatPaneWorkspace({
        session: row({ execNode: "build-mac", spawnedCwd: "/local/spawned" }),
        agentWorkspace: "/local/default",
        worktreePath: "/local/worktree",
      }),
    ).toEqual({ root: null, label: null });
    expect(resolveChatPaneWorkspace({ session: row(), agentWorkspace: "/src/openclaw" })).toEqual({
      root: "/src/openclaw",
      label: "openclaw",
    });
  });

  it("disables reveal for exec nodes, remote placement, and missing advertisement", () => {
    expect(
      canRevealSessionWorkspace({
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        workspaceRoot: "/remote/build",
        methodAdvertised: true,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
        workspaceRoot: "/cloud/work",
        methodAdvertised: true,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: false,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: true,
        hasAdminAccess: false,
      }),
    ).toBe(false);
  });
});
