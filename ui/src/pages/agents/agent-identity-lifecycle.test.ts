/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import * as identityActions from "./identity-actions.ts";
import "./agents-page.ts";

type TestAgentsPage = HTMLElement &
  Parameters<typeof identityActions.resetIdentityDraft>[0] & {
    context: ApplicationContext;
    readonly connected: boolean;
    agentsSelectedId: string | null;
    saveIdentityDraft: () => void;
    gateway: {
      applySnapshot: (
        snapshot: ApplicationGatewaySnapshot,
        binding: { initial: boolean; sourceChanged: boolean },
      ) => void;
    };
  };

it.each(["saved", "disconnected"] as const)(
  "retires an identity save across a same-client reconnect: %s",
  async (outcome) => {
    const update = createDeferred();
    const request = vi.fn(async () => {
      await update.promise;
      if (outcome === "disconnected") {
        throw new Error("Connection closed");
      }
      return {};
    });
    const client = createTestGatewayClient(request);
    const snapshot: ApplicationGatewaySnapshot = {
      client,
      phase: "connected",
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      hello: gatewayHelloForMethods(["agents.update"]),
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const runExternalMutation: ApplicationContext["runtimeConfig"]["runExternalMutation"] = (
      task,
    ) =>
      task(client).then(
        (value) => ({ ok: true as const, value, refresh: { ok: true as const } }),
        (error: unknown) => ({
          ok: false as const,
          reason: "unavailable" as const,
          error: String(error),
        }),
      );
    page.context = {
      gateway: { snapshot },
      agents: { refreshList: async () => undefined },
      agentIdentity: { invalidate: () => undefined, ensure: async () => undefined },
      runtimeConfig: { runExternalMutation },
    } as unknown as ApplicationContext;
    const setConnected = (connected: boolean) =>
      page.gateway.applySnapshot(
        { ...snapshot, phase: connected ? "connected" : "stopped" },
        { initial: false, sourceChanged: false },
      );
    setConnected(true);
    page.agentsSelectedId = "main";
    page.identityDraft.name = "Agent Smith";

    const save = vi.spyOn(identityActions, "saveIdentityDraft");
    page.saveIdentityDraft();
    const pendingSave = save.mock.results[0]?.value;
    save.mockRestore();
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const savingBeforeDisconnect = page.identitySaving;
    setConnected(false);
    setConnected(true);
    const savingAfterReconnect = page.identitySaving;
    update.resolve();
    await pendingSave;

    expect(savingBeforeDisconnect).toBe(true);
    expect(request).toHaveBeenCalledWith("agents.update", {
      agentId: "main",
      name: "Agent Smith",
    });
    expect(savingAfterReconnect).toBe(false);
    expect(page.connected).toBe(true);
    expect(page.identitySaving).toBe(false);
    expect(page.identityDraft.name).toBe("Agent Smith");
  },
);
