/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { resolveChatPanePlacement } from "./chat-pane-placement.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

let restoreDialogPolyfill: () => void;

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialogPolyfill();
  vi.unstubAllGlobals();
});

type ActivePlacement = Extract<NonNullable<GatewaySessionRow["placement"]>, { state: "active" }>;

function activePlacementSession(
  key = "agent:main:cloud",
): GatewaySessionRow & { placement: ActivePlacement } {
  return {
    key,
    kind: "direct",
    updatedAt: 0,
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      environmentId: "worker:one",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
    },
  };
}

function offlineDeviceSession(): GatewaySessionRow & { placement: ActivePlacement } {
  const session = activePlacementSession("agent:main:offline-device");
  return {
    ...session,
    label: "Offline device session",
    hasActiveRun: true,
    placement: {
      ...session.placement,
      runner: { kind: "device", status: "offline" },
    },
  };
}

describe("chat pane placement", () => {
  it("disables offline Stop while keeping Continue enabled, then restores ordinary actions", () => {
    const { pane } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move", "sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;
    const offline = { ...offlineDeviceSession(), hasActiveRun: false };
    const available = {
      ...offline,
      placement: {
        ...offline.placement,
        runner: { kind: "device" as const, status: "available" as const },
      },
    };

    expect(
      resolveChatPanePlacement({
        gatewaySnapshot: pane.context.gateway.snapshot,
        movingKey: null,
        reclaimingKey: null,
        row: offline,
      }),
    ).toEqual({
      moving: false,
      moveDisabledReason: undefined,
      reclaimDisabledReason:
        "Reconnect the device to stop and sync its workspace, or Continue on Gateway.",
    });
    expect(
      resolveChatPanePlacement({
        gatewaySnapshot: pane.context.gateway.snapshot,
        movingKey: null,
        reclaimingKey: null,
        row: available,
      }),
    ).toEqual({
      moving: false,
      moveDisabledReason: undefined,
      reclaimDisabledReason: undefined,
    });
  });

  it("does not issue reclaim for an offline device placement", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;

    await pane.reclaimHeaderPlacement({ ...offlineDeviceSession(), hasActiveRun: false });

    expect(request).not.toHaveBeenCalled();
    expect(document.body.querySelector("dialog[open]")).toBeNull();
  });

  it("reclaims a provisioning placement through its session", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;

    const session = {
      key: "agent:main:provisioning",
      kind: "direct",
      updatedAt: 0,
      placement: {
        state: "provisioning",
        environmentId: "worker:one",
      } as GatewaySessionRow["placement"],
    } satisfies GatewaySessionRow;
    const placement = resolveChatPanePlacement({
      gatewaySnapshot: pane.context.gateway.snapshot,
      movingKey: null,
      reclaimingKey: null,
      row: session,
    });
    const reclaim = pane.reclaimHeaderPlacement(session);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await reclaim;

    expect(placement).toEqual({
      moving: false,
      moveDisabledReason: "This Gateway does not support this session action.",
      reclaimDisabledReason: undefined,
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: session.key, agentId: "main" },
      { timeoutMs: 10 * 60_000 },
    );
  });

  it("reclaims an active placement after the operator confirms", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => {
        throw new Error("native confirm must not be used");
      }),
    );
    const request = vi.fn(async () => ({ ok: true }));
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;
    const session = activePlacementSession();

    const reclaim = pane.reclaimHeaderPlacement(session);
    const actions = await waitForConfirmDialogActions();
    expect(actions.textContent).toContain("Stop worker");
    answerConfirmDialog(actions, "confirm");
    await reclaim;

    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: session.key, agentId: "main" },
      { timeoutMs: 10 * 60_000 },
    );
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("shows authoritative device targets to writers and moves to the selected device", async () => {
    const request = vi.fn(async (method: string) => {
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

    const moving = pane.moveHeaderPlacement(session);
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
    const request = vi.fn(async (method: string) => {
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

    const moving = pane.moveHeaderPlacement(session);
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

  it("disables incompatible cloud execution modes while preserving compatible machine selection", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [
            {
              id: "worker-only",
              providerId: "crabbox",
              executionMode: "worker-turn",
            },
            {
              id: "remote-exec",
              providerId: "crabbox",
              executionMode: "remote-exec",
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
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec",
        source: "model",
      },
    } satisfies GatewaySessionRow;

    const moving = pane.moveHeaderPlacement(session);
    try {
      await vi.waitFor(() => {
        expect(document.body.querySelector('[data-value="cloud:worker-only"]')).not.toBeNull();
      });
      const incompatible = document.body.querySelector<HTMLButtonElement>(
        '[data-value="cloud:worker-only"]',
      );
      expect(incompatible?.disabled).toBe(true);
      expect(incompatible?.title).toMatch(/compatible cloud worker|cannot use/i);
      const compatible = document.body.querySelector<HTMLButtonElement>(
        '[data-value="cloud:remote-exec"]',
      );
      expect(compatible?.disabled).toBe(false);
      compatible?.click();
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
            profileId: "remote-exec",
            machineClass: "beast",
          },
        }),
      );
    } finally {
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Cancel")
        ?.click();
      await moving;
    }
  });

  it("cancels offline-device continuation without opening a picker or sending an RPC", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.move"] },
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never;

    const moving = pane.moveHeaderPlacement(offlineDeviceSession());
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
    const request = vi.fn(async () => ({ ok: true }));
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

    const moving = pane.moveHeaderPlacement(session);
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
    const request = vi.fn(async () => {
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

    const moving = pane.moveHeaderPlacement(session);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await moving;

    expect(session.placement.runner).toEqual({ kind: "device", status: "offline" });
    expect(state.lastError).toContain("retry Continue on Gateway");
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("disables paired-device moves for a runtime that cannot dispatch there", async () => {
    const request = vi.fn(async (method: string) => {
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

    const moving = pane.moveHeaderPlacement(session);
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
      const request = vi.fn(async (method: string) => {
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

      const moving = pane.moveHeaderPlacement(session);
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
    const request = vi.fn(async (method: string) => {
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

    const moving = pane.moveHeaderPlacement(session);
    try {
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
    } finally {
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Cancel")
        ?.click();
      await moving;
    }

    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it("does not reclaim when the operator cancels", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    const session = activePlacementSession();

    const reclaim = pane.reclaimHeaderPlacement(session);
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "cancel");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
  });

  it("does not reclaim after the connection changes while confirmation is open", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    const session = activePlacementSession();

    const reclaim = pane.reclaimHeaderPlacement(session);
    const actions = await waitForConfirmDialogActions();
    pane.connectionGeneration += 1;
    answerConfirmDialog(actions, "confirm");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("publishes a reclaim failure for the current presentation", async () => {
    const request = vi.fn(async () => {
      throw new Error("reclaim failed");
    });
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    const session = activePlacementSession();

    const reclaim = pane.reclaimHeaderPlacement(session);
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "confirm");
    await reclaim;

    expect(state.lastError).toBe("reclaim failed");
    expect(state.chatError).toBe(state.lastError);
  });

  it("does not publish a reclaim failure after leaving and returning", async () => {
    const response = createDeferred<never>();
    const request = vi.fn(() => response.promise);
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    const session = activePlacementSession();

    const reclaim = pane.reclaimHeaderPlacement(session);
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "confirm");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    pane.presented = false;
    pane.presented = true;
    response.reject(new Error("stale reclaim failed"));
    await reclaim;

    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("keeps reclaim progress with its session when the pane switches rows", async () => {
    let resolveRequest!: (result: { ok: true }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    const sessionA = activePlacementSession("agent:main:cloud-a");
    const sessionB = {
      ...sessionA,
      key: "agent:main:cloud-b",
      placement: {
        ...sessionA.placement,
        environmentId: "worker:two",
        remoteWorkspaceDir: "/worker/repo-b",
      },
    } satisfies GatewaySessionRow;

    const pendingReclaim = pane.reclaimHeaderPlacement(sessionA);
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "confirm");
    await vi.waitFor(() => expect(pane.headerPlacementReclaimingKey).toBe(sessionA.key));
    expect(pane.headerPlacementReclaimingKey).toBe(sessionA.key);

    state.sessionKey = sessionB.key;
    expect(state.sessionKey).toBe(sessionB.key);
    const placementA = resolveChatPanePlacement({
      gatewaySnapshot: pane.context.gateway.snapshot,
      movingKey: null,
      reclaimingKey: pane.headerPlacementReclaimingKey,
      row: sessionA,
    });
    const placementB = resolveChatPanePlacement({
      gatewaySnapshot: pane.context.gateway.snapshot,
      movingKey: null,
      reclaimingKey: pane.headerPlacementReclaimingKey,
      row: sessionB,
    });
    expect(placementA.reclaimDisabledReason).toBe(t("common.loading"));
    expect(placementB.reclaimDisabledReason).toBeUndefined();

    resolveRequest({ ok: true });
    await pendingReclaim;

    expect(pane.headerPlacementReclaimingKey).toBeNull();
  });
});
