import type { ScopeUpgradeResult } from "../../packages/gateway-protocol/src/index.js";
import { getPairedDevice, getPendingDevicePairing } from "../infra/device-pairing.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

const TERMINAL_GRACE_MS = 15_000;
const DURABLE_RECONCILE_INTERVAL_MS = 250;

type UpgradeOwner = {
  deviceId: string;
  publicKey: string;
};

type UpgradeEntry = {
  requestId: string;
  owner: UpgradeOwner;
  requestedScopes: string[];
  initialToken?: string;
  initialApprovedAtMs?: number;
  expiresAtMs: number;
  resolutionHint?: "approved" | "rejected";
  resultPromise?: Promise<ScopeUpgradeResult | null>;
  wake: Deferred;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

function sameOwner(left: UpgradeOwner, right: UpgradeOwner): boolean {
  return left.deviceId === right.deviceId && left.publicKey === right.publicKey;
}

function scheduleUnref(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

/** Coordinates live device scope-upgrade waiters with the durable pairing store. */
export class ScopeUpgradeCoordinator {
  private readonly entries = new Map<string, UpgradeEntry>();
  private readonly work = new AsyncWorkScope();
  private lifetimeBound = false;

  private bindGatewayLifetime(): void {
    if (this.lifetimeBound || this.work.isClosing) {
      return;
    }
    this.lifetimeBound = true;
    // Construction is outside received work. The first registration captures
    // this Gateway, never a later waiter or an ordinary socket disconnect.
    const gatewaySignal = getAsyncWorkSignal();
    if (!gatewaySignal) {
      return;
    }
    if (gatewaySignal.aborted) {
      void this.close();
      return;
    }
    const signal = AbortSignal.any([gatewaySignal, this.work.signal]);
    void trackAsyncWork(
      () =>
        new Promise<void>((resolve, reject) => {
          // Fence synchronously: a previously queued poll wake must see close before
          // its microtask can start another read. The lifetime task joins the drain.
          signal.addEventListener(
            "abort",
            () => {
              void this.close().then(resolve, reject);
            },
            { once: true },
          );
        }),
    );
  }

  async close(): Promise<void> {
    this.work.beginClose();
    for (const entry of this.entries.values()) {
      clearTimeout(entry.cleanupTimer);
      entry.wake.resolve();
    }
    this.entries.clear();
    await this.work.drain();
  }

  register(params: {
    requestId: string;
    expiresAtMs: number;
    owner: UpgradeOwner;
    requestedScopes: string[];
    initialToken?: string;
    initialApprovedAtMs?: number;
  }): boolean {
    this.bindGatewayLifetime();
    if (this.work.isClosing) {
      return false;
    }
    const existing = this.entries.get(params.requestId);
    if (existing && !sameOwner(existing.owner, params.owner)) {
      return false;
    }
    const entry: UpgradeEntry = existing ?? {
      requestId: params.requestId,
      owner: params.owner,
      requestedScopes: [...params.requestedScopes],
      initialToken: params.initialToken,
      initialApprovedAtMs: params.initialApprovedAtMs,
      expiresAtMs: 0,
      wake: createDeferredCore(),
    };
    entry.requestedScopes = [...params.requestedScopes];
    entry.expiresAtMs = params.expiresAtMs;
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
    }
    entry.cleanupTimer = scheduleUnref(
      () => this.entries.delete(entry.requestId),
      Math.max(0, entry.expiresAtMs + TERMINAL_GRACE_MS - Date.now()),
    );
    this.entries.set(entry.requestId, entry);
    return true;
  }

  notify(requestId: string, resolution: "approved" | "rejected"): void {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return;
    }
    entry.resolutionHint = resolution;
    const wake = entry.wake;
    entry.wake = createDeferredCore();
    wake.resolve();
  }

  async wait(requestId: string, owner: UpgradeOwner): Promise<ScopeUpgradeResult | null> {
    const entry = this.entries.get(requestId);
    if (!entry || !sameOwner(entry.owner, owner)) {
      return null;
    }
    if (!entry.resultPromise) {
      const pending = this.work.track(() => this.waitForResult(entry));
      entry.resultPromise = pending;
      void pending.catch(() => {
        if (entry.resultPromise === pending) {
          entry.resultPromise = undefined;
        }
      });
    }
    return await entry.resultPromise;
  }

  private async waitForResult(entry: UpgradeEntry): Promise<ScopeUpgradeResult | null> {
    while (!this.work.isClosing) {
      if (Date.now() >= entry.expiresAtMs) {
        this.retainTerminal(entry);
        return { status: "expired", requestId: entry.requestId };
      }
      const wake = entry.wake;
      const result = await this.readDurableResult(entry);
      if (this.work.isClosing) {
        break;
      }
      if (result) {
        this.retainTerminal(entry);
        return result;
      }
      const delayMs = Math.min(
        DURABLE_RECONCILE_INTERVAL_MS,
        Math.max(0, entry.expiresAtMs - Date.now()),
      );
      const timer = scheduleUnref(wake.resolve, delayMs);
      try {
        await wake.promise;
      } finally {
        // A durable notification or close also owns cancellation of the losing timer.
        clearTimeout(timer);
        if (entry.wake === wake) {
          entry.wake = createDeferredCore();
        }
      }
    }
    return null;
  }

  private async readDurableResult(entry: UpgradeEntry): Promise<ScopeUpgradeResult | null> {
    const pending = await getPendingDevicePairing(entry.requestId);
    if (this.work.isClosing || pending) {
      return null;
    }
    if (entry.resolutionHint === "rejected") {
      return { status: "rejected", requestId: entry.requestId };
    }
    const paired = await getPairedDevice(entry.owner.deviceId);
    if (this.work.isClosing) {
      return null;
    }
    const token = paired?.tokens?.operator;
    const approvedEvidence =
      entry.resolutionHint === "approved" ||
      (token?.token !== entry.initialToken && paired?.approvedAtMs !== entry.initialApprovedAtMs);
    const approved =
      paired?.publicKey === entry.owner.publicKey &&
      token !== undefined &&
      token.revokedAtMs === undefined &&
      approvedEvidence &&
      roleScopesAllow({
        role: "operator",
        requestedScopes: entry.requestedScopes,
        allowedScopes: token.scopes,
      });
    return approved
      ? {
          status: "approved",
          requestId: entry.requestId,
          deviceToken: token.token,
          scopes: token.scopes,
        }
      : { status: "rejected", requestId: entry.requestId };
  }

  private retainTerminal(entry: UpgradeEntry): void {
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
    }
    entry.cleanupTimer = scheduleUnref(
      () => this.entries.delete(entry.requestId),
      TERMINAL_GRACE_MS,
    );
  }
}
