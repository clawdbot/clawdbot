/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

function renderPicker(isAdmin: boolean) {
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
  it("projects the selected device label and exact capacity facts", () => {
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
    expect(state.devices[0]?.facts).toEqual(["Worker slots 1/2"]);
  });

  it("renders devices for writers while cloud and Connect remain admin-only", () => {
    const writer = renderPicker(false);
    expect(writer.querySelector('[data-value="auto-device"]')?.textContent).toContain(
      "Any available node",
    );
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
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: ["codex.exec-server.stdio.v1"],
      disabled: false,
    },
    {
      name: "keeps worker execution capacity-gated",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: [],
      disabled: true,
      reason: /worker slots/i,
    },
    {
      name: "disables a declared remote command that the Gateway has not enabled",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 1 },
      invocableCommands: [],
      disabled: true,
      reason: /enable|approv/i,
    },
  ])(
    "$name in the New Session picker",
    ({ devicePlacement, workerSlots, invocableCommands, disabled, reason }) => {
      const state = resolveWhereChip({
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: true,
            workerSlots,
            capabilities: ["codex.exec-server.stdio.v1"],
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
      if (reason) {
        expect(device?.title).toMatch(reason);
      }
    },
  );
});
