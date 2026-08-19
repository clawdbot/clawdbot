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

  it("moves an active placement to the Gateway with exact-source facts", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { profiles: [], environments: [] };
      }
      if (method === "node.list") {
        return { nodes: [] };
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
      expect(document.body.textContent).toContain("The active turn will be interrupted");
    });
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
      target: { kind: "gateway" },
    });
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
      if (method === "node.list") {
        return { nodes: [] };
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

  it("disables paired-device moves for a runtime that cannot dispatch there", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { profiles: [], environments: [] };
      }
      if (method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "build-mac",
              displayName: "Build Mac",
              connected: true,
              commands: ["system.run"],
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
        id: "codex",
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
    expect(device?.textContent).toContain("Needs the embedded runtime");
    expect(device?.title).toBe("Needs the embedded runtime");
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await moving;

    expect(request).not.toHaveBeenCalledWith("sessions.move", expect.anything());
  });

  it("moves an embedded-runtime session to a paired device", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { profiles: [], environments: [] };
      }
      if (method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "build-mac",
              displayName: "Build Mac",
              connected: true,
              commands: ["system.run"],
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
        id: "openclaw",
        cloudPlacementSupported: true,
        devicePlacementSupported: true,
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
