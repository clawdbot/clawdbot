/* @vitest-environment jsdom */

import { render } from "lit";
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
import {
  activePlacementSession,
  offlineDeviceSession,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { renderChatPanePlacement } from "./components/chat-pane-placement.ts";

let restoreDialogPolyfill: () => void;
beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
});
afterEach(() => {
  document.body.replaceChildren();
  restoreDialogPolyfill();
  vi.unstubAllGlobals();
});

const placementTiming = { generation: 1, createdAtMs: 1, updatedAtMs: 1, stateChangedAtMs: 1 };
const workerPlacement = {
  ...placementTiming,
  providerId: "device-service",
  profileId: "device-profile",
  environmentId: "node:device-looking-id",
};

describe.each([
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
] as const satisfies readonly NonNullable<GatewaySessionRow["placement"]>[])(
  "$state placement stop presentation",
  (placement) => {
    const phase = placement.state;
    it.each([
      {
        startupPhase: phase,
        targetKind: "device",
        label: "device worker",
        location: "Runs on device",
      },
      {
        startupPhase: phase,
        targetKind: "auto-device",
        label: "device worker",
        location: "Runs on device",
      },
      {
        startupPhase: phase,
        targetKind: "profile",
        label: "cloud worker",
        location: "device-service · device-profile",
      },
      { startupPhase: phase, targetKind: undefined, label: "worker", location: "Runs on worker" },
      { startupPhase: "failed", targetKind: "device", label: "worker", location: "Runs on worker" },
      {
        startupPhase: "failed",
        targetKind: "auto-device",
        label: "worker",
        location: "Runs on worker",
      },
      {
        startupPhase: "failed",
        targetKind: "profile",
        label: "worker",
        location: "Runs on worker",
      },
    ] as const)(
      "projects $startupPhase $targetKind intent into menu and confirmation",
      async ({ startupPhase, targetKind, label, location }) => {
        const request = vi.fn(async () => ({ ok: true }));
        const refreshReplacement = vi.fn(async () => undefined);
        const { pane } = createTestChatPane({
          client: { request } as unknown as GatewayBrowserClient,
          sessions: { refreshReplacement } as unknown as SessionCapability,
        });
        const session: GatewaySessionRow = {
          key: "agent:main:startup",
          label: "Startup session",
          kind: "direct",
          updatedAt: 1,
          placement,
        };
        vi.mocked(pane.context.placementStartup.get).mockImplementation((key) =>
          key === session.key && targetKind
            ? { sessionKey: key, phase: startupPhase, startedAt: 1, targetKind }
            : null,
        );
        const container = document.createElement("div");
        document.body.append(container);
        render(
          renderChatPanePlacement({
            session,
            placementStartupStatus: pane.context.placementStartup.get(session.key),
          }),
          container,
        );
        const chipText = container.querySelector(".chat-pane__placement-chip")?.textContent;
        const menuText = container
          .querySelector(".chat-pane__placement-reclaim")
          ?.textContent?.trim();

        const reclaim = pane.reclaimHeaderPlacement(session);
        const actions = await waitForConfirmDialogActions();
        const confirmation = document.querySelector("openclaw-modal-dialog")?.textContent;
        answerConfirmDialog(actions, "confirm");
        await reclaim;
        expect(request).toHaveBeenCalledExactlyOnceWith(
          "sessions.reclaim",
          { key: session.key, agentId: "main" },
          { timeoutMs: null },
        );
        expect(pane.context.placementStartup.pause).toHaveBeenCalledBefore(request);
        expect({ chipText, menuText, confirmation }).toEqual({
          chipText:
            targetKind === "profile" && phase === "requested" && startupPhase !== "failed"
              ? "Runs on Cloud"
              : location,
          menuText: `Stop ${label}…`,
          confirmation: expect.stringContaining(`Stop the ${label} for "Startup session"?`),
        });
      },
    );
  },
);

describe("chat pane worker stop", () => {
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
      restarting: false,
      moveDisabledReason: "This Gateway does not support this session action.",
      reclaimDisabledReason: undefined,
      restartDisabledReason: "This Gateway does not support this session action.",
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: session.key, agentId: "main" },
      { timeoutMs: null },
    );
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
      if (runner === "device") {
        session.placement.runner = { kind: "device", status: "available" };
      }
      vi.mocked(pane.context.placementStartup.get).mockReturnValue({
        sessionKey: session.key,
        phase: startupPhase,
        startedAt: 1,
        targetKind: runner === "device" ? "profile" : "device",
      });

      const reclaim = pane.reclaimHeaderPlacement(session);
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
    const request = vi.fn(async () => ({ ok: true }));
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
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

    const reclaim = pane.reclaimHeaderPlacement(session);
    const actions = await waitForConfirmDialogActions();
    answerConfirmDialog(actions, "cancel");
    await reclaim;

    expect(request).not.toHaveBeenCalled();
    expect(pane.context.placementStartup.pause).not.toHaveBeenCalled();
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

    const reclaim = pane.reclaimHeaderPlacement(session);
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
