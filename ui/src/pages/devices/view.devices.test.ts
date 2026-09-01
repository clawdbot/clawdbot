/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { InventoryRemovalRequest } from "../../lib/nodes/index.ts";
import { renderDevices } from "./view.ts";
import type { DevicesProps } from "./view.types.ts";

function baseProps(overrides: Partial<DevicesProps> = {}): DevicesProps {
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
    canManagePairing: true,
    canAdmin: true,
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

function renderDevicesContainer(overrides: Partial<DevicesProps>): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDevices(baseProps(overrides)), container);
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

function getSettingsRow(container: Element, title: string): Element {
  const row = Array.from(container.querySelectorAll(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  expect(row).toBeInstanceOf(Element);
  if (!(row instanceof Element)) {
    throw new Error(`Expected ${title} row`);
  }
  return row;
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

describe("devices pending rendering", () => {
  it("shows requested and approved access for a scope upgrade", () => {
    const container = renderDevicesContainer({
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
    const container = renderDevicesContainer({
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
    const container = renderDevicesContainer({
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
    const container = renderDevicesContainer({
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

describe("devices inventory rendering", () => {
  it("pins the Gateway self beacon before paired devices", () => {
    const container = renderDevicesContainer({
      presence: [
        {
          instanceId: "gateway-1",
          host: "gateway-host",
          mode: "gateway",
          platform: "linux",
          version: "2026.7.11",
          lastInputSeconds: 5,
          ts: 1_000,
        },
      ],
      devicesList: {
        pending: [],
        paired: [{ deviceId: "device-1", displayName: "Device One", roles: ["operator"] }],
      },
    });
    const entries = getInventorySection(container).querySelectorAll(".device-entry");
    const gatewayEntry = expectDefined(entries[0], "gateway inventory entry");

    expect(statusesByText(gatewayEntry, "gateway")).toHaveLength(1);
    expect(statusesByText(gatewayEntry, "connected")).toHaveLength(0);
    expect(gatewayEntry.textContent).toContain("gateway-host");
    expect(gatewayEntry.textContent).toContain("Linux · 2026.7.11 · input 5s ago");
    expect(gatewayEntry.querySelector("button")).toBeNull();
    expect(gatewayEntry.querySelector("details")).toBeNull();
  });

  it("keeps the paired-devices empty state when only other sections have rows", () => {
    const container = renderDevicesContainer({
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
      presence: [{ instanceId: "probe-1", host: "laptop", mode: "probe", ts: 1_000 }],
    });

    const section = getInventorySection(container);
    expect(section.querySelector(".settings-empty")?.textContent).toContain("No paired devices.");
  });

  it("renders one row per machine with duplicates collapsed", () => {
    const container = renderDevicesContainer({
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
    const dups = section.querySelector(".device-group__dups");
    expect(dups?.querySelector("summary")?.textContent).toContain("1 older pairing");
    expect(dups?.textContent).toContain("mac-old");
    expect(findButton(section, "Clean up 1 stale")).toBeInstanceOf(HTMLButtonElement);
  });

  it("wires the remove icon button to the removal routing for the entry roles", () => {
    const removed: InventoryRemovalRequest[] = [];
    const container = renderDevicesContainer({
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

    const button = getInventorySection(container).querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Browser"]',
    );
    expect(button).toBeInstanceOf(HTMLButtonElement);
    button?.click();

    expect(removed).toEqual([
      { id: "op-only", name: "Browser", removeNode: false, removeDevice: true },
    ]);
  });

  it("renders approve and reject actions for pending node approvals", () => {
    const approvals: string[] = [];
    const container = renderDevicesContainer({
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

  it("keeps installed workers quiet and warns when the retained bundle is missing", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "node-installed",
          displayName: "Installed Mac",
          connected: true,
          paired: true,
          workerSlots: { total: 2, available: 1 },
          workerBundle: { status: "installed", version: "2026.8.9" },
        },
        {
          nodeId: "node-missing",
          displayName: "Missing Mac",
          connected: true,
          paired: true,
          workerBundle: { status: "missing" },
        },
      ],
    });
    const section = getInventorySection(container);
    const rows = Array.from(section.querySelectorAll(".device-entry"));
    const installed = rows.find((row) => row.textContent?.includes("Installed Mac"));
    const missing = rows.find((row) => row.textContent?.includes("Missing Mac"));

    expect(installed?.querySelector(".settings-row__desc")?.textContent).toContain(
      "Worker 2026.8.9",
    );
    expect(installed?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "1 of 2 slots busy",
    );
    expect(installed?.getAttribute("title")).toBe("1 of 2 slots busy");
    expect(installed?.querySelector(".settings-row__desc")?.textContent).not.toContain(
      "Worker slots",
    );
    expect(installed ? statusesByText(installed, "connected") : []).toHaveLength(0);
    expect(installed ? statusesByText(installed, "worker missing") : []).toHaveLength(0);
    expect(missing ? statusesByText(missing, "worker missing") : []).toHaveLength(1);
    expect(
      Array.from(missing?.querySelectorAll<HTMLElement>("[title]") ?? [])
        .find((element) => element.textContent?.trim() === "worker missing")
        ?.getAttribute("title"),
    ).toBe(
      "The Gateway-managed worker bundle is missing. Start a new session on this device to reinstall it.",
    );
  });

  it("shows device and Gateway version drift", () => {
    const container = renderDevicesContainer({
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
      "Device 2026.6.10; Gateway 2026.7.2. Update the older component to align the fleet.",
      "Device 2026.6.11; Gateway 2026.7.2. Update the older component to align the fleet.",
      "Device 2026.8.1; Gateway 2026.7.2. Update the older component to align the fleet.",
    ]);
  });

  it("shows when an offline Windows device requires manual wake", () => {
    const container = renderDevicesContainer({
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
      "The Gateway cannot wake an offline Windows device. Start the machine or restore its network connection.",
    );
  });

  it("shows node-only offline affordances while preserving mixed-role device liveness", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          {
            deviceId: "windows-mixed",
            displayName: "Mixed-role Windows",
            platform: "Windows 11",
            roles: ["operator", "node"],
            connected: true,
          },
        ],
      },
      nodes: [
        {
          nodeId: "windows-mixed",
          displayName: "Mixed-role Windows",
          platform: "Windows 11",
          connected: false,
          paired: true,
          workerSlots: { total: 8, available: 0 },
        },
      ],
    });
    const section = getInventorySection(container);
    const row = getSettingsRow(section, "Mixed-role Windows");

    expect(section.textContent).toContain("1 of 1 connected");
    expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Slot utilization unavailable",
    );
    expect(row.querySelectorAll(".capacity-meter-pips__pip--filled")).toHaveLength(0);
    expect(
      Array.from(row.querySelectorAll(".settings-status"), (status) => status.textContent?.trim()),
    ).toEqual(["offline", "manual wake required"]);
  });

  it.each([
    { caps: ["codex.exec-server"], commands: [] },
    { caps: [], commands: ["codex.exec-server.stdio.v1"] },
  ])("preserves the slot-less exec affordance through node inventory: %j", ({ caps, commands }) => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "exec",
          displayName: "Exec host",
          connected: true,
          paired: true,
          caps,
          commands,
        },
      ],
    });
    const row = getSettingsRow(getInventorySection(container), "Exec host");
    expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Codex exec");
    expect(row.querySelector(".capacity-meter-pips, .session-context-meter")).toBeNull();
  });

  it("shows token rows with rotate and revoke inside entry details", () => {
    const rotations: Array<{ deviceId: string; name: string; role: string }> = [];
    const revocations: Array<{ deviceId: string; role: string }> = [];
    const container = renderDevicesContainer({
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
      onDeviceRotate: (device, role) =>
        rotations.push({ deviceId: device.id, name: device.name, role }),
      onDeviceRevoke: (deviceId, role) => revocations.push({ deviceId, role }),
    });
    const section = getInventorySection(container);

    expect(section.textContent).toContain("operator · active · scopes: operator.read");
    findButton(section, "Rotate").click();
    // The rotate callback carries the row label, so the outcome dialog can name it.
    expect(rotations).toEqual([{ deviceId: "device-1", name: "Device One", role: "operator" }]);
    findButton(section, "Revoke").click();
    expect(revocations).toEqual([{ deviceId: "device-1", role: "operator" }]);
  });

  it("always renders private identifiers in Details and status as a dot with text", () => {
    const container = renderDevicesContainer({
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
    const entry = getInventorySection(container).querySelector(".device-entry");

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
    const container = renderDevicesContainer({
      presence: [
        {
          instanceId: "webchat-1",
          host: "browser-session",
          mode: "webchat",
          roles: ["operator"],
          platform: "macos 26.5.2",
          lastInputSeconds: 90,
          ts: 1_000,
        },
        {
          instanceId: "left-1",
          host: "gone",
          mode: "webchat",
          reason: "disconnect",
          ts: 2_000,
        },
      ],
    });
    const section = getSection(container, "Connected without pairing");

    expect(section.textContent).not.toContain("gone");
    const entry = Array.from(section.querySelectorAll(".device-entry")).find((candidate) =>
      candidate.textContent?.includes("browser-session"),
    );
    expect(entry?.textContent).toContain("unpaired");
    expect(entry?.textContent).toContain("macOS 26.5.2");
    expect(entry ? statusesByText(entry, "connected") : []).toHaveLength(0);
    expect(entry?.querySelector("button")).toBeNull();
  });

  it("brands platform names instead of naive capitalization", () => {
    const container = renderDevicesContainer({
      devicesList: {
        pending: [],
        paired: [
          { deviceId: "ios-1", displayName: "iPhone", platform: "iOS 26.4", roles: ["operator"] },
          { deviceId: "mac-1", displayName: "Mac", platform: "darwin", roles: ["operator"] },
        ],
      },
    });
    const subs = Array.from(
      getInventorySection(container).querySelectorAll(".device-entry .settings-row__desc"),
      (node) => node.textContent ?? "",
    );

    expect(subs.some((text) => text.includes("iOS 26.4"))).toBe(true);
    expect(subs.some((text) => text.includes("IOS"))).toBe(false);
    expect(subs.some((text) => text.includes("macOS"))).toBe(true);
  });
});

describe("devices access gating", () => {
  it("disables pairing and admin mutations with one browsing-only notice", () => {
    const container = renderDevicesContainer({
      canPairDevice: false,
      canManagePairing: false,
      canAdmin: false,
      devicesList: {
        pending: [
          {
            requestId: "request-1",
            deviceId: "pending-device",
            displayName: "Pending device",
            roles: ["operator"],
            scopes: ["operator.read"],
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            displayName: "Device One",
            roles: ["operator"],
            tokens: [{ role: "operator", scopes: ["operator.read"], createdAtMs: Date.now() }],
          },
        ],
      },
      configForm: { agents: { entries: [{ id: "main", default: true }] } },
      configDirty: true,
    });

    expect(container.querySelectorAll(".callout.info")).toHaveLength(1);
    expect(container.textContent).toContain("Device changes require operator.pairing");
    for (const label of ["Approve", "Reject", "Rotate", "Revoke", "Save"]) {
      expect(findButton(container, label).disabled).toBe(true);
    }
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove Device One"]')
        ?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain(
      "Browsing only. Exec approvals and node bindings require operator.admin access.",
    );
  });
});

describe("devices exec approvals rendering", () => {
  it("renders owner-reported defaults for fresh approval state", () => {
    const container = renderDevicesContainer({
      execApprovalsSnapshot: {
        path: "/tmp/exec-approvals.json",
        exists: false,
        hash: "missing:empty",
        file: { version: 1, agents: {} },
        resolvedDefaults: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      },
    });
    const section = getSection(container, "Exec approvals");

    expect(
      getSettingsRow(section, "Security").querySelector<HTMLSelectElement>("select")?.value,
    ).toBe("full");
    expect(getSettingsRow(section, "Ask").querySelector<HTMLSelectElement>("select")?.value).toBe(
      "off",
    );
  });

  it("preserves authored wildcard and agent overrides above owner defaults", () => {
    const container = renderDevicesContainer({
      execApprovalsSnapshot: {
        path: "/tmp/exec-approvals.json",
        exists: false,
        hash: "missing:empty",
        file: {
          version: 1,
          agents: {
            "*": { security: "allowlist", ask: "always" },
            main: { ask: "on-miss" },
          },
        },
        resolvedDefaults: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      },
      execApprovalsSelectedAgent: "main",
    });
    const section = getSection(container, "Exec approvals");
    const security = getSettingsRow(section, "Security").querySelector<HTMLSelectElement>("select");
    const ask = getSettingsRow(section, "Ask").querySelector<HTMLSelectElement>("select");
    const fallback = getSettingsRow(section, "Ask fallback").querySelector<HTMLSelectElement>(
      "select",
    );

    expect(security?.selectedOptions[0]?.textContent?.trim()).toBe("Use default (allowlist)");
    expect(ask?.value).toBe("on-miss");
    expect(fallback?.selectedOptions[0]?.textContent?.trim()).toBe("Use default (deny)");
  });

  it("offers only nodes that support both reading and writing approval policy", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "get-only",
          displayName: "Get only",
          commands: ["system.execApprovals.get"],
        },
        {
          nodeId: "set-only",
          displayName: "Set only",
          commands: ["system.execApprovals.set"],
        },
        {
          nodeId: "editable",
          displayName: "Editable",
          commands: ["system.execApprovals.get", "system.execApprovals.set"],
        },
      ],
      execApprovalsTarget: "node",
    });
    const section = getSection(container, "Exec approvals");
    const nodeSelect = section.querySelector<HTMLSelectElement>('select[aria-label="Node"]');

    expect(Array.from(nodeSelect?.options ?? [], (option) => option.value)).toEqual([
      "",
      "editable",
    ]);
  });

  it("renders defaults, configured agents, and approval-only agents in the avatar picker", async () => {
    const onExecApprovalsSelectAgent = vi.fn();
    const container = renderDevicesContainer({
      configForm: {
        agents: {
          entries: {
            main: { name: "Main", default: true },
            research: { name: "Research" },
          },
        },
      },
      execApprovalsForm: {
        version: 1,
        defaults: { security: "deny" },
        agents: { retired: { security: "full" } },
      },
      execApprovalsSelectedAgent: "research",
      onExecApprovalsSelectAgent,
    });
    const section = getSection(container, "Exec approvals");
    const picker = section.querySelector<
      HTMLElement & {
        options: Array<{ value: string; badge?: string }>;
        onSelect: (value: string) => void;
        updateComplete: Promise<boolean>;
      }
    >("openclaw-agent-select");
    await picker?.updateComplete;

    expect(picker?.options.map((option) => option.value)).toEqual([
      "__defaults__",
      "main",
      "research",
      "retired",
    ]);
    expect(picker?.options.find((option) => option.value === "main")?.badge).toBe("Default");
    picker?.onSelect("retired");
    expect(onExecApprovalsSelectAgent).toHaveBeenCalledWith("retired");
  });

  it("renders host-native Windows policies as read-only", () => {
    const container = renderDevicesContainer({
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

describe("devices agent bindings", () => {
  it("reports node bindings and translates each unbound sentinel", () => {
    const onBindDefault = vi.fn();
    const onBindAgent = vi.fn();
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "worker-node",
          displayName: "Worker node",
          commands: ["system.run"],
        },
      ],
      configForm: {
        agents: {
          entries: {
            MAIN: { default: true },
            research: {},
          },
        },
      },
      onBindDefault,
      onBindAgent,
    });
    const bindingSection = getSection(container, "Exec node binding");
    const selects = bindingSection.querySelectorAll<HTMLSelectElement>("select.settings-select");

    const [defaultBinding, mainBinding] = selects;
    defaultBinding!.value = "worker-node";
    defaultBinding!.dispatchEvent(new Event("change"));
    defaultBinding!.value = "";
    defaultBinding!.dispatchEvent(new Event("change"));
    mainBinding!.value = "worker-node";
    mainBinding!.dispatchEvent(new Event("change"));
    mainBinding!.value = "__default__";
    mainBinding!.dispatchEvent(new Event("change"));

    expect(onBindDefault.mock.calls).toEqual([["worker-node"], [null]]);
    expect(onBindAgent.mock.calls).toEqual([
      ["MAIN", "worker-node"],
      ["MAIN", null],
    ]);
  });
});
