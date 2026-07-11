/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { InventoryRemovalRequest } from "../../lib/nodes/index.ts";
import { renderNodes, type NodesProps } from "./view.ts";

function baseProps(overrides: Partial<NodesProps> = {}): NodesProps {
  return {
    loading: false,
    nodes: [],
    presence: [],
    gatewayVersion: null,
    lastError: null,
    devicesLoading: false,
    devicesError: null,
    devicesList: {
      pending: [],
      paired: [],
    },
    canPairDevice: true,
    configForm: null,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    configFormMode: "form",
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
    execApprovalsTarget: "gateway",
    execApprovalsTargetNodeId: null,
    onRefresh: () => undefined,
    onDevicePairSetupOpen: () => undefined,
    onDeviceApprove: () => undefined,
    onDeviceReject: () => undefined,
    onDeviceRotate: () => undefined,
    onDeviceRevoke: () => undefined,
    onNodeApprove: () => undefined,
    onNodeReject: () => undefined,
    onInventoryRemove: () => undefined,
    onInventoryCleanup: () => undefined,
    onLoadConfig: () => undefined,
    onLoadExecApprovals: () => undefined,
    onBindDefault: () => undefined,
    onBindAgent: () => undefined,
    onSaveBindings: () => undefined,
    onExecApprovalsTargetChange: () => undefined,
    onExecApprovalsSelectAgent: () => undefined,
    onExecApprovalsPatch: () => undefined,
    onExecApprovalsRemove: () => undefined,
    onSaveExecApprovals: () => undefined,
    ...overrides,
  };
}

function renderNodesContainer(overrides: Partial<NodesProps>): HTMLDivElement {
  const container = document.createElement("div");
  render(renderNodes(baseProps(overrides)), container);
  return container;
}

function getInventoryCard(container: Element): Element {
  const card = Array.from(container.querySelectorAll(".card")).find(
    (candidate) => candidate.querySelector(".card-title")?.textContent?.trim() === "Devices",
  );
  expect(card).toBeInstanceOf(Element);
  if (!(card instanceof Element)) {
    throw new Error("Expected inventory card");
  }
  return card;
}

function getPendingDeviceDetails(container: Element): string[] {
  const item = getInventoryCard(container).querySelector(".list-item");
  expect(item).toBeInstanceOf(Element);
  if (!(item instanceof Element)) {
    throw new Error("Expected pending device item");
  }
  return Array.from(item.querySelectorAll(".list-main > .muted")).map(
    (line) => line.textContent?.trim() ?? "",
  );
}

function findButton(scope: Element, label: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}`);
  }
  return button;
}

describe("nodes devices pending rendering", () => {
  it("shows requested and approved access for a scope upgrade", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "device-1",
            displayName: "Device One",
            role: "operator",
            scopes: ["operator.admin", "operator.read"],
            ts: Date.now(),
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[0]).toMatch(/^scope upgrade requires approval · requested /u);
    expect(details.slice(1)).toEqual([
      "requested: roles: operator · scopes: operator.admin, operator.read, operator.write",
      "approved now: roles: operator · scopes: operator.read",
    ]);
  });

  it("normalizes pending device ids before matching paired access", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: " device-1 ",
            displayName: "Device One",
            role: "operator",
            scopes: ["operator.admin", "operator.read"],
            ts: Date.now(),
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[0]).toMatch(/^scope upgrade requires approval · requested /u);
    expect(details.at(-1)).toBe("approved now: roles: operator · scopes: operator.read");
  });

  it("does not show upgrade context for key-mismatched pending requests", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "device-1",
            publicKey: "new-key",
            displayName: "Device One",
            role: "operator",
            scopes: ["operator.admin"],
            ts: Date.now(),
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            publicKey: "old-key",
            displayName: "Device One",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[0]).toMatch(/^new device pairing request · requested /u);
    expect(details).toEqual([
      details[0] ?? "",
      "requested: roles: operator · scopes: operator.admin, operator.read, operator.write",
    ]);
  });

  it("falls back to roles when role is absent", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-2",
            deviceId: "device-2",
            roles: ["node", "operator"],
            scopes: ["operator.read"],
            ts: Date.now(),
          },
        ],
        paired: [],
      },
    });
    const details = getPendingDeviceDetails(container);

    expect(details[1]).toBe("requested: roles: node, operator · scopes: operator.read");
  });
});

describe("nodes inventory rendering", () => {
  it("pins the Gateway self beacon before paired devices", () => {
    const container = renderNodesContainer({
      presence: [
        {
          instanceId: "gateway-1",
          host: "gateway-host",
          mode: "gateway",
          platform: "linux",
          version: "2026.7.11",
          lastInputSeconds: 5,
        },
      ],
      devicesList: {
        pending: [],
        paired: [{ deviceId: "device-1", displayName: "Device One", roles: ["operator"] }],
      },
    });
    const entries = getInventoryCard(container).querySelectorAll(".nodes-entry");

    expect(entries[0].classList.contains("nodes-entry--gateway")).toBe(true);
    expect(entries[0].textContent).toContain("gateway-host");
    expect(entries[0].textContent).toContain("Linux · 2026.7.11 · input 5s ago");
    expect(entries[0].querySelector("button")).toBeNull();
    expect(entries[0].querySelector("details")).toBeNull();
  });

  it("renders one row per machine with duplicates collapsed", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "mac-new",
            displayName: "MacBook",
            roles: ["operator", "node"],
            lastSeenAtMs: 3_000,
          },
          {
            deviceId: "mac-old",
            displayName: "MacBook",
            roles: ["operator", "node"],
            approvedVia: "silent",
            lastSeenAtMs: 1_000,
          },
        ],
      },
      nodes: [{ nodeId: "mac-new", displayName: "MacBook", connected: true, paired: true }],
    });
    const card = getInventoryCard(container);

    const titles = Array.from(card.querySelectorAll(".list-title")).map((title) =>
      title.textContent?.trim(),
    );
    expect(titles).toEqual(["MacBook", "MacBook"]);
    const dups = card.querySelector(".nodes-group__dups");
    expect(dups?.querySelector("summary")?.textContent).toContain("1 older pairing");
    expect(dups?.textContent).toContain("mac-old");
    expect(findButton(card, "Clean up 1 stale")).toBeInstanceOf(HTMLButtonElement);
  });

  it("wires Remove to the removal routing for the entry roles", () => {
    const removed: InventoryRemovalRequest[] = [];
    const container = renderNodesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "op-only",
            displayName: "Browser",
            roles: ["operator"],
          },
        ],
      },
      onInventoryRemove: (entry) => removed.push(entry),
    });

    findButton(getInventoryCard(container), "Remove").click();

    expect(removed).toEqual([
      { id: "op-only", name: "Browser", removeNode: false, removeDevice: true },
    ]);
  });

  it("renders approve and reject actions for pending node approvals", () => {
    const approvals: string[] = [];
    const container = renderNodesContainer({
      nodes: [
        {
          nodeId: "node-pending",
          displayName: "clawmac",
          paired: true,
          connected: true,
          approvalState: "pending-reapproval",
          pendingRequestId: "node-req-1",
        },
      ],
      onNodeApprove: (requestId) => approvals.push(requestId),
    });
    const card = getInventoryCard(container);

    expect(card.textContent).toContain("approval needed");
    findButton(card, "Approve").click();
    expect(approvals).toEqual(["node-req-1"]);
  });

  it("shows node and Gateway version drift", () => {
    const container = renderNodesContainer({
      gatewayVersion: "2026.7.2",
      nodes: [
        {
          nodeId: "node-old",
          displayName: "Older Mac",
          version: "19.4",
          coreVersion: "2026.6.11",
          uiVersion: "19.4",
          connected: true,
          paired: true,
        },
        {
          nodeId: "node-current",
          displayName: "Current Mac",
          version: "19.5",
          coreVersion: "2026.7.2",
          uiVersion: "19.5",
          connected: true,
          paired: true,
        },
        {
          nodeId: "node-newer",
          displayName: "Newer Mac",
          version: "19.6",
          coreVersion: "2026.8.1",
          uiVersion: "19.6",
          connected: true,
          paired: true,
        },
        {
          nodeId: "legacy-linux",
          displayName: "Legacy Linux",
          platform: "linux",
          version: "2026.6.10",
          connected: true,
          paired: true,
        },
      ],
    });
    const driftChips = Array.from(getInventoryCard(container).querySelectorAll(".chip")).filter(
      (chip) => chip.textContent?.trim() === "version drift",
    );

    expect(driftChips).toHaveLength(3);
    expect(
      driftChips
        .map((chip) => chip.getAttribute("title"))
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual([
      "Node 2026.6.10; Gateway 2026.7.2. Update the older component to align the fleet.",
      "Node 2026.6.11; Gateway 2026.7.2. Update the older component to align the fleet.",
      "Node 2026.8.1; Gateway 2026.7.2. Update the older component to align the fleet.",
    ]);
  });

  it("shows when an offline Windows node requires manual wake", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "windows-browser",
            displayName: "Windows browser",
            platform: "Win32",
            roles: ["operator"],
          },
        ],
      },
      nodes: [
        {
          nodeId: "windows-node",
          displayName: "Windows node",
          platform: "win32",
          connected: false,
          paired: true,
        },
        {
          nodeId: "windows-node-online",
          displayName: "Online Windows node",
          platform: "Windows 11",
          connected: true,
          paired: true,
        },
        {
          nodeId: "windows-node-pending",
          displayName: "Pending Windows node",
          platform: "win32",
          connected: false,
          paired: true,
          approvalState: "pending-approval",
          pendingRequestId: "pending-windows",
        },
        {
          nodeId: "windows-node-unapproved",
          displayName: "Unapproved Windows node",
          platform: "windows",
          connected: false,
          paired: true,
          approvalState: "unapproved",
        },
      ],
    });
    const card = getInventoryCard(container);
    const wakeChips = Array.from(card.querySelectorAll(".chip")).filter(
      (chip) => chip.textContent?.trim() === "manual wake required",
    );

    expect(card.querySelector('[aria-label="offline"]')).not.toBeNull();
    expect(wakeChips).toHaveLength(1);
    expect(wakeChips[0]?.getAttribute("title")).toBe(
      "The Gateway cannot wake an offline Windows node. Start the machine or restore its network connection.",
    );
  });

  it("shows token rows with rotate and revoke inside entry details", () => {
    const rotations: Array<{ deviceId: string; role: string }> = [];
    const revocations: Array<{ deviceId: string; role: string }> = [];
    const container = renderNodesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            tokens: [{ role: "operator", scopes: ["operator.read"], createdAtMs: Date.now() }],
          },
        ],
      },
      onDeviceRotate: (deviceId, role) => rotations.push({ deviceId, role }),
      onDeviceRevoke: (deviceId, role) => revocations.push({ deviceId, role }),
    });
    const card = getInventoryCard(container);

    expect(card.textContent).toContain("operator · active · scopes: operator.read");
    findButton(card, "Rotate").click();
    expect(rotations).toEqual([{ deviceId: "device-1", role: "operator" }]);
    findButton(card, "Revoke").click();
    expect(revocations).toEqual([{ deviceId: "device-1", role: "operator" }]);
  });

  it("always renders private identifiers in Details and status as an accessible dot", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "device-private-id",
            displayName: "Device One",
            platform: "macos 26.5.2",
            remoteIp: "192.0.2.10",
            roles: ["operator"],
          },
        ],
      },
    });
    const entry = getInventoryCard(container).querySelector(".nodes-entry");

    expect(entry?.querySelector(".list-sub")?.textContent).toContain("macOS 26.5.2");
    expect(entry?.querySelector(".list-sub")?.textContent).not.toContain("device-private-id");
    expect(entry?.querySelector(".list-sub")?.textContent).not.toContain("192.0.2.10");
    expect(entry?.querySelector('.status-dot[aria-label="offline"]')).not.toBeNull();
    expect(entry?.querySelector("details")?.textContent).toContain("Device ID: device-private-id");
    expect(entry?.querySelector("details")?.textContent).toContain("Remote IP: 192.0.2.10");
  });

  it("lists live unpaired presence beacons as display-only rows", () => {
    const container = renderNodesContainer({
      presence: [
        {
          instanceId: "webchat-1",
          host: "browser-session",
          mode: "webchat",
          roles: ["operator"],
          platform: "macos 26.5.2",
          lastInputSeconds: 90,
        },
        { instanceId: "left-1", host: "gone", mode: "webchat", reason: "disconnect" },
      ],
    });
    const card = getInventoryCard(container);

    expect(card.textContent).toContain("Connected without pairing");
    expect(card.textContent).not.toContain("gone");
    const entry = Array.from(card.querySelectorAll(".nodes-entry")).find((candidate) =>
      candidate.textContent?.includes("browser-session"),
    );
    expect(entry?.textContent).toContain("unpaired");
    expect(entry?.textContent).toContain("macOS 26.5.2");
    expect(entry?.querySelector('.status-dot[aria-label="connected"]')).not.toBeNull();
    expect(entry?.querySelector("button")).toBeNull();
  });

  it("brands platform names instead of naive capitalization", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [],
        paired: [
          { deviceId: "ios-1", displayName: "iPhone", platform: "iOS 26.4", roles: ["operator"] },
          { deviceId: "mac-1", displayName: "Mac", platform: "darwin", roles: ["operator"] },
        ],
      },
    });
    const subs = Array.from(
      getInventoryCard(container).querySelectorAll(".nodes-entry .list-sub"),
      (node) => node.textContent ?? "",
    );

    expect(subs.some((text) => text.includes("iOS 26.4"))).toBe(true);
    expect(subs.some((text) => text.includes("IOS"))).toBe(false);
    expect(subs.some((text) => text.includes("macOS"))).toBe(true);
  });
});

describe("nodes exec approvals rendering", () => {
  it("renders host-native Windows policies as read-only", () => {
    const container = renderNodesContainer({
      nodes: [
        {
          id: "windows-node",
          label: "Windows node",
          commands: ["system.execApprovals.get", "system.execApprovals.set"],
        },
      ],
      execApprovalsTarget: "node",
      execApprovalsTargetNodeId: "windows-node",
      execApprovalsSnapshot: {
        enabled: true,
        hash: "sha256:current",
        defaultAction: "deny",
        rules: [{ pattern: "hostname", action: "allow" }],
      },
    });
    const card = Array.from(container.querySelectorAll(".card")).find(
      (candidate) =>
        candidate.querySelector(".card-title")?.textContent?.trim() === "Exec approvals",
    );

    expect(card?.textContent).toContain("Host-native policy");
    expect(card?.textContent).toContain("Read-only here");
    expect(card?.textContent).toContain("hostname");
    expect(card?.textContent).toContain("deny");
    expect(card?.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });
});
