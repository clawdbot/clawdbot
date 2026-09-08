import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import {
  clearFirstRunActivationReceipt,
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
  subscribeFirstRunActivationCleared,
  type FirstRunActivationReceipt,
  firstRunActivationDeadline,
} from "./first-run-activation-receipt.ts";
import { formatModelSetupError, type ModelSetupTaskResult } from "./model-setup-task-result.ts";
import {
  mapVerifyResult,
  type ModelSetupActivationState,
  type ModelSetupPageState,
  type ModelSetupVerifyState,
  type ModelSetupWizardResult,
} from "./state.ts";

export type ModelSetupConnection = Pick<
  ApplicationContext["gateway"]["snapshot"],
  "client" | "hello"
> & {
  agentId: string | null;
};

export function captureModelSetupConnection(
  context: ApplicationContext,
  firstRun: boolean,
  previousRecoveryScope: string | null = null,
) {
  const snapshot = context.gateway.snapshot;
  return {
    client: snapshot.client,
    hello: snapshot.hello,
    agentId: context.agentSelection.state.selectedId,
    connected: snapshot.phase === "connected",
    firstRun,
    connectionRevision: context.gateway.connectionRevision,
    // Hello owns authentication; retain its scope only while disconnected.
    recoveryScope:
      snapshot.phase === "connected"
        ? (snapshot.hello?.auth?.recoveryScope ?? null)
        : previousRecoveryScope,
  };
}

export type ModelSetupRouteData = { firstRun: boolean };

type SetupOutcome<T> = ModelSetupTaskResult<T> | undefined;

type FirstRunOwner = {
  generation: number;
  connectionRevision: number;
  recoveryScope: string | null;
  firstRun: boolean;
  connection: ModelSetupConnection;
};

type FirstRunActivation = {
  owner: FirstRunOwner;
  modelRef: string | null;
  kind: string;
  deadlineMs: number;
  receipt: FirstRunActivationReceipt | null;
  outcome: "pending" | "verified" | "rejected";
};

type FirstRunSetupHost = {
  context: () => ApplicationContext;
  routeData: () => ModelSetupRouteData | undefined;
  pageState: () => ModelSetupPageState;
  actionsDisabled: () => boolean;
  canUseSetup: (client: GatewayBrowserClient | null) => boolean;
  canVerify: (client: GatewayBrowserClient | null) => boolean;
  verify: () => Promise<SetupOutcome<SystemAgentSetupVerifyResult>>;
  setVerifyState: (state: ModelSetupVerifyState) => void;
  setActivationState: (state: ModelSetupActivationState) => void;
  setRefreshWarning: (warning: string | null) => void;
};

export class FirstRunSetup {
  private generation = 0;
  private started = false;
  private readyConnection: ModelSetupConnection | null = null;
  private pending: FirstRunActivation | null = null;

  constructor(private readonly host: FirstRunSetupHost) {}

  subscribe(notify: () => void): () => void {
    return subscribeFirstRunActivationCleared((receipt) => {
      // A new page can restore this receipt before the old session confirms cancellation.
      const activation = this.pending;
      if (activation?.receipt && JSON.stringify(activation.receipt) === receipt) {
        this.pending = null;
        if (activation.outcome === "verified") {
          this.host.setActivationState({ phase: "idle" });
        }
        this.host.setVerifyState({ phase: "idle" });
        notify();
      }
    });
  }

  setReadyConnection(connection: ModelSetupConnection | null): void {
    this.readyConnection = connection;
  }

  routeChanged(): void {
    const receipt = this.pending?.receipt ?? null;
    this.reset();
    this.readyConnection = null;
    this.pending = null;
    if (this.host.routeData()?.firstRun === false) {
      clearFirstRunActivationReceipt(receipt);
    }
  }

  connectionChanged(connection: ModelSetupConnection): void {
    this.reset();
    this.readyConnection = null;
    if (
      this.pending &&
      (!this.pending.owner.recoveryScope ||
        connection.agentId !== this.pending.owner.connection.agentId ||
        this.host.context().gateway.connectionRevision !== this.pending.owner.connectionRevision ||
        (this.host.context().gateway.snapshot.phase === "connected" &&
          (connection.hello?.auth?.recoveryScope ?? null) !== this.pending.owner.recoveryScope))
    ) {
      const receipt = this.pending.receipt;
      this.pending = null;
      clearFirstRunActivationReceipt(receipt);
    }
  }

  reconnectActivation(connection: ModelSetupConnection): void {
    const activation = this.pending;
    if (!activation) {
      return;
    }
    const context = this.host.context();
    if (
      !activation.owner.recoveryScope ||
      activation.owner.connectionRevision !== context.gateway.connectionRevision ||
      activation.owner.recoveryScope !== (connection.hello?.auth?.recoveryScope ?? null) ||
      activation.owner.connection.agentId !== connection.agentId ||
      activation.owner.firstRun !== this.host.routeData()?.firstRun
    ) {
      return;
    }
    activation.owner = this.owner(activation.owner.firstRun);
  }

  retryDetection(): boolean {
    if (this.host.actionsDisabled()) {
      return false;
    }
    if (this.pending && Date.now() < this.pending.deadlineMs) {
      this.host.setRefreshWarning(
        t("modelSetup.recovery.wait", { time: formatDateTimeMs(this.pending.deadlineMs) }),
      );
      // A read-only refresh can reveal a committed model without retiring the
      // unresolved activation receipt or permitting another provider mutation.
      return true;
    }
    if (this.host.routeData()?.firstRun) {
      const page = this.host.pageState();
      const retryingConfigured =
        this.pending && page.phase === "ready" && page.result.configuredModel;
      this.pending = null;
      clearFirstRunActivationReceipt();
      this.host.setRefreshWarning(null);
      this.reset();
      // Retrying an unresolved attempt does not make a later model pre-existing.
      this.started = Boolean(retryingConfigured);
    }
    return true;
  }

  dispose(): void {
    // Process/window disposal is exactly the lifecycle the transient receipt
    // protects; only an explicit route exit, retry, or terminal outcome clears it.
    this.reset();
    this.readyConnection = null;
    this.pending = null;
  }

  visiblePageState(verified: boolean): ModelSetupPageState {
    const page = this.host.pageState();
    return this.host.routeData()?.firstRun &&
      page.phase === "ready" &&
      page.result.setupComplete &&
      page.result.configuredModel &&
      !verified
      ? { ...page, result: { ...page.result, setupComplete: false } }
      : page;
  }

  start(): void {
    const routeData = this.host.routeData();
    const context = this.host.context();
    const snapshot = context.gateway.snapshot;
    const pageState = this.host.pageState();
    const readyConnection = this.readyConnection;
    if (
      !routeData?.firstRun ||
      this.started ||
      pageState.phase !== "ready" ||
      !readyConnection ||
      readyConnection.client !== snapshot.client ||
      readyConnection.hello !== snapshot.hello ||
      readyConnection.agentId !== context.agentSelection.state.selectedId ||
      this.host.actionsDisabled() ||
      !this.host.canUseSetup(snapshot.client)
    ) {
      return;
    }
    const receipt = readFirstRunActivationReceipt(context);
    if (this.pending?.receipt && receipt?.owner !== this.pending.receipt.owner) {
      this.pending = null;
    }
    const restored = receipt ?? this.pending;
    if (restored) {
      // Reconnection creates a new owner without reviving old response handles.
      this.pending = {
        owner: this.owner(routeData.firstRun),
        modelRef: restored.modelRef,
        kind: restored.kind,
        deadlineMs: restored.deadlineMs,
        receipt,
        outcome: "pending",
      };
    }
    // Detection is not consent. Only an existing, owner-bound activation receipt
    // may resume verification after reconnect; a fresh visit never tests or
    // activates even a configured or recommended model.
    if (!this.pending) {
      this.started = true;
      return;
    }
    const configured = pageState.result.setupComplete && pageState.result.configuredModel;
    if (this.pending && (!configured || !this.pending.modelRef)) {
      this.started = true;
      this.showUnresolved();
      return;
    }
    if (configured && !this.host.canVerify(snapshot.client)) {
      this.started = true;
      this.host.setVerifyState({
        phase: "failed",
        status: "unknown",
        error: `${t("modelSetup.access.gatewayTooOld")}. ${t("updates.confirm.action")}. ${t("desktop.reconnect")}.`,
      });
      return;
    }
    this.started = true;
    void this.run(this.owner(routeData.firstRun), pageState.result);
  }

  beginActivation(intent: { kind: string; modelRef?: string }): FirstRunActivation | null {
    const routeData = this.host.routeData();
    if (!routeData?.firstRun) {
      return null;
    }
    const owner = this.owner(routeData.firstRun);
    const receipt = persistFirstRunActivationReceipt(this.host.context(), intent);
    this.pending = {
      owner,
      kind: intent.kind,
      modelRef: intent.modelRef ?? null,
      receipt,
      outcome: "pending",
      deadlineMs: receipt?.deadlineMs ?? firstRunActivationDeadline(intent.kind),
    };
    this.started = true;
    return this.pending;
  }

  recordActivation(activation: FirstRunActivation | null, result: ModelSetupWizardResult): void {
    if (!activation) {
      return;
    }
    // Generic errors can follow committed settings; only proven rejection or
    // non-admission permits replacement setup.
    if (
      result.status === "cancelled" ||
      result.status === "not-admitted" ||
      (result.status === "error" &&
        result.activationRejection?.disposition === "rejected-before-promotion")
    ) {
      // Retiring the receipt must not discard an active, definitive failure.
      if (this.ownsActivation(activation)) {
        activation.outcome = "rejected";
      }
      clearFirstRunActivationReceipt(activation.receipt);
      if (this.pending === activation) {
        this.pending = null;
      }
      return;
    }
    const modelRef = result.status === "done" ? result.modelActivation?.modelRef : undefined;
    if (!modelRef || this.pending !== activation || !this.ownsActivation(activation)) {
      return;
    }
    // Capture the verified target before config refresh can replace the hello
    // and retire the Lit task that otherwise owns this response.
    activation.modelRef = modelRef;
    activation.outcome = "verified";
    activation.receipt = persistFirstRunActivationReceipt(this.host.context(), activation);
  }

  finishActivation(
    result: SystemAgentSetupActivateResult,
    targetId: string,
    refreshError: string | null,
  ): void {
    if (!this.pending || !this.ownsActivation() || !result.ok || !result.modelRef) {
      return;
    }
    if (result.gatewayRestartRequired) {
      this.host.setActivationState({ phase: "testing", targetId });
      this.host.setRefreshWarning(refreshError ?? t("updates.dialog.restarting"));
    } else if (!refreshError) {
      this.completeNavigation();
    }
  }

  get unresolved(): boolean {
    return this.pending !== null;
  }

  async useCurrentModel(): Promise<void> {
    const page = this.host.pageState();
    const pending = this.pending;
    if (
      !pending ||
      page.phase !== "ready" ||
      !page.result.configuredModel ||
      this.host.actionsDisabled()
    ) {
      return;
    }
    // The operator explicitly selects this exact model; do not turn a failed
    // or late verification into permission to adopt whichever model appears next.
    const modelRef = page.result.configuredModel;
    const owner = this.owner(pending.owner.firstRun);
    const outcome = await this.verify();
    if (!this.owns(owner) || this.pending !== pending || !outcome || "error" in outcome) {
      return;
    }
    if (outcome.value.ok && outcome.value.modelRef === modelRef) {
      this.completeNavigation();
    } else if (outcome.value.ok) {
      this.showUnresolved();
    }
  }

  // Equivalent router data can be republished mid-activation. The mounted
  // lifecycle and mode/connection changes, not that object, own this generation.
  private owner(firstRun: boolean): FirstRunOwner {
    const connection = captureModelSetupConnection(this.host.context(), firstRun);
    return {
      generation: this.generation,
      firstRun,
      connectionRevision: connection.connectionRevision,
      recoveryScope: connection.recoveryScope,
      connection,
    };
  }

  private clearPending(): void {
    this.pending = null;
    clearFirstRunActivationReceipt();
  }

  ownsActivation(activation: FirstRunActivation | null = this.pending): boolean {
    if (!activation) {
      return !this.host.routeData()?.firstRun;
    }
    if (!this.owns(activation.owner)) {
      return false;
    }
    if (activation.outcome === "rejected") {
      return this.pending === null;
    }
    // Validation may synchronously notify subscribers and retire pending. Check
    // the captured operation, never reread a nullable or replacement receipt.
    return (
      this.pending === activation &&
      (!activation.receipt ||
        readFirstRunActivationReceipt(this.host.context(), activation.receipt) !== null) &&
      Date.now() < activation.deadlineMs
    );
  }

  async verify(): Promise<SetupOutcome<SystemAgentSetupVerifyResult>> {
    const routeData = this.host.routeData();
    if (!routeData) {
      return undefined;
    }
    const owner = this.owner(routeData.firstRun);
    const pending = this.pending;
    const outcome = await this.host.verify();
    if (!this.owns(owner) || !outcome) {
      return undefined;
    }
    if (this.pending !== pending || (pending && !this.ownsActivation(pending))) {
      this.host.setVerifyState({ phase: "idle" });
      return undefined;
    }
    this.host.setVerifyState(
      "error" in outcome
        ? { phase: "failed", status: "unknown", error: formatModelSetupError(outcome.error) }
        : mapVerifyResult(outcome.value),
    );
    return outcome;
  }

  continueSetup(): void {
    if (!this.pending) {
      this.host.context().navigate("chat");
    } else if (this.pending.outcome === "verified" && this.ownsActivation()) {
      this.completeNavigation();
    }
  }

  private completeNavigation(): void {
    this.clearPending();
    this.host.setRefreshWarning(null);
    this.host.context().navigate("custodian", { search: "?onboarding=1" });
  }

  private showUnresolved(): void {
    this.host.setRefreshWarning(null);
    this.host.setVerifyState({
      phase: "failed",
      status: "unknown",
      error: `${t("modelSetup.errors.activationFailed")} ${this.pending?.modelRef ?? ""}`.trim(),
    });
  }

  private reset(): void {
    this.generation += 1;
    this.started = false;
  }

  private owns(owner: FirstRunOwner): boolean {
    const context = this.host.context();
    const snapshot = context.gateway.snapshot;
    return (
      owner.generation === this.generation &&
      owner.connectionRevision === context.gateway.connectionRevision &&
      owner.recoveryScope === (snapshot.hello?.auth?.recoveryScope ?? null) &&
      owner.firstRun === this.host.routeData()?.firstRun &&
      snapshot.phase === "connected" &&
      snapshot.client === owner.connection.client &&
      snapshot.hello === owner.connection.hello &&
      context.agentSelection.state.selectedId === owner.connection.agentId
    );
  }

  private async run(owner: FirstRunOwner, detection: SystemAgentSetupDetectResult): Promise<void> {
    if (detection.setupComplete && detection.configuredModel) {
      if (this.pending && detection.configuredModel !== this.pending.modelRef) {
        this.showUnresolved();
        return;
      }
      const outcome = await this.verify();
      if (!this.owns(owner) || !outcome || "error" in outcome) {
        return;
      }
      if (outcome.value.ok) {
        this.finishVerified(outcome.value.modelRef);
      }
    }
  }

  private finishVerified(modelRef: string): void {
    if (!this.pending) {
      this.host.context().navigate("chat");
    } else if (this.pending.modelRef === modelRef) {
      this.completeNavigation();
    } else {
      this.showUnresolved();
    }
  }
}
