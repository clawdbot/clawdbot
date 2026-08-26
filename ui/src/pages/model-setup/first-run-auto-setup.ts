import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { ModelSetupDetectionConnection } from "./detect-cache.ts";
import type {
  ModelSetupActivationTaskResult,
  ModelSetupTaskResult,
} from "./model-setup-task-result.ts";
import {
  activationTargetId,
  type ModelSetupActivationState,
  type ModelSetupPageState,
  type ModelSetupVerifyState,
} from "./state.ts";

export type ModelSetupRouteData = {
  state: ModelSetupPageState;
  connection: ModelSetupDetectionConnection;
  firstRun: boolean;
};

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type SetupOutcome<T> = ModelSetupTaskResult<T> | undefined;

type FirstRunOwner = {
  generation: number;
  routeData: ModelSetupRouteData;
  connection: ModelSetupDetectionConnection;
};

type PendingRestart = {
  routeData: ModelSetupRouteData;
  connection: ModelSetupDetectionConnection;
  modelRef: string;
};

type FirstRunAutoSetupHost = {
  context: () => ApplicationContext;
  routeData: () => ModelSetupRouteData | undefined;
  pageState: () => ModelSetupPageState;
  actionsDisabled: () => boolean;
  canUseSetup: (client: GatewayBrowserClient | null) => boolean;
  canVerify: (client: GatewayBrowserClient | null) => boolean;
  activationSuccessful: () => boolean;
  verify: () => Promise<SetupOutcome<SystemAgentSetupVerifyResult>>;
  activate: (
    candidate: Candidate,
    targetId: string,
  ) => Promise<SetupOutcome<ModelSetupActivationTaskResult>>;
  setVerifyState: (state: ModelSetupVerifyState) => void;
  setActivationState: (state: ModelSetupActivationState) => void;
  setRefreshWarning: (warning: string | null) => void;
};

export class FirstRunAutoSetup {
  private generation = 0;
  private started = false;
  private readonly attempts = new Set<string>();
  private readyConnection: ModelSetupDetectionConnection | null = null;
  private pendingRestart: PendingRestart | null = null;

  constructor(private readonly host: FirstRunAutoSetupHost) {}

  setReadyConnection(connection: ModelSetupDetectionConnection | null): void {
    this.readyConnection = connection;
  }

  routeChanged(): void {
    this.reset();
    this.readyConnection = null;
    this.pendingRestart = null;
  }

  connectionChanged(connection: ModelSetupDetectionConnection): void {
    this.reset();
    this.readyConnection = null;
    if (
      this.pendingRestart &&
      (connection.client !== this.pendingRestart.connection.client ||
        connection.agentId !== this.pendingRestart.connection.agentId)
    ) {
      this.pendingRestart = null;
    }
  }

  retryDetection(): void {
    if (this.host.routeData()?.firstRun && !this.host.actionsDisabled()) {
      this.pendingRestart = null;
      this.host.setRefreshWarning(null);
      this.reset();
    }
  }

  dispose(): void {
    this.routeChanged();
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
    const configured = pageState.result.setupComplete && pageState.result.configuredModel;
    if (this.pendingRestart && !configured) {
      this.started = true;
      this.host.setRefreshWarning(
        `${t("modelSetup.errors.activationFailed")} ${this.pendingRestart.modelRef}. ${t("modelSetup.checkAgain")}.`,
      );
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
    if (!configured && isGatewayMethodAdvertised(snapshot, "openclaw.setup.activate") !== true) {
      return;
    }
    this.started = true;
    void this.run(
      {
        generation: this.generation,
        routeData,
        connection: {
          client: snapshot.client,
          hello: snapshot.hello,
          agentId: context.agentSelection.state.selectedId,
        },
      },
      pageState.result,
    );
  }

  private reset(): void {
    this.generation += 1;
    this.started = false;
    this.attempts.clear();
  }

  private owns(owner: FirstRunOwner): boolean {
    const context = this.host.context();
    const snapshot = context.gateway.snapshot;
    return (
      owner.generation === this.generation &&
      owner.routeData === this.host.routeData() &&
      owner.routeData.firstRun &&
      snapshot.phase === "connected" &&
      snapshot.client === owner.connection.client &&
      snapshot.hello === owner.connection.hello &&
      context.agentSelection.state.selectedId === owner.connection.agentId
    );
  }

  private async run(owner: FirstRunOwner, detection: SystemAgentSetupDetectResult): Promise<void> {
    if (detection.setupComplete && detection.configuredModel) {
      if (this.pendingRestart && detection.configuredModel !== this.pendingRestart.modelRef) {
        this.failPendingActivation(this.pendingRestart);
        return;
      }
      const outcome = await this.host.verify();
      if (!this.owns(owner) || !outcome || "error" in outcome) {
        return;
      }
      if (outcome.value.ok) {
        this.finishVerified(owner, outcome.value.modelRef);
        return;
      }
    }
    const context = this.host.context();
    if (isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.setup.activate") !== true) {
      return;
    }
    for (const candidate of detection.candidates) {
      const targetId = activationTargetId(candidate.kind, candidate.modelRef);
      if (
        candidate.credentials === false ||
        (detection.configuredModel &&
          (candidate.kind === "existing-model" ||
            candidate.modelRef === detection.configuredModel)) ||
        this.attempts.has(targetId)
      ) {
        continue;
      }
      if (!this.owns(owner)) {
        return;
      }
      this.attempts.add(targetId);
      // Activation can commit before its response; retain exact intent across
      // the same Gateway's reconnect without repeating an ambiguous mutation.
      this.pendingRestart = {
        routeData: owner.routeData,
        connection: owner.connection,
        modelRef: candidate.modelRef,
      };
      const outcome = await this.host.activate(candidate, targetId);
      if (!this.owns(owner) || !outcome || "error" in outcome) {
        return;
      }
      if (!outcome.value.result.ok) {
        // A rejected transport may still commit; only a definitive Gateway
        // failure permits dispatching another provider activation.
        this.pendingRestart = null;
        continue;
      }
      if (outcome.value.result.gatewayRestartRequired && outcome.value.result.modelRef) {
        this.pendingRestart.modelRef = outcome.value.result.modelRef;
        // Keep the completed attempt closed until a replacement hello owns
        // detection and exact-model verification; the old socket is unsafe.
        this.host.setActivationState({
          phase: "testing",
          targetId,
          modelRef: candidate.modelRef,
        });
        this.host.setRefreshWarning(outcome.value.refreshError ?? t("updates.dialog.restarting"));
        return;
      }
      this.pendingRestart = null;
      if (this.host.activationSuccessful() && !outcome.value.refreshError) {
        context.navigate("custodian", { search: "?onboarding=1" });
      }
      return;
    }
  }

  private failPendingActivation(pending: PendingRestart): void {
    this.pendingRestart = null;
    this.host.setRefreshWarning(null);
    this.host.setVerifyState({
      phase: "failed",
      status: "unknown",
      error: `${t("modelSetup.errors.activationFailed")} ${pending.modelRef}`,
    });
  }

  private finishVerified(owner: FirstRunOwner, modelRef: string): void {
    const pending = this.pendingRestart;
    if (!pending) {
      this.host.context().navigate("chat");
      return;
    }
    if (
      pending.routeData !== owner.routeData ||
      pending.connection.client !== owner.connection.client ||
      pending.connection.agentId !== owner.connection.agentId ||
      pending.connection.hello === owner.connection.hello ||
      pending.modelRef !== modelRef
    ) {
      this.failPendingActivation(pending);
      return;
    }
    this.pendingRestart = null;
    this.host.setRefreshWarning(null);
    this.host.context().navigate("custodian", { search: "?onboarding=1" });
  }
}
