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

describe("chat pane placement", () => {
  it("does not reclaim a provisioning placement with a destroyable environment", async () => {
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
      reclaimingKey: null,
      row: session,
    });
    const dialogsBefore = document.body.querySelectorAll("openclaw-modal-dialog").length;
    await pane.reclaimHeaderPlacement(session);

    expect(placement).toEqual({
      reclaimDisabledReason: "This Gateway does not support this session action.",
    });
    expect(document.body.querySelectorAll("openclaw-modal-dialog")).toHaveLength(dialogsBefore);
    expect(request).not.toHaveBeenCalled();
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
      auth: { role: "operator", scopes: ["operator.admin"] },
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
      reclaimingKey: pane.headerPlacementReclaimingKey,
      row: sessionA,
    });
    const placementB = resolveChatPanePlacement({
      gatewaySnapshot: pane.context.gateway.snapshot,
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
