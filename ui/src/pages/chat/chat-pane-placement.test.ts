/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import {
  activePlacementSession,
  offlineDeviceSession,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;

beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});

afterEach(async () => {
  try {
    await dialogs.cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("chat pane placement", () => {
  it("shows authoritative device targets to writers and moves to the selected device", async () => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [{ id: "aws", providerId: "crabbox" }],
          environments: [
            {
              id: "node:runner",
              type: "node",
              label: "Writer runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
            {
              id: "node:saturated",
              type: "node",
              label: "Busy runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 0 },
            },
            {
              id: "node:offline",
              type: "node",
              label: "Offline runner",
              status: "unavailable",
              sessionHost: true,
            },
            {
              id: "node:nonhost",
              type: "node",
              label: "Hosting disabled",
              status: "available",
              sessionHost: false,
            },
          ],
        };
      }
      return { ok: true };
    });
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;
    const session = { ...activePlacementSession(), hasActiveRun: true };

    const moving = dialogs.track(pane.moveHeaderPlacement(session));
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-value="device:runner"]')).not.toBeNull();
    });
    expect(document.body.querySelector('[data-value="cloud:aws"]')).toBeNull();
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-value="device:saturated"]')?.disabled,
    ).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-value="device:offline"]')?.disabled,
    ).toBe(true);
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-value="device:nonhost"]')?.disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain("No worker slots are available");
    expect(document.body.textContent).toContain("Device unavailable");
    expect(document.body.textContent).toContain("Session hosting is disabled");
    document.body.querySelector<HTMLButtonElement>('[data-value="device:runner"]')?.click();
    const moveButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Move session",
    );
    expect(moveButton).toBeDefined();
    moveButton?.click();
    await moving;

    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: {
        generation: 1,
        environmentId: "worker:one",
        ownerEpoch: 1,
      },
      target: { kind: "device", deviceId: "runner" },
    });
    expect(request.mock.calls.some(([method]) => method === "node.list")).toBe(false);
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("moves an active placement to a selected profile machine", async () => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [
            {
              id: "aws",
              providerId: "crabbox",
              machines: [
                { id: "standard", label: "Standard", default: true },
                { id: "beast", label: "Beast" },
              ],
            },
          ],
          environments: [],
        };
      }
      return { ok: true };
    });
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: {
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      },
    } as never;
    const session = activePlacementSession();

    const moving = dialogs.track(pane.moveHeaderPlacement(session));
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    });
    document.body.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]')?.click();
    document.body.querySelector<HTMLButtonElement>('[data-value="machine:beast"]')?.click();
    const moveButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Move session",
    );
    moveButton?.click();
    await moving;

    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: {
        generation: 1,
        environmentId: "worker:one",
        ownerEpoch: 1,
      },
      target: { kind: "profile", profileId: "aws", machineClass: "beast" },
    });
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });

  it.each([
    {
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      compatibleSingleMode: "worker-only",
      incompatibleSingleMode: "remote-only",
    },
    {
      runtimeId: "codex",
      executionMode: "remote-exec",
      compatibleSingleMode: "remote-only",
      incompatibleSingleMode: "worker-only",
    },
  ] as const)(
    "moves $runtimeId to the same two-mode cloud profile while preserving machine selection",
    async ({ runtimeId, executionMode, compatibleSingleMode, incompatibleSingleMode }) => {
      const request = dialogs.mockRequest(async (method: string) => {
        if (method === "environments.list") {
          return {
            profiles: [
              {
                id: "lifecycle-only",
                providerId: "crabbox",
              },
              {
                id: "worker-only",
                providerId: "crabbox",
                executionMode: "worker-turn",
                executionModes: ["worker-turn"],
              },
              {
                id: "remote-only",
                providerId: "crabbox",
                executionMode: "remote-exec",
                executionModes: ["remote-exec"],
              },
              {
                id: "aws",
                providerId: "crabbox",
                executionMode: "worker-turn",
                executionModes: ["worker-turn", "remote-exec"],
                machines: [
                  { id: "standard", label: "Standard", default: true },
                  { id: "beast", label: "Beast" },
                ],
              },
            ],
            environments: [],
          };
        }
        return { ok: true };
      });
      const { pane } = createTestChatPane({
        client: { request } as unknown as GatewayBrowserClient,
        sessions: {
          refreshReplacement: vi.fn(async () => undefined),
        } as unknown as SessionCapability,
      });
      pane.context.gateway.snapshot.hello = {
        features: { methods: ["sessions.move"] },
        auth: { role: "operator", scopes: ["operator.admin", "operator.write"] },
      } as never;
      const session = {
        ...activePlacementSession(),
        agentRuntime: {
          id: runtimeId,
          cloudPlacementSupported: true,
          cloudPlacementExecutionMode: executionMode,
          source: "model",
        },
      } satisfies GatewaySessionRow;

      const moving = dialogs.track(pane.moveHeaderPlacement(session));
      await vi.waitFor(() => {
        expect(document.body.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
      });
      const incompatible = document.body.querySelector<HTMLButtonElement>(
        `[data-value="cloud:${incompatibleSingleMode}"]`,
      );
      expect(incompatible?.disabled).toBe(true);
      expect(incompatible?.title).toMatch(/compatible cloud worker|cannot use/i);
      const lifecycleOnly = document.body.querySelector<HTMLButtonElement>(
        '[data-value="cloud:lifecycle-only"]',
      );
      expect(lifecycleOnly?.disabled).toBe(true);
      expect(lifecycleOnly?.title).toMatch(/compatible cloud worker|cannot use/i);
      const compatibleSingle = document.body.querySelector<HTMLButtonElement>(
        `[data-value="cloud:${compatibleSingleMode}"]`,
      );
      expect(compatibleSingle?.disabled).toBe(false);
      const multiMode = document.body.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
      expect(multiMode?.disabled).toBe(false);
      multiMode?.click();
      document.body.querySelector<HTMLButtonElement>('[data-value="machine:beast"]')?.click();
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Move session")
        ?.click();
      await moving;

      expect(request).toHaveBeenCalledWith(
        "sessions.move",
        expect.objectContaining({
          target: {
            kind: "profile",
            profileId: "aws",
            machineClass: "beast",
          },
        }),
      );
    },
  );

  it("cancels offline-device continuation without opening a picker or sending an RPC", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;

    const moving = dialogs.track(pane.moveHeaderPlacement(offlineDeviceSession()));
    const actions = await waitForConfirmDialogActions();
    expect(document.body.textContent).toContain(
      "Unsynced device files and in-flight work may be lost",
    );
    expect(document.body.textContent).toContain("last Gateway-synced state");
    answerConfirmDialog(actions, "cancel");
    await moving;

    expect(request).not.toHaveBeenCalled();
  });

  it("continues an offline device placement on the Gateway with exact abandonment", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;
    const session = offlineDeviceSession();

    const moving = dialogs.track(pane.moveHeaderPlacement(session));
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await moving;

    expect(request).toHaveBeenCalledWith("sessions.move", {
      key: session.key,
      agentId: "main",
      expected: {
        generation: session.placement.generation,
        environmentId: session.placement.environmentId,
        ownerEpoch: session.placement.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
      abandonSource: true,
    });
    expect(request).not.toHaveBeenCalledWith("environments.list", expect.anything());
    expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("keeps the offline placement visible when continuation fails", async () => {
    const request = dialogs.mockRequest(async () => {
      throw new Error("device teardown is still pending; retry Continue on Gateway");
    });
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;
    const session = offlineDeviceSession();

    const moving = dialogs.track(pane.moveHeaderPlacement(session));
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await moving;

    expect(session.placement.runner).toEqual({ kind: "device", status: "offline" });
    expect(state.lastError).toContain("retry Continue on Gateway");
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("disables paired-device moves for a runtime that cannot dispatch there", async () => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [],
          environments: [
            {
              id: "node:build-mac",
              type: "node",
              label: "Build Mac",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
        };
      }
      return { ok: true };
    });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {
        refreshReplacement: vi.fn(async () => undefined),
      } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.admin", "operator.write"] },
    } as never;
    const session = {
      ...activePlacementSession(),
      agentRuntime: {
        id: "cloud-only",
        cloudPlacementSupported: true,
        devicePlacementSupported: false,
        source: "model",
      },
    } satisfies GatewaySessionRow;

    const moving = dialogs.track(pane.moveHeaderPlacement(session));
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-value="device:build-mac"]')).not.toBeNull();
    });
    const device = document.body.querySelector<HTMLButtonElement>(
      '[data-value="device:build-mac"]',
    );
    expect(device?.disabled).toBe(true);
    expect(device?.textContent).toContain("This runtime does not support paired devices");
    expect(device?.title).toBe("This runtime does not support paired devices");
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await moving;

    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
    expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });

  it.each([
    { runtimeId: "openclaw", executionMode: "worker-turn" },
    { runtimeId: "codex", executionMode: "remote-exec" },
  ] as const)(
    "moves a $runtimeId session to a supported paired device",
    async ({ runtimeId, executionMode }) => {
      const request = dialogs.mockRequest(async (method: string) => {
        if (method === "environments.list") {
          return {
            profiles: [],
            environments: [
              {
                id: "node:build-mac",
                type: "node",
                label: "Build Mac",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 1, available: 1 },
                invocableCommands: ["codex.exec-server.stdio.v1"],
              },
            ],
          };
        }
        return { ok: true };
      });
      const refreshReplacement = vi.fn(async () => undefined);
      const { pane } = createTestChatPane({
        client: { request } as unknown as GatewayBrowserClient,
        sessions: { refreshReplacement } as unknown as SessionCapability,
      });
      pane.context.gateway.snapshot.hello = {
        features: { methods: ["sessions.move"] },
        auth: { role: "operator", scopes: ["operator.admin", "operator.write"] },
      } as never;
      const session = {
        ...activePlacementSession(),
        agentRuntime: {
          id: runtimeId,
          cloudPlacementSupported: true,
          cloudPlacementExecutionMode: executionMode,
          devicePlacementSupported: true,
          devicePlacement:
            executionMode === "remote-exec"
              ? {
                  requiredNodeCommands: ["codex.exec-server.stdio.v1"],
                  consumesWorkerSlot: false,
                }
              : { requiredNodeCommands: [], consumesWorkerSlot: true },
          source: "model",
        },
      } satisfies GatewaySessionRow;

      const moving = dialogs.track(pane.moveHeaderPlacement(session));
      await vi.waitFor(() => {
        expect(document.body.querySelector('[data-value="device:build-mac"]')).not.toBeNull();
      });
      document.body.querySelector<HTMLButtonElement>('[data-value="device:build-mac"]')?.click();
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Move session")
        ?.click();
      await moving;

      expect(request).toHaveBeenCalledWith("sessions.move", {
        key: session.key,
        agentId: "main",
        expected: {
          generation: 1,
          environmentId: "worker:one",
          ownerEpoch: 1,
        },
        target: { kind: "device", deviceId: "build-mac" },
      });
      expect(refreshReplacement).toHaveBeenCalledWith("main");
      expect(request).not.toHaveBeenCalledWith("node.list", expect.anything());
    },
  );

  it.each([
    {
      name: "remote execution ignores saturated worker capacity when its command is enabled",
      runtimeId: "codex",
      executionMode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      availableSlots: 0,
      invocableCommands: ["codex.exec-server.stdio.v1"],
      disabled: false,
    },
    {
      name: "worker execution remains disabled at capacity",
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      availableSlots: 0,
      invocableCommands: [],
      disabled: true,
      reason: /worker slots/i,
    },
    {
      name: "declared remote execution remains disabled without Gateway command authority",
      runtimeId: "codex",
      executionMode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      availableSlots: 1,
      invocableCommands: [],
      disabled: true,
      reason: /enable|approv/i,
    },
  ] as const)("$name in the Move Session picker", async (scenario) => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [],
          environments: [
            {
              id: "node:build-mac",
              type: "node",
              label: "Build Mac",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: scenario.availableSlots },
              capabilities: ["codex.exec-server.stdio.v1"],
              invocableCommands: scenario.invocableCommands,
            },
          ],
        };
      }
      return { ok: true };
    });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {
        refreshReplacement: vi.fn(async () => undefined),
      } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.admin", "operator.write"] },
    } as never;
    const session = {
      ...activePlacementSession(),
      agentRuntime: {
        id: scenario.runtimeId,
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: scenario.executionMode,
        devicePlacementSupported: true,
        devicePlacement: {
          requiredNodeCommands: [...scenario.devicePlacement.requiredNodeCommands],
          consumesWorkerSlot: scenario.devicePlacement.consumesWorkerSlot,
        },
        source: "model",
      },
    } satisfies GatewaySessionRow;

    const moving = dialogs.track(pane.moveHeaderPlacement(session));
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-value="device:build-mac"]')).not.toBeNull();
    });
    const device = document.body.querySelector<HTMLButtonElement>(
      '[data-value="device:build-mac"]',
    );
    expect(device?.disabled).toBe(scenario.disabled);
    if (scenario.reason !== undefined) {
      expect(device?.title).toMatch(scenario.reason);
    }
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await moving;

    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });
});
