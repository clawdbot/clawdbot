/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import {
  resolveChatPanePlacement,
  resolveChatPaneWorkerPresentation,
} from "./chat-pane-placement.ts";
import {
  activePlacementSession,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  offlineDeviceSession,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { renderChatPanePlacement } from "./components/chat-pane-placement.ts";

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

const placementTiming = { generation: 1, createdAtMs: 1, updatedAtMs: 1, stateChangedAtMs: 1 };
const workerPlacement = {
  ...placementTiming,
  providerId: "device-service",
  profileId: "device-profile",
  environmentId: "node:device-looking-id",
};

const startupPlacements = [
  { state: "requested", ...placementTiming },
  { state: "provisioning", ...workerPlacement },
  { state: "syncing", ...workerPlacement, workerBundleHash: "a".repeat(64) },
  {
    state: "starting",
    ...workerPlacement,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "base",
    remoteWorkspaceDir: "/workspace",
  },
] as const satisfies readonly NonNullable<GatewaySessionRow["placement"]>[];

const deviceCopy = {
  label: "Runs on device",
  stopLabel: "Stop device worker…",
  confirmMessage: 'Stop the device worker for "Startup session"?',
  confirmLabel: "Stop device worker",
};
const cloudCopy = {
  label: "Runs on Cloud",
  stopLabel: "Stop cloud worker…",
  confirmMessage: 'Stop the cloud worker for "Startup session"?',
  confirmLabel: "Stop worker",
};
const unknownCopy = {
  label: "Runs on worker",
  stopLabel: "Stop worker…",
  confirmMessage: 'Stop the worker for "Startup session"?',
  confirmLabel: "Stop worker",
};

function startupSession(placement: GatewaySessionRow["placement"]): GatewaySessionRow {
  return {
    key: "agent:main:startup",
    label: "Startup session",
    kind: "direct",
    updatedAt: 1,
    placement,
  };
}

describe.each([
  { placement: startupPlacements[0], cloudLabel: "Runs on Cloud" },
  { placement: startupPlacements[1], cloudLabel: "device-service · device-profile" },
  { placement: startupPlacements[2], cloudLabel: "device-service · device-profile" },
  { placement: startupPlacements[3], cloudLabel: "device-service · device-profile" },
])("$placement.state placement stop presentation", ({ placement, cloudLabel }) => {
  const phase = placement.state;
  it.each([
    { phase, targetKind: "device", copy: deviceCopy },
    { phase, targetKind: "auto-device", copy: deviceCopy },
    { phase, targetKind: "profile", copy: { ...cloudCopy, label: cloudLabel } },
    { phase, targetKind: undefined, copy: unknownCopy },
    { phase: "failed", targetKind: "device", copy: unknownCopy },
    { phase: "failed", targetKind: "auto-device", copy: unknownCopy },
    { phase: "failed", targetKind: "profile", copy: unknownCopy },
  ] as const)(
    "projects $phase $targetKind intent into operator copy",
    ({ phase: startupPhase, targetKind, copy }) => {
      expect(
        resolveChatPaneWorkerPresentation(
          startupSession(placement),
          targetKind ? { phase: startupPhase, targetKind } : null,
        ),
      ).toEqual(copy);
    },
  );
});

describe("chat pane worker stop", () => {
  it.each([
    { placement: startupPlacements[0], targetKind: "device", copy: deviceCopy },
    { placement: startupPlacements[1], targetKind: "auto-device", copy: deviceCopy },
    {
      placement: startupPlacements[2],
      targetKind: "profile",
      copy: { ...cloudCopy, label: "device-service · device-profile" },
    },
    { placement: startupPlacements[3], targetKind: undefined, copy: unknownCopy },
  ] as const)(
    "stops $placement.state $targetKind startup from the placement menu",
    async ({ placement, targetKind, copy }) => {
      const request = dialogs.mockRequest(async () => ({ ok: true }));
      const refreshReplacement = vi.fn(async () => undefined);
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture({ refreshReplacement }),
      });
      const session = startupSession(placement);
      const startup = targetKind
        ? { sessionKey: session.key, phase: placement.state, startedAt: 1, targetKind }
        : null;
      vi.mocked(pane.context.placementStartup.get).mockReturnValue(startup);
      const container = document.createElement("div");
      document.body.append(container);
      let reclaim: Promise<void> | undefined;
      render(
        renderChatPanePlacement({
          session,
          placementStartupStatus: startup,
          onPlacementReclaim: () => {
            reclaim = dialogs.track(pane.reclaimHeaderPlacement(session));
          },
        }),
        container,
      );
      expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
        copy.label,
      );
      const stop = container.querySelector<HTMLElement>(".chat-pane__placement-reclaim");
      expect(stop?.textContent?.trim()).toBe(copy.stopLabel);
      stop?.click();
      const actions = await waitForConfirmDialogActions();
      expect(document.querySelector("openclaw-modal-dialog")?.textContent).toContain(
        copy.confirmMessage,
      );
      expect(actions.querySelector(".btn.danger")?.textContent?.trim()).toBe(copy.confirmLabel);
      answerConfirmDialog(actions, "confirm");
      await reclaim;
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "sessions.reclaim",
        { key: session.key, agentId: "main" },
        { timeoutMs: null },
      );
      expect(pane.context.placementStartup.pause).toHaveBeenCalledBefore(request);
    },
  );

  it("disables offline Stop while keeping Continue enabled, then restores ordinary actions", () => {
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.move", "sessions.reclaim"],
      ["operator.read", "operator.write"],
    );
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
      restarting: false,
      moveDisabledReason: undefined,
      reclaimDisabledReason:
        "Reconnect the device to stop and sync its workspace, or Continue on Gateway.",
      restartDisabledReason: "This Gateway does not support this session action.",
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
      restarting: false,
      moveDisabledReason: undefined,
      reclaimDisabledReason: undefined,
      restartDisabledReason: "This Gateway does not support this session action.",
    });
  });

  it("does not issue reclaim for an offline device placement", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.read", "operator.write"],
    );

    await pane.reclaimHeaderPlacement({ ...offlineDeviceSession(), hasActiveRun: false });

    expect(request).not.toHaveBeenCalled();
    expect(document.body.querySelector("dialog[open]")).toBeNull();
  });

  it("enables only Stop for provisioning with reclaim-only write access", () => {
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.read", "operator.write"],
    );

    const session = startupSession(startupPlacements[1]);
    const placement = resolveChatPanePlacement({
      gatewaySnapshot: pane.context.gateway.snapshot,
      movingKey: null,
      reclaimingKey: null,
      row: session,
    });

    expect(placement).toEqual({
      moving: false,
      restarting: false,
      moveDisabledReason: "This Gateway does not support this session action.",
      reclaimDisabledReason: undefined,
      restartDisabledReason: "This Gateway does not support this session action.",
    });
  });

  it.each([
    { runner: "cloud", startupPhase: "starting" },
    { runner: "device", startupPhase: "starting" },
    { runner: "cloud", startupPhase: "failed" },
    { runner: "device", startupPhase: "failed" },
  ] as const)(
    "reclaims an active $runner placement with conflicting $startupPhase intent after the operator confirms",
    async ({ runner, startupPhase }) => {
      vi.stubGlobal(
        "confirm",
        vi.fn(() => {
          throw new Error("native confirm must not be used");
        }),
      );
      const request = dialogs.mockRequest(async () => ({ ok: true }));
      const refreshReplacement = vi.fn(async () => undefined);
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture({ refreshReplacement }),
      });
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["sessions.reclaim"],
        ["operator.read", "operator.write"],
      );
      const session = activePlacementSession();
      if (runner === "device") {
        session.placement.runner = { kind: "device", status: "available" };
      }
      vi.mocked(pane.context.placementStartup.get).mockReturnValue({
        sessionKey: session.key,
        phase: startupPhase,
        startedAt: 1,
        targetKind: runner === "device" ? "profile" : "device",
      });

      const reclaim = dialogs.track(pane.reclaimHeaderPlacement(session));
      const actions = await waitForConfirmDialogActions();
      const actionText = actions.textContent;
      const confirmation = document.body.querySelector("openclaw-modal-dialog")?.textContent;
      const pausesBeforeConfirmation = vi.mocked(pane.context.placementStartup.pause).mock.calls
        .length;
      answerConfirmDialog(actions, "confirm");
      await reclaim;

      expect(actionText).toContain(runner === "device" ? "Stop device worker" : "Stop worker");
      expect(confirmation).toContain(`Stop the ${runner} worker for "${session.key}"?`);
      expect(pausesBeforeConfirmation).toBe(0);
      expect(request).toHaveBeenCalledWith(
        "sessions.reclaim",
        { key: session.key, agentId: "main" },
        { timeoutMs: null },
      );
      expect(pane.context.placementStartup.pause).toHaveBeenCalledExactlyOnceWith(
        session.key,
        "Worker stop requested. Review the initial message before retrying.",
        expect.objectContaining({
          readSessionPlacementRecovery: expect.any(Function),
          pauseSessionPlacementRecovery: expect.any(Function),
        }),
      );
      expect(pane.context.placementStartup.pause).toHaveBeenCalledBefore(request);
      expect(refreshReplacement).toHaveBeenCalledWith("main");
    },
  );

  it("does not reclaim when the operator cancels", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
    const session = {
      ...activePlacementSession(),
      placement: {
        state: "requested",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
      },
    } satisfies GatewaySessionRow;
    vi.mocked(pane.context.placementStartup.get).mockReturnValue({
      sessionKey: session.key,
      phase: "requested",
      startedAt: 1,
      targetKind: "device",
    });

    const reclaim = dialogs.track(pane.reclaimHeaderPlacement(session));
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "cancel");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
    expect(pane.context.placementStartup.pause).not.toHaveBeenCalled();
  });

  it("does not reclaim after the connection changes while confirmation is open", async () => {
    const request = dialogs.mockRequest(async () => ({ ok: true }));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
    const session = {
      ...activePlacementSession(),
      placement: {
        state: "requested",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
      },
    } satisfies GatewaySessionRow;
    vi.mocked(pane.context.placementStartup.get).mockReturnValue({
      sessionKey: session.key,
      phase: "requested",
      startedAt: 1,
      targetKind: "device",
    });

    const reclaim = dialogs.track(pane.reclaimHeaderPlacement(session));
    const actions = await waitForConfirmDialogActions();
    pane.connectionGeneration += 1;
    answerConfirmDialog(actions, "confirm");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
    expect(pane.context.placementStartup.pause).not.toHaveBeenCalled();
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("publishes a reclaim failure for the current presentation", async () => {
    const request = dialogs.mockRequest(async () => {
      throw new Error("reclaim failed");
    });
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
    const session = activePlacementSession();

    const reclaim = dialogs.track(pane.reclaimHeaderPlacement(session));
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "confirm");
    await reclaim;

    expect(state.lastError).toBe("reclaim failed");
    expect(state.chatError).toBe(state.lastError);
  });

  it("does not publish a reclaim failure after leaving and returning", async () => {
    const response = createDeferred<{ ok: true }>();
    const request = dialogs.mockRequest(() => response.promise);
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
    const session = activePlacementSession();

    try {
      const reclaim = dialogs.track(pane.reclaimHeaderPlacement(session));
      const actions = await waitForConfirmDialogActions();
      answerConfirmDialog(actions, "confirm");
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      pane.presented = false;
      pane.presented = true;
      response.reject(new Error("stale reclaim failed"));
      await reclaim;

      expect(state.lastError).toBeNull();
      expect(state.chatError).toBeNull();
    } finally {
      response.resolve({ ok: true });
    }
  });

  it("keeps reclaim progress with its session when the pane switches rows", async () => {
    const response = createDeferred<{ ok: true }>();
    const request = dialogs.mockRequest(() => response.promise);
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture({ refreshReplacement }),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.reclaim"],
      ["operator.admin"],
    );
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

    try {
      const pendingReclaim = dialogs.track(pane.reclaimHeaderPlacement(sessionA));
      const actions = await waitForConfirmDialogActions();
      answerConfirmDialog(actions, "confirm");
      await vi.waitFor(() => expect(pane.headerPlacementReclaimingKey).toBe(sessionA.key));

      state.sessionKey = sessionB.key;
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

      response.resolve({ ok: true });
      await pendingReclaim;

      expect(pane.headerPlacementReclaimingKey).toBeNull();
    } finally {
      response.resolve({ ok: true });
    }
  });
});
