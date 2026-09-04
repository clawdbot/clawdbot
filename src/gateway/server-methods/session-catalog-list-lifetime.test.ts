import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogListProviderParams } from "../../plugins/session-catalog.js";
import {
  getActiveGatewayRootWorkCount,
  getGatewayRestartDrainSignal,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";

const host: SessionCatalogHost = {
  hostId: "node:late",
  kind: "node",
  label: "Late host",
  connected: true,
  sessions: [],
};
const catalog = {
  id: "fixture",
  label: "Fixture",
  capabilities: { continueSession: false, archive: false },
  hosts: [host],
};

describe("catalog list completion ownership", () => {
  it("keeps work started before retirement owned when registration follows an await", async () => {
    const before = getActiveGatewayRootWorkCount();
    const root = tryBeginGatewayRootWorkAdmission("catalog-register-after-retirement");
    expect(root).not.toBeNull();
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const releaseListing = createDeferredCore();
    const releaseWork = createDeferredCore();
    const publish = vi.fn();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    const listing = root!.run(() =>
      lifetime.runProvider(publish, async (params) => {
        signal = params.signal;
        publication = releaseWork.promise.then(() => params.onHost(host));
        await releaseListing.promise;
        params.waitUntil(publication);
      }),
    );
    try {
      lifetime.retire();
      releaseListing.resolve();
      await expect(listing).resolves.toBeUndefined();
      root!.release();
      lifetime.finishListing();
      expect(signal?.aborted).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
      releaseWork.resolve();
      await publication;
      expect(publish).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(before);
    } finally {
      releaseListing.resolve();
      releaseWork.resolve();
      await Promise.allSettled([listing, publication]);
      lifetime.finishListing();
      root!.release();
    }
  });

  it("closes zero-background callbacks and completion registration with the list", async () => {
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const publish = vi.fn();
    let retained: SessionCatalogListProviderParams | undefined;
    await lifetime.runProvider(publish, async (params) => {
      retained = params;
      params.onHost(host);
      return [];
    });
    lifetime.finishListing();
    retained?.onHost?.(host);
    expect(publish).toHaveBeenCalledOnce();
    expect(() => retained?.waitUntil?.(Promise.resolve())).toThrow(/registration is closed/);
    expect(retained?.signal?.aborted).toBe(true);
  });

  it.each([false, true])(
    "retains the admitted root through the full publication chain (throws=%s)",
    async (throws) => {
      const before = getActiveGatewayRootWorkCount();
      const root = tryBeginGatewayRootWorkAdmission("catalog-test");
      expect(root).not.toBeNull();
      const lifetime = new SessionCatalogListLifetime(() => true, []);
      lifetime.subscribe(
        "active",
        () => undefined,
        () => true,
      );
      const release = createDeferredCore();
      let publication: Promise<void> | undefined;
      let retained: SessionCatalogListProviderParams | undefined;
      const publish = vi.fn(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
        if (throws) {
          throw new Error("publication failed");
        }
      });
      try {
        await root!.run(() =>
          lifetime.runProvider(publish, async (params) => {
            retained = params;
            publication = release.promise.then(() => params.onHost(host));
            params.waitUntil(publication);
            return [];
          }),
        );
        root!.release();
        lifetime.finishListing();
        expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
        expect(retained?.signal?.aborted).toBe(false);
        release.resolve();
        await publication?.catch(() => undefined);
        expect(publish).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(before);
        retained?.onHost?.(host);
        expect(publish).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await publication?.catch(() => undefined);
        lifetime.finishListing();
        root!.release();
      }
    },
  );

  it("disconnects subscribers without cancelling the native discovery", async () => {
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const connection = new AbortController();
    const disconnected = vi.fn();
    const live = vi.fn();
    lifetime.subscribe("old", disconnected, () => true, connection.signal);
    lifetime.subscribe("live", live, () => true);
    const release = createDeferredCore();
    let publication: Promise<void> | undefined;
    let producerSignal: AbortSignal | undefined;
    try {
      await lifetime.runProvider(
        () => lifetime.publish(catalog, new Map()),
        async (params) => {
          producerSignal = params.signal;
          publication = release.promise.then(() => params.onHost(host));
          params.waitUntil(publication);
        },
      );
      lifetime.finishListing();
      connection.abort();
      expect(producerSignal?.aborted).toBe(false);
      release.resolve();
      await publication;
      expect(disconnected).not.toHaveBeenCalled();
      expect(live).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await publication;
      lifetime.finishListing();
    }
  });

  it("joins native completion when the Gateway starts draining", async () => {
    const root = tryBeginGatewayRootWorkAdmission("catalog-drain-test");
    expect(root).not.toBeNull();
    const lifetime = new SessionCatalogListLifetime(() => true, [getGatewayRestartDrainSignal()]);
    lifetime.subscribe(
      "active",
      () => undefined,
      () => true,
    );
    const publish = vi.fn();
    let publication: Promise<void> | undefined;
    try {
      await root!.run(() =>
        lifetime.runProvider(publish, async (params) => {
          publication = new Promise<void>((resolve) => {
            params.signal.addEventListener("abort", () => resolve(), { once: true });
          }).then(() => params.onHost(host));
          params.waitUntil(publication);
        }),
      );
      root!.release();
      lifetime.finishListing();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      markGatewayRestartDraining();
      expect(tryBeginGatewayRootWorkAdmission("after-drain")).toBeNull();
      await publication;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      lifetime.retire();
      await publication;
      lifetime.finishListing();
      root!.release();
      resetGatewayWorkAdmission();
    }
  });

  it("releases the final subscriber's publisher while keeping native completion owned", async () => {
    const before = getActiveGatewayRootWorkCount();
    const root = tryBeginGatewayRootWorkAdmission("catalog-last-subscriber");
    expect(root).not.toBeNull();
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const connection = new AbortController();
    const listener = vi.fn();
    lifetime.subscribe("only", listener, () => true, connection.signal);
    const publishSnapshot = vi.fn(() => lifetime.publish(catalog, new Map()));
    const release = createDeferredCore();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    try {
      await root!.run(() =>
        lifetime.runProvider(publishSnapshot, async (params) => {
          signal = params.signal;
          publication = release.promise.then(() => params.onHost(host));
          params.waitUntil(publication);
        }),
      );
      root!.release();
      lifetime.finishListing();
      connection.abort();
      expect(signal?.aborted).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
      release.resolve();
      await publication;
      expect(publishSnapshot).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(before);
    } finally {
      release.resolve();
      await publication;
      lifetime.finishListing();
      root!.release();
    }
  });

  it.each(["signal", "aggregate-failure", "provider-failure"] as const)(
    "retires delivery on %s without declaring an ignoring producer finished",
    async (retirement) => {
      const before = getActiveGatewayRootWorkCount();
      const root = tryBeginGatewayRootWorkAdmission("catalog-retirement-test");
      expect(root).not.toBeNull();
      const controller = new AbortController();
      const lifetime = new SessionCatalogListLifetime(() => true, [controller.signal]);
      lifetime.subscribe(
        "active",
        () => undefined,
        () => true,
      );
      const publish = vi.fn();
      const release = createDeferredCore();
      let publication: Promise<void> | undefined;
      let signal: AbortSignal | undefined;
      try {
        const listing = root!.run(() =>
          lifetime.runProvider(publish, async (params) => {
            signal = params.signal;
            publication = release.promise.then(() => params.onHost(host));
            params.waitUntil(publication);
            if (retirement === "provider-failure") {
              throw new Error("provider failed");
            }
          }),
        );
        if (retirement === "provider-failure") {
          await expect(listing).rejects.toThrow("provider failed");
        } else {
          await listing;
        }
        root!.release();
        lifetime.finishListing();
        if (retirement === "signal") {
          controller.abort();
        } else if (retirement === "aggregate-failure") {
          lifetime.retire(new Error("response failed"));
        }
        expect(signal?.aborted).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
        release.resolve();
        await publication;
        expect(publish).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(before);
      } finally {
        release.resolve();
        await publication;
        lifetime.finishListing();
        root!.release();
      }
    },
  );
});
