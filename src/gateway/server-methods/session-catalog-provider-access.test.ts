import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import {
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { listSessionCatalogProvider } from "./session-catalog-provider-access.js";

describe("session catalog provider admission", () => {
  it("preserves the queued caller's plugin scope and retained Gateway root", async () => {
    resetGatewayWorkAdmission();
    const predecessor = tryBeginGatewayRootWorkAdmission("catalog-predecessor")!;
    const requester = tryBeginGatewayRootWorkAdmission("catalog-requester")!;
    const firstRegistry = createEmptyPluginRegistry();
    const queuedRegistry = createEmptyPluginRegistry();
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const blocker: SessionCatalogProvider = {
      id: "blocking-catalog",
      label: "Blocking catalog",
      list: vi.fn(() => gate.promise),
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    };
    let observedScope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
    const retained: { release: (() => void) | null } = { release: null };
    const queued: SessionCatalogProvider = {
      ...blocker,
      id: "queued-catalog",
      list: vi.fn(async () => {
        observedScope = getPluginRuntimeGatewayRequestScope();
        retained.release = retainGatewayRootWorkAdmissionContinuation();
        return [];
      }),
    };
    const active = predecessor.run(async () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: firstRegistry, pluginId: "first-owner", isWebchatConnect: () => false },
        () => Promise.all(Array.from({ length: 4 }, () => listSessionCatalogProvider(blocker, {}))),
      ),
    );
    const pending = requester.run(async () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: queuedRegistry, pluginId: "queued-owner", isWebchatConnect: () => false },
        () => listSessionCatalogProvider(queued, {}),
      ),
    );
    try {
      expect(blocker.list).toHaveBeenCalledTimes(4);
      expect(queued.list).not.toHaveBeenCalled();
      gate.resolve([]);
      await Promise.all([active, pending]);

      expect(queued.list).toHaveBeenCalledOnce();
      expect.soft(observedScope?.pluginRegistry).toBe(queuedRegistry);
      expect.soft(observedScope?.pluginId).toBe("queued-owner");
      expect(retained.release).not.toBeNull();
      predecessor.release();
      requester.release();
      expect(getActiveGatewayRootWorkHolders()).toEqual(["catalog-requester"]);
    } finally {
      gate.resolve([]);
      await Promise.allSettled([active, pending]);
      retained.release?.();
      predecessor.release();
      requester.release();
      resetGatewayWorkAdmission();
    }
  });

  it("skips a retired queued provider and continues with the next live request", async () => {
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const blocker: SessionCatalogProvider = {
      id: "blocking-catalog",
      label: "Blocking catalog",
      list: vi.fn(() => gate.promise),
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    };
    const queued = { ...blocker, id: "retired-catalog", list: vi.fn(async () => []) };
    const successor = { ...blocker, id: "live-catalog", list: vi.fn(async () => []) };
    const active = Array.from({ length: 4 }, () => listSessionCatalogProvider(blocker, {}));
    const owner = new AbortController();
    const rejected = listSessionCatalogProvider(queued, { signal: owner.signal });
    const observed = rejected.then(
      (hosts) => ({ hosts }),
      (error: unknown) => ({ error }),
    );
    const next = listSessionCatalogProvider(successor, {});
    try {
      expect(blocker.list).toHaveBeenCalledTimes(4);
      expect(queued.list).not.toHaveBeenCalled();
      expect(successor.list).not.toHaveBeenCalled();
      const retirement = new Error("catalog owner retired");
      owner.abort(retirement);

      gate.resolve([]);

      expect(await observed).toEqual({ error: retirement });
      expect(queued.list).not.toHaveBeenCalled();
      expect(await next).toEqual([]);
      expect(successor.list).toHaveBeenCalledOnce();
    } finally {
      gate.resolve([]);
      await Promise.allSettled([...active, rejected, next]);
    }
  });
});
