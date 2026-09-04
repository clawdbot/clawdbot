/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { formatTimeAgo } from "../../lib/format.ts";
import type { InventoryRemovalRequest } from "../../lib/nodes/index.ts";
import { showToast } from "../../lib/toast.ts";
import { createOfflineDeviceNode, deviceSystemInfo } from "../../test-helpers/devices-fixtures.ts";
import {
  renderDevicesContainer,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getSettingsRow,
} from "../../test-helpers/devices-view.ts";

vi.mock("../../components/desktop/desktop-focus-window.ts", () => ({
  openDesktopFocus: vi.fn(),
}));

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function getInventorySection(container: Element): Element {
  return getSection(container, "Paired devices");
}

function getPendingDeviceDetails(container: Element): string[] {
  const item = getSection(container, "Pending approval").querySelector(".settings-row");
  expect(item).toBeInstanceOf(Element);
  if (!(item instanceof Element)) {
    throw new Error("Expected pending device item");
  }
  const meta =
    item
      .querySelector(".device-entry__body > .settings-row__desc")
      ?.textContent?.replace(/\s+/gu, " ")
      .trim() ?? "";
  const access = Array.from(item.querySelectorAll("dt"))
    .filter((label) => /Requested access|Approved access/u.test(label.textContent ?? ""))
    .map((label) => {
      const prefix = label.textContent === "Requested access" ? "requested" : "approved now";
      return `${prefix}: ${label.nextElementSibling?.textContent?.trim()}`;
    });
  return [meta, ...access];
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

function selectMenuItem(scope: Element, value: string): Element {
  const item = expectDefined(
    scope.querySelector(`wa-dropdown-item[value="${value}"]`),
    `menu item ${value}`,
  );
  item.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item: { value } } }));
  return item;
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
  it.each([
    { load: 3.2, free: 41, diskFree: 1200, tone: "ok" },
    { load: 18, free: 24, diskFree: 240, tone: "warn" },
    { load: 28, free: 8, diskFree: 80, tone: "danger" },
  ])("renders node resource pressure as $tone", ({ load, free, diskFree, tone }) => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "studio",
          displayName: "Studio",
          connected: true,
          paired: true,
          platform: "macos 27.0",
          modelIdentifier: "Mac15,14",
          version: "2026.8.1",
          hostStats: {
            cpuCount: 24,
            loadAverage: [load, 2.8, 2.4],
            memoryTotalBytes: 192 * 1024 ** 3,
            memoryFreeBytes: free * 1024 ** 3,
            diskTotalBytes: 2048 * 1024 ** 3,
            diskAvailableBytes: diskFree * 1024 ** 3,
            updatedAtMs: 1000,
          },
        },
        { nodeId: "without-stats", displayName: "Without stats", paired: true, connected: true },
      ],
    });
    const row = getSettingsRow(container, "Studio");
    expect(row.querySelectorAll(`.device-resources .session-context-meter--${tone}`)).toHaveLength(
      3,
    );
    expect(row.querySelector(".device-resource")?.getAttribute("title")).toContain(
      `${load.toFixed(2)} / 2.80 / 2.40 on 24 cores`,
    );
    expect(row.querySelector(".settings-row__desc")?.textContent).toContain(
      "macOS 27.0 · Mac Studio · Mac15,14 · 2026.8.1",
    );
    expect(
      getSettingsRow(container, "Without stats").querySelector(".device-resources"),
    ).toBeNull();
    if (tone === "ok") {
      expect(row.textContent).toContain("151 / 192 GB");
    }
  });

  it.each([false, true])(
    "marks retained host stats stale only when connected is %s",
    (connected) => {
      const now = Date.now();
      const node = { ...createOfflineDeviceNode(now), connected };
      const container = renderDevicesContainer({ nodes: [node] });
      const row = getSettingsRow(container, node.displayName);
      const age = formatTimeAgo(now - node.hostStats.updatedAtMs);
      const meters = row.querySelectorAll(".device-resource");
      expect(meters).toHaveLength(3);
      for (const meter of meters) {
        expect(meter.querySelector(".session-context-meter--stale") !== null).toBe(!connected);
        expect(
          meter.querySelector(".device-resource__label")?.textContent?.includes(` · ${age}`),
        ).toBe(!connected);
        expect(meter.getAttribute("title")?.includes(`last known ${age}`)).toBe(!connected);
      }
    },
  );

  it("hides only meters whose optional inputs are absent", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "memory",
          displayName: "Memory only",
          paired: true,
          hostStats: {
            cpuCount: 8,
            memoryTotalBytes: 32 * 1024 ** 3,
            memoryFreeBytes: 16 * 1024 ** 3,
            updatedAtMs: 1000,
          },
        },
      ],
    });
    const meters = getSettingsRow(container, "Memory only").querySelectorAll(".device-resource");
    expect(meters).toHaveLength(1);
    expect(meters[0]?.textContent).toContain("16 / 32 GB");
  });

  it.each(["gateway", "node:studio"])(
    "opens the recorded %s desktop environment in a focus window",
    (environmentId) => {
      // Settings routes hide the docked panel, so the row must open the standalone window.
      vi.mocked(openDesktopFocus).mockClear();
      const container = renderDevicesContainer({
        basePath: "/ui",
        presence: [{ host: "Gateway", mode: "gateway", ts: 1000 }],
        nodes: [{ nodeId: "studio", displayName: "Studio", paired: true, connected: true }],
        desktopEnvironments: [
          { id: environmentId, type: "host", status: "available", desktop: true },
        ],
      });
      expect(container.querySelectorAll(".device-entry__desktop")).toHaveLength(1);
      findButton(
        getSettingsRow(container, environmentId === "gateway" ? "Gateway" : "Studio"),
        "Desktop",
      ).click();
      expect(openDesktopFocus).toHaveBeenCalledExactlyOnceWith("/ui", environmentId);
      vi.mocked(openDesktopFocus).mockClear();
      selectMenuItem(
        getSettingsRow(container, environmentId === "gateway" ? "Gateway" : "Studio"),
        "desktop",
      );
      expect(openDesktopFocus).toHaveBeenCalledExactlyOnceWith("/ui", environmentId);
    },
  );

  it.each([undefined, false])(
    "does not infer Desktop availability from commands: %s",
    (desktop) => {
      const container = renderDevicesContainer({
        nodes: [
          { nodeId: "studio", displayName: "Studio", paired: true, commands: ["desktop.stream"] },
        ],
        desktopEnvironments: [
          { id: "node:studio", type: "node", status: "available", desktop },
          { id: "node:other", type: "node", status: "available", desktop: true },
        ],
      });
      const row = getSettingsRow(container, "Studio");
      expect(row.querySelector(".device-entry__desktop")).toBeNull();
      const chip = row.querySelector('[aria-disabled="true"]');
      expect(chip?.getAttribute("title")).toContain("desktop.host.enabled: true");
      expect(chip?.getAttribute("title")).toContain("gateway.nodes.commands.allow");
      expect(row.querySelector(".device-entry__facts")?.textContent).toContain("desktop.stream");
    },
  );

  it("renders Gateway resources and uptime from system info", () => {
    const container = renderDevicesContainer({
      presence: [{ host: "Gateway", mode: "gateway", ts: 1000 }],
      gatewaySystemInfo: {
        ...deviceSystemInfo,
        uptimeMs: (11 * 24 + 4) * 3600000,
        cpuCount: 16,
        loadAverage: [3.2, 2.8, 2.4],
        memoryTotalBytes: 64 * 1024 ** 3,
        memoryFreeBytes: 32 * 1024 ** 3,
        diskTotalBytes: 2 * 1024 ** 4,
        diskAvailableBytes: 1.2 * 1024 ** 4,
      },
    });
    const row = getSettingsRow(container, "Gateway");
    expect(row.querySelectorAll(".device-resource")).toHaveLength(3);
    expect(row.textContent).toContain("load 3.2");
    expect(row.textContent).toContain("1.2 TB free");
    expect(row.querySelector(".settings-row__desc")?.textContent).toContain("up 11d 4h");
  });

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

  it("routes the danger menu item through the existing inventory removal request", () => {
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

    const row = getSettingsRow(container, "Browser");
    expect(row.querySelector(".device-entry__remove")).toBeNull();
    expect(selectMenuItem(row, "remove").getAttribute("variant")).toBe("danger");

    expect(removed).toEqual([
      { id: "op-only", name: "Browser", removeNode: false, removeDevice: true },
    ]);
  });

  it.each([true, false])(
    "reports the device ID copy outcome when clipboard succeeds: %s",
    async (succeeds) => {
      const writeText = succeeds
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn().mockRejectedValue(new Error("Denied"));
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const container = renderDevicesContainer({
        canManagePairing: false,
        devicesList: {
          pending: [],
          paired: [{ deviceId: "copy-device-id", displayName: "Copy device", roles: ["operator"] }],
        },
      });
      const row = getSettingsRow(container, "Copy device");
      expect(selectMenuItem(row, "copy").hasAttribute("disabled")).toBe(false);
      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith({
          message: succeeds ? "Device ID copied" : "Copy failed",
        }),
      );
      expect(writeText).toHaveBeenCalledExactlyOnceWith("copy-device-id");
    },
  );

  it("copies the device ID through execCommand when the Clipboard API is absent", async () => {
    // Plain-HTTP/LAN origins expose no navigator.clipboard; jsdom has no execCommand either.
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = execCommand;
    try {
      const container = renderDevicesContainer({
        canManagePairing: false,
        devicesList: {
          pending: [],
          paired: [{ deviceId: "copy-device-id", displayName: "Copy device", roles: ["operator"] }],
        },
      });
      selectMenuItem(getSettingsRow(container, "Copy device"), "copy");
      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith({ message: "Device ID copied" }),
      );
      expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
  });

  it("renders approve and reject actions for pending node approvals", () => {
    const approvals: string[] = [];
    const rejections: string[] = [];
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
      onNodeReject: (requestId) => rejections.push(requestId),
    });
    const section = getInventorySection(container);

    expect(section.textContent).toContain("approval needed");
    expect(
      Array.from(section.querySelectorAll("button"), (button) => button.textContent?.trim()),
    ).not.toContain("Approve");
    selectMenuItem(section, "approve");
    selectMenuItem(section, "reject");
    expect(rejections).toEqual(["node-req-1"]);
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
    expect(installed ? statusesByText(installed, "connected") : []).toHaveLength(1);
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
      basePath: "",
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
          hostStats: createOfflineDeviceNode().hostStats,
        },
      ],
    });
    const section = getInventorySection(container);
    const row = getSettingsRow(section, "Mixed-role Windows");

    expect(section.textContent).toContain("1 of 1 connected");
    expect(
      row.querySelector('.settings-row__control [role="img"]')?.getAttribute("aria-label"),
    ).toBe("Slot utilization unavailable");
    expect(row.querySelectorAll(".device-resources .session-context-meter--stale")).toHaveLength(3);
    expect(row.querySelector(".device-resource__label")?.textContent).toContain("27d ago");
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
            scopes: ["operator.read"],
            tokens: [{ role: "operator", scopes: ["operator.read"], createdAtMs: Date.now() }],
          },
        ],
      },
      onDeviceRotate: (device, role) =>
        rotations.push({ deviceId: device.id, name: device.name, role }),
      onDeviceRevoke: (deviceId, role) => revocations.push({ deviceId, role }),
    });
    const section = getInventorySection(container);

    const facts = expectDefined(section.querySelector(".device-entry__facts"), "device facts");
    expect(facts.querySelector("dt")?.textContent).toBe("Device ID");
    expect(facts.querySelector("dd[title='device-1']")?.textContent).toBe("device-1");
    expect(facts.querySelector(".device-capability--scope")?.textContent).toBe("operator.read");
    const tokenRow = expectDefined(facts.querySelector("table tbody tr"), "token table row");
    expect(
      Array.from(tokenRow.querySelectorAll("td"), (cell) => cell.textContent?.trim()).slice(0, 3),
    ).toEqual(["operator", "active", "operator.read"]);
    expect(facts.querySelector(".muted")).toBeNull();
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
    expect(entry?.querySelector("dd[title='device-private-id']")?.textContent).toBe(
      "device-private-id",
    );
    expect(entry?.querySelector(".device-entry__facts")?.textContent).toContain("192.0.2.10");
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
    const onInventoryRemove = vi.fn();
    const onNodeApprove = vi.fn();
    const onNodeReject = vi.fn();
    const container = renderDevicesContainer({
      onInventoryRemove,
      onNodeApprove,
      onNodeReject,
      nodes: [
        {
          nodeId: "node-pending",
          displayName: "Pending node",
          paired: true,
          approvalState: "pending-reapproval",
          pendingRequestId: "node-request",
        },
      ],
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
    const remove = getSettingsRow(container, "Device One").querySelector(
      'wa-dropdown-item[value="remove"]',
    );
    expect(remove?.hasAttribute("disabled")).toBe(true);
    expect(remove?.getAttribute("title")).toContain("operator.pairing");
    selectMenuItem(getSettingsRow(container, "Device One"), "remove");
    for (const action of ["approve", "reject"]) {
      expect(
        selectMenuItem(getSettingsRow(container, "Pending node"), action).hasAttribute("disabled"),
      ).toBe(true);
    }
    expect(onInventoryRemove).not.toHaveBeenCalled();
    expect(onNodeApprove).not.toHaveBeenCalled();
    expect(onNodeReject).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Browsing only. Exec approvals and node bindings require operator.admin access.",
    );
  });
});
