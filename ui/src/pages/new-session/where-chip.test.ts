/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

function renderPicker(isAdmin: boolean, autoPlacementMode?: "least-busy" | "eligible-order") {
  const state = resolveWhereChip({
    environments: [
      {
        id: "node:runner",
        type: "node",
        label: "Build runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 2, available: 1 },
      },
      {
        id: "node:alpha-device",
        type: "node",
        label: "Duplicate runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
      {
        id: "node:beta-device",
        type: "node",
        label: "Duplicate runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
    ],
    cloudProfiles: [{ id: "aws", providerId: "crabbox" }],
    cloudProfileId: "",
    deviceId: "",
  });
  const container = document.createElement("div");
  render(
    renderWhereChip({
      state,
      gatewayName: "",
      cloudProfileId: "",
      deviceId: "",
      worktreeAvailable: true,
      submitting: false,
      pendingPlacement: false,
      popoverOpen: true,
      popoverHiding: false,
      isAdmin,
      ...(autoPlacementMode ? { autoPlacementMode } : {}),
      onGuardTransition: vi.fn(),
      onPopoverShow: vi.fn(),
      onPopoverHide: vi.fn(),
      onPopoverAfterHide: vi.fn(),
      onSelectDevice: vi.fn(),
      onSelectAutoDevice: vi.fn(),
      onSelectCloudProfile: vi.fn(),
      onConnectMachine: vi.fn(),
    }),
    container,
  );
  return container;
}

describe("Where chip", () => {
  it("keeps capacity structured and exposes busy slots without an ambiguous visible fraction", () => {
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:runner",
          type: "node",
          label: "Build runner",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 2, available: 1 },
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "runner",
    });

    expect(state.kind).toBe("device");
    expect(state.label).toBe("Build runner");
    const row = renderPicker(false).querySelector('[data-value="device:runner"]');
    expect(row?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "1 of 2 slots busy",
    );
    expect(row?.getAttribute("title")).toBe("1 of 2 slots busy");
    expect(row?.textContent).not.toContain("Worker slots");
    expect(state.devices[0]?.workerSlots).toEqual({ total: 2, available: 1 });
    expect(state.devices[0]?.facts).toEqual([]);
  });

  it("renders devices for writers while cloud and Connect remain admin-only", () => {
    const writer = renderPicker(false);
    const autoRow = writer.querySelector('[data-value="auto-device"]');
    expect(autoRow?.textContent).toContain("Auto");
    expect(autoRow?.querySelector(".session-menu__sub")?.textContent).toContain(
      "Least-busy device",
    );
    const remoteExec = renderPicker(false, "eligible-order");
    expect(
      remoteExec.querySelector('[data-value="auto-device"] .session-menu__sub')?.textContent,
    ).toContain("First eligible device");
    expect(writer.querySelector('[data-value="device:runner"]')).not.toBeNull();
    expect(writer.querySelector('[data-value="device:runner"] .session-menu__sub')).toBeNull();
    expect(
      writer.querySelector('[data-value="device:alpha-device"] .session-menu__sub')?.textContent,
    ).toBe("alpha-de");
    expect(
      writer.querySelector('[data-value="device:beta-device"] .session-menu__sub')?.textContent,
    ).toBe("beta-dev");
    expect(writer.querySelector('[data-value="cloud:aws"]')).toBeNull();
    expect(writer.querySelector('[data-value="connect-machine"]')).toBeNull();

    const admin = renderPicker(true);
    expect(admin.querySelector('[data-value="device:runner"]')).not.toBeNull();
    expect(admin.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(admin.querySelector('[data-value="connect-machine"]')).not.toBeNull();
  });

  it("disables device placements when the selected runtime cannot dispatch to devices", () => {
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:macbook",
          type: "node",
          label: "MacBook",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 1, available: 1 },
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "",
      deviceDisabledReason: "This runtime does not support paired devices",
    });
    const container = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: true,
        onGuardTransition: () => undefined,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onSelectDevice: () => undefined,
        onSelectAutoDevice: () => undefined,
        onSelectCloudProfile: () => undefined,
        onConnectMachine: () => undefined,
      }),
      container,
    );

    const device = container.querySelector<HTMLButtonElement>('[data-value="device:macbook"]');
    expect(device?.disabled).toBe(true);
    expect(device?.textContent).toContain("This runtime does not support paired devices");
    // The disabled reason owns the title; the meter's no-claim alt text stays on its aria-label.
    expect(device?.title).toBe("This runtime does not support paired devices");
  });

  it("omits the devices section entirely when no devices are paired", () => {
    const state = resolveWhereChip({
      environments: [],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "",
    });
    const emptyContainer = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: false,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectDevice: vi.fn(),
        onSelectAutoDevice: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onConnectMachine: vi.fn(),
      }),
      emptyContainer,
    );
    expect(emptyContainer.querySelector('[data-value="auto-device"]')).toBeNull();
  });

  it.each([
    {
      name: "no paired device hosts sessions",
      issues: undefined,
      reason: /no session hosts are paired/i,
    },
    {
      name: "a paired node must be updated before it can advertise session hosting",
      issues: [
        {
          code: "update-required",
          action: "update-and-reconnect",
          updateCommand: "openclaw update",
          headlessReconnectCommand: "openclaw node restart",
        } as const,
      ],
      reason: /openclaw update.*openclaw node restart/i,
    },
  ])("disables automatic selection with an actionable reason when $name", ({ issues, reason }) => {
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:macbook",
          type: "node",
          label: "MacBook",
          status: "available",
          sessionHost: false,
          ...(issues ? { issues } : {}),
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "",
    });
    const container = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: false,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectDevice: vi.fn(),
        onSelectAutoDevice: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onConnectMachine: vi.fn(),
      }),
      container,
    );

    const automatic = container.querySelector<HTMLButtonElement>('[data-value="auto-device"]');
    expect(automatic?.disabled).toBe(true);
    expect(automatic?.title).toMatch(reason);
    expect(automatic?.textContent).toMatch(reason);
  });

  it.each([
    {
      name: "allows enabled remote execution without a free worker slot",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v2"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: ["codex.exec-server.stdio.v2"],
      disabled: false,
      label: "1 of 1 slots busy",
      tone: "warn",
    },
    {
      name: "shows slot-less remote execution without a capacity claim",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v2"],
        consumesWorkerSlot: false,
      },
      workerSlots: undefined,
      invocableCommands: ["codex.exec-server.stdio.v2"],
      disabled: false,
      label: "Codex exec",
      tone: undefined,
    },
    {
      name: "keeps worker execution capacity-gated",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: [],
      disabled: true,
      reason: /worker slots/i,
      label: "Slot utilization unavailable",
      tone: "stale",
    },
    {
      name: "disables a declared remote command that the Gateway has not enabled",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v2"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 1 },
      invocableCommands: [],
      disabled: true,
      reason: /enable|approv/i,
      label: "Slot utilization unavailable",
      tone: "stale",
    },
  ])(
    "$name in the New Session picker",
    ({ devicePlacement, workerSlots, invocableCommands, disabled, reason, label, tone }) => {
      const state = resolveWhereChip({
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: true,
            workerSlots,
            capabilities: ["codex.exec-server.stdio.v2"],
            invocableCommands,
          },
        ],
        cloudProfiles: [],
        cloudProfileId: "",
        deviceId: "",
        devicePlacement,
      });
      const container = document.createElement("div");
      render(
        renderWhereChip({
          state,
          gatewayName: "",
          cloudProfileId: "",
          deviceId: "",
          worktreeAvailable: true,
          submitting: false,
          pendingPlacement: false,
          popoverOpen: true,
          popoverHiding: false,
          isAdmin: true,
          onGuardTransition: vi.fn(),
          onPopoverShow: vi.fn(),
          onPopoverHide: vi.fn(),
          onPopoverAfterHide: vi.fn(),
          onSelectDevice: vi.fn(),
          onSelectAutoDevice: vi.fn(),
          onSelectCloudProfile: vi.fn(),
          onConnectMachine: vi.fn(),
        }),
        container,
      );

      const device = container.querySelector<HTMLButtonElement>('[data-value="device:runner"]');
      expect(device?.disabled).toBe(disabled);
      const meter = device?.querySelector('[role="img"]');
      expect(meter?.getAttribute("aria-label")).toBe(label);
      if (tone) {
        expect(meter?.classList.contains(`session-context-meter--${tone}`)).toBe(true);
      }
      if (reason) {
        expect(device?.title).toMatch(reason);
      }
    },
  );
});
