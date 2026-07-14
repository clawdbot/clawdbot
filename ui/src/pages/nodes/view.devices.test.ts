/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { InventoryRemovalRequest } from "../../lib/nodes/index.ts";
import { renderNodes } from "./view.ts";
import type { NodesProps } from "./view.types.ts";

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

function getSection(container: Element, heading: string): Element {
  const section = Array.from(container.querySelectorAll(".settings-section")).find((candidate) =>
    candidate.querySelector(".settings-section__heading")?.textContent?.trim().startsWith(heading),
  );
  expect(section).toBeInstanceOf(Element);
  if (!(section instanceof Element)) {
    throw new Error(`Expected ${heading} section`);
  }
  return section;
}

function getInventorySection(container: Element): Element {
  return getSection(container, "Paired devices");
}

function getPendingDeviceDetails(container: Element): string[] {
  const item = getSection(container, "Pending approval").querySelector(".settings-row");
  expect(item).toBeInstanceOf(Element);
  if (!(item instanceof Element)) {
    throw new Error("Expected pending device item");
  }
  const lines = Array.from(item.querySelectorAll(".settings-row__desc")).map(
    (line) => line.textContent?.replace(/\s+/gu, " ").trim() ?? "",
  );
  // Drop the identifier line; the remaining lines carry approval context.
  return lines.slice(1);
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

function statusesByText(scope: Element, text: string): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(".settings-status")).filter(
    (status) => status.textContent?.trim() === text,
  );
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
    const entries = getInventorySection(container).querySelectorAll(".nodes-entry");
    const gatewayEntry = expectDefined(entries[0], "gateway inventory entry");

    expect(statusesByText(gatewayEntry, "gateway")).toHaveLength(1);
    expect(statusesByText(gatewayEntry, "connected")).toHaveLength(1);
    expect(gatewayEntry.textContent).toContain("gateway-host");
    expect(gatewayEntry.textContent).toContain("Linux · 2026.7.11 · input 5s ago");
    expect(gatewayEntry.querySelector("button")).toBeNull();
    expect(gatewayEntry.querySelector("details")).toBeNull();
  });

  it("keeps the paired-devices empty state when only other sections have rows", () => {
    const container = renderNodesContainer({
      devicesList: {
        pending: [
          {
            requestId: "req-1",
            deviceId: "device-1",
            displayName: "Device One",
            role: "operator",
            scopes: [],
            ts: Date.now(),
          },
        ],
        paired: [],
      },
      presence: [{ instanceId: "probe-1", host: "laptop", mode: "probe" }],
    });

    const section = getInventorySection(container);
    expect(section.querySelector(".settings-empty")?.textContent).toContain("No paired devices.");
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
    const section = getInventorySection(container);

    const titles = Array.from(section.querySelectorAll(".settings-row__title")).map((title) =>
      title.textContent?.trim(),
    );
    expect(titles).toEqual(["MacBook", "MacBook"]);
    const dups = section.querySelector(".nodes-group__dups");
    expect(dups?.querySelector("summary")?.textContent).toContain("1 older pairing");
    expect(dups?.textContent).toContain("mac-old");
    expect(findButton(section, "Clean up 1 stale")).toBeInstanceOf(HTMLButtonElement);
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

    findButton(getInventorySection(container), "Remove").click();

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
    const section = getInventorySection(container);

    expect(section.textContent).toContain("approval needed");
    findButton(section, "Approve").click();
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
    const driftStatuses = Array.from(
      getInventorySection(container).querySelectorAll<HTMLElement>("[title]"),
    ).filter((element) => element.textContent?.trim() === "version drift");

    expect(driftStatuses).toHaveLength(3);
    expect(
      driftStatuses
        .map((status) => status.getAttribute("title"))
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
    const section = getInventorySection(container);
    const wakeStatuses = Array.from(section.querySelectorAll<HTMLElement>("[title]")).filter(
      (element) => element.textContent?.trim() === "manual wake required",
    );

    expect(statusesByText(section, "offline").length).toBeGreaterThan(0);
    expect(wakeStatuses).toHaveLength(1);
    expect(wakeStatuses[0]?.getAttribute("title")).toBe(
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
    const section = getInventorySection(container);

    expect(section.textContent).toContain("operator · active · scopes: operator.read");
    findButton(section, "Rotate").click();
    expect(rotations).toEqual([{ deviceId: "device-1", role: "operator" }]);
    findButton(section, "Revoke").click();
    expect(revocations).toEqual([{ deviceId: "device-1", role: "operator" }]);
  });

  it("always renders private identifiers in Details and status as a dot with text", () => {
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
    const entry = getInventorySection(container).querySelector(".nodes-entry");

    expect(entry?.querySelector(".settings-row__desc")?.textContent).toContain("macOS 26.5.2");
    expect(entry?.querySelector(".settings-row__desc")?.textContent).not.toContain(
      "device-private-id",
    );
    expect(entry?.querySelector(".settings-row__desc")?.textContent).not.toContain("192.0.2.10");
    expect(entry ? statusesByText(entry, "offline") : []).toHaveLength(1);
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
    const section = getSection(container, "Connected without pairing");

    expect(section.textContent).not.toContain("gone");
    const entry = Array.from(section.querySelectorAll(".nodes-entry")).find((candidate) =>
      candidate.textContent?.includes("browser-session"),
    );
    expect(entry?.textContent).toContain("unpaired");
    expect(entry?.textContent).toContain("macOS 26.5.2");
    expect(entry ? statusesByText(entry, "connected") : []).toHaveLength(1);
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
      getInventorySection(container).querySelectorAll(".nodes-entry .settings-row__desc"),
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
    const section = getSection(container, "Exec approvals");

    expect(section.textContent).toContain("Host-native policy");
    expect(section.textContent).toContain("Read-only here");
    expect(section.textContent).toContain("hostname");
    expect(section.textContent).toContain("deny");
    expect(section.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });
});
