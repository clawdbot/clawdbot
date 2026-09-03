import type { ScopeUpgradeResult } from "../../packages/gateway-protocol/src/index.js";
import { getPairedDevice, getPendingDevicePairing } from "../infra/device-pairing.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

const TERMINAL_GRACE_MS = 15_000;
const DURABLE_RECONCILE_INTERVAL_MS = 250;

type UpgradeOwner = {
  deviceId: string;
  publicKey: string;
};

type UpgradeWake = {
  promise: Promise<void>;
  resolve: () => void;
};

type UpgradeEntry = {
  requestId: string;
  owner: UpgradeOwner;
  requestedScopes: string[];
  initialToken?: string;
  initialApprovedAtMs?: number;
  expiresAtMs: number;
  resolutionHint?: "approved" | "rejected";
  resultPromise?: Promise<ScopeUpgradeResult>;
  wake: UpgradeWake;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

function createUpgradeWake(): UpgradeWake {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  register(params: {
    requestId: string;
    expiresAtMs: number;
    owner: UpgradeOwner;
    requestedScopes: string[];
    initialToken?: string;
    initialApprovedAtMs?: number;
  }): boolean {
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
      wake: createUpgradeWake(),
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
    entry.wake = createUpgradeWake();
    wake.resolve();
  }

  async wait(requestId: string, owner: UpgradeOwner): Promise<ScopeUpgradeResult | null> {
    const entry = this.entries.get(requestId);
    if (!entry || !sameOwner(entry.owner, owner)) {
      return null;
    }
    if (!entry.resultPromise) {
      const pending = this.waitForResult(entry);
      entry.resultPromise = pending;
      void pending.catch(() => {
        if (entry.resultPromise === pending) {
          entry.resultPromise = undefined;
        }
      });
    }
    return await entry.resultPromise;
  }

  private async waitForResult(entry: UpgradeEntry): Promise<ScopeUpgradeResult> {
    while (true) {
      const now = Date.now();
      if (now >= entry.expiresAtMs) {
        this.retainTerminal(entry);
        return { status: "expired", requestId: entry.requestId };
      }
      const wake = entry.wake.promise;
      const result = await this.readDurableResult(entry);
      if (result) {
        this.retainTerminal(entry);
        return result;
      }
      await Promise.race([
        wake,
        new Promise<void>((resolve) => {
          scheduleUnref(resolve, Math.min(DURABLE_RECONCILE_INTERVAL_MS, entry.expiresAtMs - now));
        }),
      ]);
    }
  }

  private async readDurableResult(entry: UpgradeEntry): Promise<ScopeUpgradeResult | null> {
    if (await getPendingDevicePairing(entry.requestId)) {
      return null;
    }
    if (entry.resolutionHint === "rejected") {
      return { status: "rejected", requestId: entry.requestId };
    }
    const paired = await getPairedDevice(entry.owner.deviceId);
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
