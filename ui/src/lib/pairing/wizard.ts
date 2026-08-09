// Transient Control UI pairing wizard. It orchestrates the Gateway's own
// connectivity inspection, canonical config compare-and-set, and browser-side
// endpoint proof; it never owns route, security, or restart policy itself.
import type {
  DevicePairConnectivityInspectResult,
  DevicePairConnectivityPlanResult,
  DevicePairSetupCodeResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  canProvePairingEndpoint,
  probePairingEndpoint,
  type PairingEndpointProbeResult,
} from "./endpoint-probe.ts";

export type PairingWizardAccess = "full" | "limited";
type PairingWizardRoute = "current" | "lan" | "public" | "tailscale";

type BlockedPlan = Extract<DevicePairConnectivityPlanResult, { status: "blocked" }>;
type ConfirmedPlan = Extract<DevicePairConnectivityPlanResult, { status: "confirmation-required" }>;
type PairingConfigWrite = NonNullable<ConfirmedPlan["configWrite"]>;

/** Why the operator has to finish or undo the change on the Gateway host. */
export type PairingWizardRecovery =
  | "restart-pending"
  | "endpoint-unproven"
  | "endpoint-unprovable"
  | "endpoint-mismatch"
  | "revert-conflict"
  | "revert-failed"
  | "revert-manual";

type PairingWizardNotice = "route-reverted";

export type PairingWizardStep =
  | { kind: "admin-required" }
  | { kind: "inspecting" }
  | { kind: "chooser"; inspection: DevicePairConnectivityInspectResult }
  | { kind: "public-url"; value: string; phase: "editing" | "checking" }
  | { kind: "public-url-rejected"; value: string; plan: BlockedPlan }
  | { kind: "public-url-unreachable"; value: string; probe: PairingEndpointProbeResult }
  | { kind: "lan-review"; plan: ConfirmedPlan }
  | { kind: "blocked"; plan: BlockedPlan }
  | { kind: "applying" }
  | { kind: "awaiting-restart" }
  | { kind: "verifying" }
  | { kind: "reverting" }
  | { kind: "conflict" }
  | { kind: "recovery"; reason: PairingWizardRecovery }
  | { kind: "issuing" }
  | { kind: "code"; setup: DevicePairSetupCodeResult }
  | { kind: "failed"; message: string };

export type PairingWizardSnapshot = {
  open: boolean;
  access: PairingWizardAccess;
  step: PairingWizardStep;
  notice: PairingWizardNotice | null;
};

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

/** Narrow view of the app's runtime config capability used for the LAN write. */
export type PairingConfigWriter = {
  /** Reloads the authoritative snapshot so the compare-and-set base is current. */
  refresh: () => Promise<void>;
  /** Hash of the loaded snapshot; the Gateway planner reports the same value. */
  readHash: () => string | null;
  /**
   * Writes only while the snapshot still hashes to `expectedHash`. The writer
   * drains queued writes before it dispatches, so this has to be rechecked
   * there: a drained autosave would otherwise rebase this patch onto a
   * configuration the operator never reviewed.
   */
  patch: (params: { raw: string; note: string; expectedHash: string }) => Promise<boolean>;
  readError: () => string | null;
};

export type PairingWizardDeps = {
  config: PairingConfigWriter;
  onChange: () => void;
  probe?: (url: string) => Promise<PairingEndpointProbeResult>;
  /** Whether this page is allowed to open the candidate at all. */
  canProve?: (url: string) => boolean;
  /** Budget for a restart that never drops this connection before re-inspection. */
  restartGraceMs?: number;
};

const DEFAULT_RESTART_GRACE_MS = 20_000;
const LAN_PATCH_NOTE = "Expose the Gateway on the local network for mobile pairing";
const LAN_REVERT_NOTE = "Restore the previous Gateway network exposure";
function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPairingWizard(deps: PairingWizardDeps) {
  const probe = deps.probe ?? ((url: string) => probePairingEndpoint(url));
  const canProve = deps.canProve ?? canProvePairingEndpoint;
  const restartGraceMs = deps.restartGraceMs ?? DEFAULT_RESTART_GRACE_MS;
  let client: GatewayRequestClient | null = null;
  let connected = false;
  let snapshot: PairingWizardSnapshot = {
    open: false,
    access: "full",
    step: { kind: "inspecting" },
    notice: null,
  };
  // Every async step captures this; a newer action, a close, or a Gateway swap
  // retires the older one so a late reply can never move the wizard backwards.
  let generation = 0;
  let route: PairingWizardRoute = "current";
  let publicUrl = "";
  let appliedWrite: PairingConfigWrite | null = null;
  // Hash the Gateway acknowledged for this wizard's own write. A revert is only
  // safe while it is still current; anything else is a concurrent config change.
  let appliedConfigHash: string | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRestartTimer = () => {
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const publish = (next: Partial<PairingWizardSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    deps.onChange();
  };

  const setStep = (step: PairingWizardStep, notice: PairingWizardNotice | null = null) => {
    publish({ step, notice });
  };

  const retire = () => {
    generation += 1;
    clearRestartTimer();
    return generation;
  };

  const isCurrent = (owned: number) => owned === generation && snapshot.open;

  const request = async <T>(method: string, params?: unknown): Promise<T | null> => {
    const active = client;
    return active && connected ? await active.request<T>(method, params) : null;
  };

  const fail = (owned: number, error: unknown) => {
    if (isCurrent(owned)) {
      setStep({ kind: "failed", message: formatFailure(error) });
    }
  };

  const inspect = async (owned: number) => {
    const result = await request<DevicePairConnectivityInspectResult>(
      "device.pair.connectivity.inspect",
    );
    return isCurrent(owned) ? result : null;
  };

  // `current` needs no plan: inspection already resolved the route it names.
  const planRoute = async (owned: number, mode: Exclude<PairingWizardRoute, "current">) => {
    const result = await request<DevicePairConnectivityPlanResult>(
      "device.pair.connectivity.plan",
      { mode, ...(mode === "public" ? { publicUrl } : {}) },
    );
    return isCurrent(owned) ? result : null;
  };

  const showChooser = async (owned: number, notice: PairingWizardNotice | null = null) => {
    route = "current";
    setStep({ kind: "inspecting" }, notice);
    try {
      const inspection = await inspect(owned);
      if (inspection) {
        setStep({ kind: "chooser", inspection }, notice);
      }
    } catch (error) {
      fail(owned, error);
    }
  };

  const issue = async (owned: number, provenUrls: readonly string[]) => {
    setStep({ kind: "issuing" });
    const setup = await request<DevicePairSetupCodeResult>("device.pair.setupCode", {
      ...(snapshot.access === "limited" ? { bootstrapProfile: "limited" as const } : {}),
      // Pin the planned route so no configured public, remote, or Tailscale
      // address can outrank the one this browser just proved.
      ...(route === "current" ? {} : { mode: route }),
      ...(route === "public" ? { publicUrl } : {}),
    });
    if (!isCurrent(owned) || !setup) {
      return;
    }
    // A configured device-pair public URL can outrank the route the operator
    // chose, so the issued code must advertise exactly what was proved here.
    const issuedUrls = setup.gatewayUrls ?? [setup.gatewayUrl];
    if (!issuedUrls.every((url) => provenUrls.includes(url))) {
      setStep({ kind: "recovery", reason: "endpoint-mismatch" });
      return;
    }
    // A plaintext route makes the Gateway downgrade the profile; adopt what it issued.
    publish({
      access: setup.access === "limited" ? "limited" : snapshot.access,
      step: { kind: "code", setup },
      notice: null,
    });
  };

  const revertChange = async (owned: number) => {
    const write = appliedWrite;
    if (!write) {
      setStep({ kind: "recovery", reason: "endpoint-unproven" });
      return;
    }
    if (write.revert.execution === "manual") {
      setStep({ kind: "recovery", reason: "revert-manual" });
      return;
    }
    setStep({ kind: "reverting" });
    await deps.config.refresh();
    if (!isCurrent(owned)) {
      return;
    }
    const expectedHash = appliedConfigHash;
    if (expectedHash === null || deps.config.readHash() !== expectedHash) {
      // Someone else moved the file after this write; an inverse patch here
      // would silently overwrite their change instead of undoing ours.
      setStep({ kind: "recovery", reason: "revert-conflict" });
      return;
    }
    const reverted = await deps.config.patch({
      raw: write.revert.patch,
      note: LAN_REVERT_NOTE,
      expectedHash,
    });
    if (!isCurrent(owned)) {
      return;
    }
    if (!reverted) {
      setStep({
        kind: "recovery",
        reason: deps.config.readHash() === expectedHash ? "revert-failed" : "revert-conflict",
      });
      return;
    }
    appliedWrite = null;
    appliedConfigHash = null;
    await showChooser(owned, "route-reverted");
  };

  /**
   * A setup code can advertise every candidate URL, and the phone may pick any
   * of them, so each one has to answer the challenge before it can be issued.
   */
  const proveThenIssue = async (owned: number, urls: readonly string[]) => {
    const proofs: PairingEndpointProbeResult[] =
      urls.length > 0 ? await Promise.all(urls.map((url) => probe(url))) : [];
    if (!isCurrent(owned)) {
      return;
    }
    // Fail closed on a partially reachable set: the Gateway may advertise every
    // candidate, and no token may be minted until each one has answered.
    if (urls.length > 0 && proofs.every((proof) => proof.status === "reachable")) {
      // The applied route is proven working; a later attempt must not undo it.
      appliedWrite = null;
      appliedConfigHash = null;
      await issue(owned, urls);
      return;
    }
    if (proofs.length > 0 && proofs.every((proof) => proof.status === "unprovable")) {
      setStep({ kind: "recovery", reason: "endpoint-unprovable" });
      return;
    }
    if (route === "public") {
      setStep({
        kind: "public-url-unreachable",
        value: publicUrl,
        probe: proofs[0] ?? { status: "unreachable" },
      });
      return;
    }
    await revertChange(owned);
  };

  /** Re-inspects, proves the candidate from this browser, and only then mints. */
  const verify = async (owned: number) => {
    setStep({ kind: "verifying" });
    try {
      const inspection = await inspect(owned);
      if (!inspection) {
        return;
      }
      if (route === "current") {
        const current = inspection.current;
        if (current.status !== "ready") {
          setStep({ kind: "recovery", reason: "endpoint-unproven" });
          return;
        }
        await proveThenIssue(owned, current.urls);
        return;
      }
      const planned = await planRoute(owned, route);
      if (!planned) {
        return;
      }
      if (planned.status === "blocked") {
        await revertChange(owned);
        return;
      }
      if (planned.changes.length > 0) {
        // The write committed, but the running Gateway has not adopted it yet.
        setStep({ kind: "recovery", reason: "restart-pending" });
        return;
      }
      await proveThenIssue(owned, planned.urls);
    } catch (error) {
      fail(owned, error);
    }
  };

  const awaitRestart = (owned: number) => {
    setStep({ kind: "awaiting-restart" });
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      // A hot-applied change never drops this socket; re-inspection is the only
      // authority on whether the new route exists. A still-down Gateway is
      // resumed by the reconnect path instead.
      if (connected) {
        void verify(owned);
      }
    }, restartGraceMs);
  };

  const chooseRoute = async (next: PairingWizardRoute) => {
    const owned = retire();
    route = next;
    if (next === "current") {
      await verify(owned);
      return;
    }
    if (next === "public") {
      setStep({ kind: "public-url", value: publicUrl, phase: "editing" });
      return;
    }
    setStep({ kind: "inspecting" });
    try {
      const planned = await planRoute(owned, next);
      if (!planned) {
        return;
      }
      if (planned.status === "blocked") {
        setStep({ kind: "blocked", plan: planned });
        return;
      }
      if (next === "tailscale") {
        // The Serve route is the operator's, not OpenClaw's: nothing is written
        // and nothing can be undone, so proof is all that stands before issuance.
        await proveThenIssue(owned, planned.urls);
        return;
      }
      if (!planned.urls.every((url) => canProve(url))) {
        // Refuse before any write: the change would restart the Gateway and
        // then fail its only verification, forcing a pointless revert.
        setStep({ kind: "recovery", reason: "endpoint-unprovable" });
        return;
      }
      setStep({ kind: "lan-review", plan: planned });
    } catch (error) {
      fail(owned, error);
    }
  };

  return {
    get snapshot(): PairingWizardSnapshot {
      return snapshot;
    },
    setConnection(next: { client: GatewayRequestClient | null; connected: boolean }) {
      const resumesRestart =
        !connected && next.connected && snapshot.step.kind === "awaiting-restart";
      client = next.client;
      connected = next.connected;
      if (resumesRestart) {
        clearRestartTimer();
        void verify(generation);
      }
    },
    /**
     * Every connectivity step is Gateway-admin only, so a pairing-only operator
     * opens straight into the review path instead of a failing inspection.
     */
    async open(options: { canAdmin: boolean }) {
      const owned = retire();
      route = "current";
      publicUrl = "";
      appliedWrite = null;
      appliedConfigHash = null;
      publish({
        open: true,
        access: "full",
        step: options.canAdmin ? { kind: "inspecting" } : { kind: "admin-required" },
        notice: null,
      });
      if (options.canAdmin) {
        await showChooser(owned);
      }
    },
    close() {
      retire();
      route = "current";
      publicUrl = "";
      appliedWrite = null;
      appliedConfigHash = null;
      publish({ open: false, access: "full", step: { kind: "inspecting" }, notice: null });
    },
    setAccess(access: PairingWizardAccess) {
      // Access belongs to the route choice, before any bearer credential exists.
      if (snapshot.access === access || snapshot.step.kind !== "chooser") {
        return;
      }
      publish({ access });
    },
    chooseRoute,
    setPublicUrl(value: string) {
      publicUrl = value;
      setStep({ kind: "public-url", value, phase: "editing" });
    },
    async submitPublicUrl() {
      const owned = retire();
      route = "public";
      setStep({ kind: "public-url", value: publicUrl, phase: "checking" });
      try {
        const planned = await planRoute(owned, "public");
        if (!planned) {
          return;
        }
        if (planned.status === "blocked") {
          setStep({ kind: "public-url-rejected", value: publicUrl, plan: planned });
          return;
        }
        await proveThenIssue(owned, planned.urls);
      } catch (error) {
        fail(owned, error);
      }
    },
    /** Applies the owner-produced patch; nothing is written before this call. */
    async confirmLan() {
      if (snapshot.step.kind !== "lan-review") {
        return;
      }
      const planned = snapshot.step.plan;
      const write = planned.configWrite;
      const owned = retire();
      if (!write) {
        // Nothing to change: the Gateway already serves this route.
        await verify(owned);
        return;
      }
      setStep({ kind: "applying" });
      try {
        await deps.config.refresh();
        if (!isCurrent(owned)) {
          return;
        }
        const expectedHash = planned.configHash;
        // No hash means there is nothing to compare and set against, and a
        // moved hash means another writer changed the file after the operator
        // saw these consequences. Both re-plan instead of writing blind.
        if (expectedHash === undefined || deps.config.readHash() !== expectedHash) {
          setStep({ kind: "conflict" });
          return;
        }
        const applied = await deps.config.patch({
          raw: write.patch,
          note: LAN_PATCH_NOTE,
          expectedHash,
        });
        if (!isCurrent(owned)) {
          return;
        }
        if (!applied) {
          if (!connected) {
            // The write raced the expected restart; re-inspection after
            // reconnect is the only authority on whether it landed.
            appliedWrite = write;
            awaitRestart(owned);
            return;
          }
          setStep(
            deps.config.readHash() === expectedHash
              ? {
                  kind: "failed",
                  message: deps.config.readError() ?? "The configuration change was not applied.",
                }
              : { kind: "conflict" },
          );
          return;
        }
        appliedWrite = write;
        appliedConfigHash = deps.config.readHash();
        if (planned.restartRequired) {
          awaitRestart(owned);
          return;
        }
        await verify(owned);
      } catch (error) {
        if (isCurrent(owned) && !connected) {
          appliedWrite = write;
          awaitRestart(owned);
          return;
        }
        fail(owned, error);
      }
    },
    async back() {
      const owned = retire();
      await showChooser(owned);
    },
  };
}

type PairingWizard = ReturnType<typeof createPairingWizard>;

/** Wizard verbs a host surface may invoke while the pairing dialog is open. */
export type PairingWizardActions = Pick<
  PairingWizard,
  "setAccess" | "chooseRoute" | "setPublicUrl" | "submitPublicUrl" | "confirmLan" | "back"
>;
