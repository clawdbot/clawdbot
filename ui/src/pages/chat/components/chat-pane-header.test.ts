/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { GatewaySessionRow, PresenceEntry, SessionsListResult } from "../../../api/types.ts";
import type {
  NativeGatewaysCapability,
  NativeGatewaysSnapshot,
} from "../../../app/native-gateways.runtime.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import type { SessionCapability } from "../../../lib/sessions/index.ts";
import { createTestChatPane } from "../chat-pane.test-support.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import { createBackgroundTasksProps } from "./chat-background-tasks.ts";
import { renderChatPaneHeader, resolveChatPaneParentSession } from "./chat-pane-header.ts";
import { createSessionWorkspaceProps } from "./chat-session-workspace.ts";

type ChatPaneHeaderProps = Parameters<typeof renderChatPaneHeader>[0];

const containers: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
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
    workspaceIconAvailability: false,
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

function mountIntegratedPresenceHeader(params: {
  owners: NonNullable<SessionsListResult["owners"]>;
  presence: PresenceEntry[];
}) {
  const client = { instanceId: "self-instance" } as unknown as GatewayBrowserClient;
  const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
  const session = row({
    key: state.sessionKey,
    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
    owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
  });
  state.settings = {} as ChatPageHost["settings"];
  state.sessionsResult = {
    ts: 1,
    path: "",
    count: 1,
    owners: params.owners,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [session],
  };
  pane.context.gateway.snapshot.selfUser = { id: "profile-self" };
  pane.presencePayload = { presence: params.presence };
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const renderHeader = () =>
    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        session,
        false,
        undefined,
        false,
      ),
      container,
    );
  renderHeader();
  return { container, pane, renderHeader };
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

  it("groups session controls with the identity trail", () => {
    const { container } = mount({
      mergedChrome: true,
      onClosePane: vi.fn(),
      sessionMenuAction: html`<button data-action="session-menu"></button>`,
      sharingControl: html`<button data-action="sharing"></button>`,
      presence: html`<span data-slot="presence"></span>`,
    });
    const controls = container.querySelector(".chat-pane__session-controls");
    const identity = container.querySelector(".chat-pane__session-identity");
    const actions = container.querySelector(".chat-pane__actions");

    expect(identity?.querySelector('[data-action="session-menu"]')).not.toBeNull();
    expect(controls?.querySelectorAll("[data-action], [data-slot]")).toHaveLength(2);
    expect(actions?.querySelector('[data-action="session-menu"]')).toBeNull();
    expect(actions?.querySelector(".chat-pane__palette-open")).not.toBeNull();
    expect(actions?.querySelector(".chat-pane__close-pane")).not.toBeNull();
  });

  it("omits people controls when the session menu is the only identity action", () => {
    const { container } = mount({ sessionMenuAction: html`<button></button>` });
    expect(container.querySelector(".chat-pane__session-controls")).toBeNull();
  });

  it("uses the app tooltip for the header owner without a native title", async () => {
    const { container } = mount({
      showOwnerChip: true,
      ownerViewing: true,
      session: row({
        owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
      }),
    });
    const ownerChip = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-session-owner-chip",
    );
    await ownerChip?.updateComplete;
    const owner = ownerChip?.querySelector<HTMLElement>(".session-owner-chip");

    expect(owner?.hasAttribute("title")).toBe(false);
    expect(
      (owner?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
    ).toBe("Created by Ada");
    expect(owner?.getAttribute("aria-label")).toContain("viewing now");
  });

  it("moves narrow session actions into the compact menu", () => {
    const { container } = mount({
      narrow: true,
      mergedChrome: true,
      panelActions: html`<button data-action="persistent-surface"></button>`,
      discussionAction: html`<button data-action="discussion"></button>`,
      diffAction: html`<button data-action="diff"></button>`,
      backgroundTasksAction: html`<button data-action="tasks"></button>`,
      workspaceAction: html`<button data-action="workspace"></button>`,
      sessionRailAction: html`<button data-action="rail"></button>`,
      sessionMenuAction: html`<button data-action="session-menu"></button>`,
      onOpenSplitView: vi.fn(),
    });

    expect(container.querySelector('[data-action="persistent-surface"]')).toBeNull();
    expect(container.querySelector('[data-action="discussion"]')).toBeNull();
    expect(container.querySelector('[data-action="diff"]')).toBeNull();
    expect(container.querySelector('[data-action="tasks"]')).toBeNull();
    expect(container.querySelector('[data-action="workspace"]')).toBeNull();
    expect(container.querySelector('[data-action="rail"]')).toBeNull();
    expect(container.querySelector('[data-action="session-menu"]')).not.toBeNull();
    expect(container.querySelector(".chat-pane__nav-toggle")).not.toBeNull();
    expect(container.querySelector(".chat-pane__palette-open")).toBeNull();
    expect(container.querySelector(".chat-open-split-view")).toBeNull();
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

  it("renders a quiet cloud placement chip with move and stop actions", () => {
    const onPlacementMove = vi.fn();
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
      onPlacementMove,
      onPlacementReclaim,
    });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Runs on Cloud",
    );
    expect(container.querySelector(".chat-pane__placement-state")).toBeNull();
    expect(container.querySelector(".chat-pane__placement-note")).toBeNull();
    const actions = container.querySelectorAll(".chat-pane__placement-menu wa-dropdown-item");
    expect(actions).toHaveLength(2);
    expect(actions[0]?.textContent?.trim()).toBe("Move session…");
    expect(actions[0]?.classList.contains("session-menu__item--destructive")).toBe(false);
    actions[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPlacementMove).toHaveBeenCalledOnce();
    expect(actions[1]?.textContent?.trim()).toBe("Stop cloud worker…");
    expect(actions[1]?.classList.contains("session-menu__item--destructive")).toBe(true);
    expect(actions[1]?.getAttribute("variant")).toBe("danger");
    expect(actions[1]?.querySelector(".session-menu__icon")).not.toBeNull();
    actions[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPlacementReclaim).toHaveBeenCalledOnce();
  });

  it("shows durable move progress in the placement chip", () => {
    const session = row({
      placement: {
        state: "draining",
        generation: 2,
        createdAtMs: 100_000,
        updatedAtMs: 300_000,
        stateChangedAtMs: 300_000,
        environmentId: "worker:one",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/repo",
      },
      placementMove: {
        target: { kind: "gateway" },
        updatedAtMs: 300_000,
      },
    });
    const { container } = mount({ session });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Moving to Gateway…",
    );
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

  it("keeps pane presence inside the identity trail", () => {
    const { container } = mount({
      presence: html`<span data-slot="presence"></span>`,
      faceControl: html`<span data-slot="face"></span>`,
    });
    const crumbs = container.querySelector(".chat-pane__crumbs");
    expect(crumbs?.querySelector('[data-slot="presence"]')).not.toBeNull();
    expect(crumbs?.nextElementSibling?.getAttribute("data-slot")).toBe("face");
  });

  it("leads with the project, then a separator, then the session title", () => {
    const { container } = mount();
    const crumbs = container.querySelector(".chat-pane__crumbs");
    const segments = [...(crumbs?.children ?? [])].map((child) => child.className);
    expect(segments).toEqual([
      "chat-pane__workspace-menu",
      "chat-pane__crumb-sep",
      "chat-pane__session-identity",
    ]);
    expect(crumbs?.querySelector(".chat-pane__crumb-sep")?.textContent).toBe("/");
    expect(crumbs?.querySelector(".chat-pane__crumb-sep")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(crumbs?.querySelector(".chat-pane__workspace-chip")?.textContent?.trim()).toBe(
      "openclaw",
    );
  });

  it("uses a custom project icon without repeating the project name or slash", () => {
    const { container } = mount({
      workspaceIconAvailability: true,
      workspaceIcon: {
        routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Atest",
        authTokens: [],
        authReady: false,
      },
    });
    const crumbs = container.querySelector(".chat-pane__crumbs");

    expect([...(crumbs?.children ?? [])].map((child) => child.className)).toEqual([
      "chat-pane__workspace-menu",
      "chat-pane__session-identity",
    ]);
    expect(crumbs?.querySelector(".chat-pane__crumb-sep")).toBeNull();
    expect(crumbs?.querySelector("openclaw-workspace-icon")).not.toBeNull();
    expect(crumbs?.querySelector(".chat-pane__workspace-chip")?.textContent?.trim()).toBe("");
    expect(crumbs?.querySelector(".chat-pane__session-title-text")?.textContent).toBe(
      "Session title",
    );
  });

  it("keeps an unresolved project icon neutral without painting the fallback label", () => {
    const { container } = mount({
      workspaceIconAvailability: null,
      workspaceIcon: {
        routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Atest",
        authTokens: [],
        authReady: false,
      },
    });
    const crumbs = container.querySelector(".chat-pane__crumbs");

    expect([...(crumbs?.children ?? [])].map((child) => child.className)).toEqual([
      "chat-pane__workspace-menu",
      "chat-pane__session-identity",
    ]);
    expect(crumbs?.querySelector(".chat-pane__crumb-sep")).toBeNull();
    expect(crumbs?.querySelector(".chat-pane__workspace-chip")?.textContent?.trim()).toBe("");
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
      "chat-pane__session-identity",
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
      "chat-pane__session-identity",
    );
  });

  it("holds the title's position and height through a rename", () => {
    const rest = mount();
    const editing = mount({ editing: true, renameValue: "Session title" });
    const restIdentity = rest.container.querySelector(".chat-pane__session-identity");
    const editIdentity = editing.container.querySelector(".chat-pane__session-identity");

    // Same slot in the same group: renaming replaces the title in place rather
    // than reflowing the trail around a wider control.
    expect(restIdentity?.children).toHaveLength(editIdentity?.children.length ?? -1);
    expect(editIdentity?.lastElementChild?.className).toBe("chat-pane__session-title-input");
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
      session: row({
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
      }),
    });
    expect(shown.container.querySelector("openclaw-session-owner-chip")).not.toBeNull();

    const dormant = mount({
      showOwnerChip: false,
      session: row({ createdActor: { type: "human", id: "profile-ada", label: "Ada" } }),
    });
    expect(dormant.container.querySelector("openclaw-session-owner-chip")).toBeNull();
  });

  it("renders the bounded static participant facepile beside the owner", async () => {
    const mounted = mount({
      showOwnerChip: true,
      session: row({
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
        participants: [
          { type: "human", id: "profile-bob", label: "Bob" },
          { type: "agent", id: "research", label: "Research" },
          { type: "human", id: "profile-carol", label: "Carol" },
          { type: "agent", id: "release", label: "Release" },
        ],
        participantCount: 4,
      }),
    });
    const facepile = mounted.container.querySelector<
      HTMLElement & { updateComplete?: Promise<unknown> }
    >("openclaw-viewer-facepile.chat-pane__participants");
    await facepile?.updateComplete;

    expect(mounted.container.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    expect(
      [...(facepile?.querySelectorAll("[data-viewer-id]") ?? [])].map((avatar) =>
        avatar.getAttribute("data-viewer-id"),
      ),
    ).toEqual(["profile-bob", "research"]);
    expect(facepile?.querySelector(".viewer-avatar--overflow")?.textContent?.trim()).toBe("+2");
    const tooltips = [...(facepile?.querySelectorAll("openclaw-tooltip") ?? [])];
    expect(
      tooltips
        .slice(0, 2)
        .map((tooltip) => (tooltip as HTMLElement & { content?: string }).content),
    ).toEqual(["Bob · Member", "Research · Agent"]);
    const hiddenMemberRows = tooltips[2]?.querySelectorAll(
      ".viewer-facepile__overflow-tooltip-row",
    );
    expect(
      [...(hiddenMemberRows ?? [])].map((memberRow) =>
        memberRow.querySelector(".viewer-facepile__overflow-tooltip-label")?.textContent?.trim(),
      ),
    ).toEqual(["Carol · Member", "Release · Agent"]);
    expect(tooltips[2]?.querySelectorAll('openclaw-viewer-avatar[variant="tooltip"]')).toHaveLength(
      2,
    );
  });

  it.each([
    {
      name: "excludes the owner when the owner chip is shown",
      owners: [
        { type: "human" as const, id: "profile-ada", label: "Ada" },
        { type: "human" as const, id: "profile-zoe", label: "Zoe" },
      ],
      viewers: ["profile-ada", "profile-zoe"],
      expectedChip: true,
      expectedViewers: ["profile-zoe"],
    },
    {
      name: "keeps the owner when the owner chip is hidden",
      owners: [{ type: "human" as const, id: "profile-ada", label: "Ada" }],
      viewers: ["profile-ada", "profile-zoe"],
      expectedChip: false,
      expectedViewers: ["profile-ada", "profile-zoe"],
    },
    {
      name: "omits the facepile when the shown owner is the only viewer",
      owners: [
        { type: "human" as const, id: "profile-ada", label: "Ada" },
        { type: "human" as const, id: "profile-zoe", label: "Zoe" },
      ],
      viewers: ["profile-ada"],
      expectedChip: true,
      expectedViewers: [],
    },
  ])("$name", async ({ owners, viewers, expectedChip, expectedViewers }) => {
    const sessionKey = "agent:main:current";
    const { container } = mountIntegratedPresenceHeader({
      owners,
      presence: viewers.map((id) => ({
        instanceId: `${id}-instance`,
        ts: 1,
        user: { id, name: id },
        watchedSessions: [sessionKey],
      })),
    });
    const ownerChip = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-session-owner-chip",
    );
    const facepile = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-viewer-facepile",
    );

    await Promise.all([ownerChip?.updateComplete, facepile?.updateComplete]);
    expect(ownerChip !== null).toBe(expectedChip);
    expect(
      [...container.querySelectorAll(".viewer-facepile [data-viewer-id]")].map((avatar) =>
        avatar.getAttribute("data-viewer-id"),
      ),
    ).toEqual(expectedViewers);
    expect(facepile !== null).toBe(expectedViewers.length > 0);
  });

  it("keeps the header owner fully visible while reflecting live session presence", async () => {
    const sessionKey = "agent:main:current";
    const owners = [
      { type: "human" as const, id: "profile-ada", label: "Ada" },
      { type: "human" as const, id: "profile-zoe", label: "Zoe" },
    ];
    const guest = {
      instanceId: "profile-zoe-instance",
      ts: 1,
      user: { id: "profile-zoe", name: "Zoe" },
      watchedSessions: [sessionKey],
    } satisfies PresenceEntry;
    const mounted = mountIntegratedPresenceHeader({ owners, presence: [guest] });
    const ownerChip = mounted.container.querySelector<
      HTMLElement & { updateComplete?: Promise<unknown> }
    >("openclaw-session-owner-chip");

    await ownerChip?.updateComplete;
    const ownerAvatar = mounted.container.querySelector<HTMLElement>(".session-owner-chip--header");
    expect(ownerAvatar?.classList).not.toContain("session-owner-chip--away");
    expect(ownerAvatar?.getAttribute("aria-label")).not.toContain("viewing now");
    mounted.pane.presencePayload = {
      presence: [
        {
          instanceId: "profile-ada-instance",
          ts: 1,
          user: { id: "profile-ada", name: "Ada" },
          watchedSessions: [sessionKey],
        },
        guest,
      ],
    };
    mounted.renderHeader();
    await ownerChip?.updateComplete;
    expect(mounted.container.querySelector(".session-owner-chip--header")?.classList).not.toContain(
      "session-owner-chip--away",
    );
    expect(
      mounted.container
        .querySelector<HTMLElement>(".session-owner-chip--header")
        ?.getAttribute("aria-label"),
    ).toContain("viewing now");
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
        owner: {
          actor: {
            type: "human",
            id: "profile-ada",
            label: "Ada",
            avatarUrl: "/api/users/profile-ada/avatar?v=7",
          },
        },
      }),
    });

    await vi.waitFor(() => {
      expect(mounted.container.querySelector("openclaw-session-owner-chip img")).not.toBeNull();
    });
    const chip = mounted.container.querySelector(".session-owner-chip--header");
    expect(chip?.getAttribute("aria-label")).toBe("Created by Ada");
    expect(chip?.hasAttribute("title")).toBe(false);
    expect(
      (chip?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
    ).toBe("Created by Ada");
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
