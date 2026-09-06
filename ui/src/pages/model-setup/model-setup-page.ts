import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  captureModelSetupConnection,
  FirstRunSetup,
  type ModelSetupConnection,
  type ModelSetupRouteData,
} from "./first-run-setup.ts";
import { ModelSetupIconLoader } from "./model-setup-icon-loader.ts";
import {
  captureModelSetupResult,
  formatModelSetupError,
  type ModelSetupTaskResult,
} from "./model-setup-task-result.ts";
import {
  findPreparedModelCandidate,
  type ModelSetupPrepareOption,
  providerAutoSetupKind,
} from "./prepare-options.ts";
import { detectModelSetup, verifyModelSetup } from "./rpc.ts";
import {
  activationTargetId,
  initialWizardValue,
  mapActivationResult,
  type ModelSetupActivationState,
  type ModelSetupPageState,
  type ModelSetupVerifyState,
  type ModelSetupWizardState,
} from "./state.ts";
import { renderModelSetup, revealModelSetupFeedback } from "./view.ts";
import { ModelSetupWizardRunner, type ModelSetupWizardCompletion } from "./wizard-runner.ts";

export type { ModelSetupRouteData } from "./first-run-setup.ts";
export { resumeFirstRunActivation } from "./first-run-activation-receipt.ts";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];

export class ModelSetupPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelSetupRouteData | undefined;

  @state() private pageState: ModelSetupPageState = { phase: "loading" };
  @state() private activationState: ModelSetupActivationState = { phase: "idle" };
  @state() private verifyState: ModelSetupVerifyState = { phase: "idle" };
  @state() private wizardState: ModelSetupWizardState = { phase: "idle" };
  @state() private wizardMode: "auth" | "prepare" | "activate" = "auth";
  @state() private wizardValue: unknown;
  @state() private manualProviderId = "";
  @state() private manualApiKey = "";
  @state() private manualError: string | null = null;
  @state() private moreSignInOpen = false;
  @state() private nativeSessionCatalogsEnabled = false;
  @state() private iconUrls: Record<string, string> = {};
  @state() private setupRefreshWarning: string | null = null;
  @state() private cancellationNotice: string | null = null;

  private observedConnection: ReturnType<typeof captureModelSetupConnection> | null = null;
  private pendingPrepareOption: ModelSetupPrepareOption | null = null;
  private wizardMutationGeneration = 0;
  private wizardMutationActive = false;
  private wizardReturnFocus: HTMLElement | null = null;
  private readonly firstRun = new FirstRunSetup({
    context: () => this.context,
    routeData: () => this.routeData,
    pageState: () => this.pageState,
    actionsDisabled: () => this.actionsDisabled(),
    canUseSetup: (client) => this.canUseSetup(client),
    canVerify: (client) => this.canVerify(client),
    verify: () => this.verifyConnection().then(() => this.verifyTask.value),
    setVerifyState: (next) => (this.verifyState = next),
    setActivationState: (next) => (this.activationState = next),
    setRefreshWarning: (warning) => (this.setupRefreshWarning = warning),
  });
  private readonly iconLoader = new ModelSetupIconLoader(
    () => this.context,
    () => this.pageState,
    (urls) => (this.iconUrls = urls),
  );
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.synchronizeGateway(gateway.snapshot),
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => this.synchronizeGateway(this.context.gateway.snapshot),
    )
    .watch(
      () => this.firstRun,
      (firstRun, notify) => firstRun.subscribe(notify),
    );
  private readonly wizard = new ModelSetupWizardRunner({
    getClient: () => this.context?.gateway.snapshot.client ?? null,
    getAgentId: () => this.context?.agentSelection.state.selectedId ?? null,
    onChange: (next) => {
      if (next.phase !== "starting" && next.phase !== "done") {
        this.activationState = { phase: "idle" };
      }
      const previousStep = this.wizardState.phase === "step" ? this.wizardState.step.id : null;
      this.wizardState =
        next.phase === "step" && this.wizardMutationActive ? { ...next, busy: true } : next;
      if (next.phase === "step" && next.step.id !== previousStep) {
        this.wizardValue = initialWizardValue(next.step);
      } else if (next.phase === "idle") {
        this.wizardValue = undefined;
        this.cancellationNotice = null;
      }
    },
    onStart: (method, intent) => {
      if (method === "openclaw.setup.prepare.start") {
        return undefined;
      }
      const activation = this.firstRun.beginActivation(intent ?? { kind: "provider-auth" });
      return (result, admissionRejected) => {
        if (result.status === "done" && result.modelActivation) {
          this.firstRun.recordActivation(activation, { ok: true, ...result.modelActivation });
        } else if (
          result.status === "cancelled" ||
          admissionRejected ||
          (result.status === "error" &&
            result.activationRejection?.disposition === "rejected-before-promotion")
        ) {
          // A terminal error can follow committed settings. Only the owning
          // Gateway's rejection or non-admission makes replacement setup safe.
          this.firstRun.recordActivation(activation, { ok: false });
          this.requestUpdate();
        }
        return () => this.firstRun.ownsActivation(activation);
      };
    },
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
  });

  private readonly detectTask = new Task<
    readonly [GatewayBrowserClient | null, string | null, object | null],
    ModelSetupTaskResult<SystemAgentSetupDetectResult> & {
      agentId: string | null;
      hello: ModelSetupConnection["hello"];
      token: object;
    }
  >(this, {
    autoRun: false,
    args: () => {
      const client = this.context?.gateway.snapshot.client ?? null;
      return [
        this.canUseSetup(client) ? client : null,
        this.context?.agentSelection.state.selectedId ?? null,
        null,
      ] as const;
    },
    task: async ([client, agentId, token], { signal }) => {
      if (!client || !token) {
        return initialState;
      }
      const hello = this.context.gateway.snapshot.hello;
      return {
        ...(await captureModelSetupResult(client, () =>
          detectModelSetup(client, agentId ?? undefined, signal),
        )),
        agentId,
        hello,
        token,
      };
    },
    onComplete: (outcome) => {
      if (
        this.context.gateway.snapshot.client !== outcome.client ||
        this.context.gateway.snapshot.hello !== outcome.hello ||
        this.context.agentSelection.state.selectedId !== outcome.agentId
      ) {
        return;
      }
      if ("error" in outcome) {
        this.firstRun.setReadyConnection(null);
        this.pageState = { phase: "detect-error", message: formatModelSetupError(outcome.error) };
        return;
      }
      this.firstRun.setReadyConnection({
        client: outcome.client,
        hello: outcome.hello,
        agentId: outcome.agentId,
      });
      this.pageState = { phase: "ready", result: outcome.value };
      if (
        !outcome.value.manualProviders.some((provider) => provider.id === this.manualProviderId)
      ) {
        this.manualProviderId = "";
      }
    },
  });

  private readonly verifyTask = new Task<
    readonly [GatewayBrowserClient | null, string | null],
    ModelSetupTaskResult<Awaited<ReturnType<typeof verifyModelSetup>>>
  >(this, {
    autoRun: false,
    args: () => [null, null],
    task: async ([client, agentId], { signal }) =>
      client
        ? captureModelSetupResult(client, () =>
            verifyModelSetup(client, agentId ?? undefined, signal),
          )
        : initialState,
  });

  override disconnectedCallback() {
    this.firstRun.dispose();
    this.resetActivity();
    this.observedConnection = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate() {
    this.synchronizeGateway(this.context.gateway.snapshot);
  }

  override updated(changed: PropertyValues) {
    // Lit can finish queued updates after detachment; teardown must not rearm
    // detection, icon fetches, or first-run activation on an abandoned page.
    if (!this.isConnected) {
      return;
    }
    if (changed.has("activationState") && this.activationState.phase !== "idle") {
      revealModelSetupFeedback(this.renderRoot);
    }
    if (this.wizardState.phase !== "idle") {
      this.querySelector("openclaw-modal-dialog")?.setReturnFocusTarget(this.wizardReturnFocus);
    }
    this.iconLoader.reconcile();
    this.firstRun.start();
  }

  private synchronizeGateway(snapshot: ApplicationContext["gateway"]["snapshot"]): void {
    const routeData = this.routeData;
    if (!this.isConnected || !routeData) {
      return;
    }
    const previous = this.observedConnection;
    const connection = captureModelSetupConnection(
      this.context,
      routeData.firstRun,
      previous?.recoveryScope,
    );
    if (
      previous &&
      connection.client === previous.client &&
      connection.hello === previous.hello &&
      connection.agentId === previous.agentId &&
      connection.connected === previous.connected &&
      connection.firstRun === previous.firstRun &&
      connection.connectionRevision === previous.connectionRevision &&
      connection.recoveryScope === previous.recoveryScope
    ) {
      return;
    }
    this.observedConnection = connection;
    const authenticatedOwnerLost =
      previous &&
      (!connection.recoveryScope || connection.recoveryScope !== previous.recoveryScope);
    const ownerChanged =
      previous &&
      (connection.agentId !== previous.agentId ||
        connection.firstRun !== previous.firstRun ||
        connection.connectionRevision !== previous.connectionRevision ||
        authenticatedOwnerLost);
    const setupAuthorityLost =
      connection.connected && !hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (authenticatedOwnerLost || setupAuthorityLost) {
      // A changed identity or reduced authority cannot cancel the old wizard.
      // Retire local handles and expose the existing access/recovery state.
      this.wizard.close({ retireOwner: true });
    }
    if (ownerChanged) {
      this.nativeSessionCatalogsEnabled = false;
      this.manualProviderId = "";
      this.manualApiKey = "";
      this.manualError = null;
    }
    const sameWizardOwner = previous && Boolean(connection.recoveryScope) && !ownerChanged;
    if (sameWizardOwner && this.wizard.hasAdmittedSession) {
      this.wizardMutationGeneration += 1;
      this.wizardMutationActive = false;
      this.wizard.suspend();
      if (this.canUseSetup(connection.client)) {
        this.firstRun.reconnectActivation(connection);
        void this.runWizardMutation(() => this.wizard.resume());
      }
      return;
    }
    // The router refreshes cached loader objects during the same visit. Only
    // a mode change or mounted/connection lifecycle can retire setup ownership.
    if (connection.firstRun !== previous?.firstRun) {
      this.firstRun.routeChanged();
    } else {
      this.firstRun.connectionChanged(connection);
    }
    this.resetActivity();
    this.pageState = { phase: "loading" };
    if (this.canUseSetup(connection.client)) {
      void this.detect();
    }
  }

  private resetActivity(): void {
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    void this.detectTask.run([null, null, null]);
    this.activationState = { phase: "idle" };
    this.resetVerify();
    this.iconLoader.reset();
    this.pendingPrepareOption = null;
    void this.wizard.cancel();
  }

  private canUseSetup(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return Boolean(
      client &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true,
    );
  }

  private async detect(): Promise<SystemAgentSetupDetectResult | null> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client)) {
      return null;
    }
    this.resetVerify();
    this.pageState = { phase: "loading" };
    const token = {};
    await this.detectTask.run([client, this.context.agentSelection.state.selectedId, token]);
    const outcome = this.detectTask.value;
    return outcome?.token === token && "value" in outcome ? outcome.value : null;
  }

  private canVerify(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return (
      this.canUseSetup(client) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.verify") === true
    );
  }

  private resetVerify(): void {
    this.verifyState = { phase: "idle" };
    void this.verifyTask.run([null, null]);
  }

  private async verifyConnection(): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canVerify(client) || this.actionsDisabled()) {
      return;
    }
    this.verifyState = { phase: "checking" };
    await this.verifyTask.run([client, this.context.agentSelection.state.selectedId]);
  }

  private async activate(params: SystemAgentSetupActivateParams, targetId: string): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client) || this.actionsDisabled() || this.firstRun.unresolved) {
      return;
    }
    this.manualError = null;
    this.activationState = { phase: "testing", targetId };
    this.pendingPrepareOption = null;
    this.wizardMode = "activate";
    await this.runWizardMutation(() =>
      this.wizard.activate({ ...params, ...this.nativeSessionCatalogPreference() }, targetId),
    );
  }

  private nativeSessionCatalogPreference(): { nativeSessionCatalogsEnabled?: boolean } {
    return this.pageState.phase === "ready" &&
      this.pageState.result.nativeSessionCatalogPreferenceRequired === true
      ? { nativeSessionCatalogsEnabled: this.nativeSessionCatalogsEnabled }
      : {};
  }

  private finishActivation(
    result: SystemAgentSetupActivateResult,
    targetId: string,
    refreshError: string | null,
  ): void {
    this.activationState = mapActivationResult({
      result,
      targetId,
      fallbackError: t("modelSetup.errors.activationFailed"),
      restartWarning: t("labsPage.restartRequired"),
      refreshWarning: refreshError,
    });
    if (this.activationState.phase === "success") {
      this.manualApiKey = "";
    }
    this.firstRun.finishActivation(result, targetId, refreshError);
  }

  private activateCandidate(candidate: Candidate): void {
    void this.activate(
      { kind: candidate.kind, modelRef: candidate.modelRef },
      activationTargetId(candidate.kind, candidate.modelRef),
    );
  }

  private connectManual(): void {
    const apiKey = this.manualApiKey.trim();
    if (!this.manualProviderId || !apiKey) {
      this.manualError = t("modelSetup.manual.required");
      return;
    }
    void this.activate(
      { kind: "api-key", authChoice: this.manualProviderId, apiKey },
      `manual:${this.manualProviderId}`,
    );
  }

  private selectManualProvider(providerId: string): void {
    if (providerId !== this.manualProviderId) {
      this.manualApiKey = "";
    }
    this.manualProviderId = providerId;
    this.manualError = null;
  }

  private async useManualProvider(providerId: string): Promise<void> {
    this.selectManualProvider(providerId);
    await this.updateComplete;
    const input = this.renderRoot.querySelector<HTMLInputElement>(
      '.model-setup__manual input[type="password"]',
    );
    input?.scrollIntoView?.({ block: "center", behavior: resolveScrollBehavior() });
    input?.focus();
  }

  private async handleWizardDone({
    startMethod,
    preparedModelRef,
    activationTargetId: targetId,
    modelActivation,
    isCurrent,
  }: ModelSetupWizardCompletion): Promise<void> {
    const prepareOption =
      startMethod === "openclaw.setup.prepare.start" ? this.pendingPrepareOption : null;
    const nativeSessionCatalogPreference = this.nativeSessionCatalogPreference();
    this.pendingPrepareOption = null;
    if (prepareOption && preparedModelRef) {
      const kind = providerAutoSetupKind(prepareOption.id);
      this.wizard.close();
      void this.activate(
        { kind, modelRef: preparedModelRef, ...nativeSessionCatalogPreference },
        activationTargetId(kind, preparedModelRef),
      );
      return;
    }
    if (startMethod !== "openclaw.setup.prepare.start") {
      if (isCurrent?.() === false) {
        this.wizard.close();
        return;
      }
      if (!modelActivation) {
        this.wizard.fail(
          t(
            startMethod === "openclaw.setup.activate.start"
              ? "modelSetup.errors.activationFailed"
              : "modelSetup.wizard.notComplete",
          ),
        );
        return;
      }
      this.wizard.close();
      this.finishActivation(
        { ok: true, ...modelActivation },
        targetId ?? "provider-auth",
        this.setupRefreshWarning,
      );
      return;
    }
    const result = await this.detect();
    if (!result) {
      this.wizard.fail(t("modelSetup.errors.requestFailed"));
      return;
    }
    if (prepareOption) {
      // Provider setup can persist a model before the live activation check.
      // Keep that unverified config out of the ready surface until activation succeeds.
      this.pageState = {
        phase: "ready",
        result: { ...result, configuredModel: undefined, setupComplete: false },
      };
      const candidate = findPreparedModelCandidate(result, prepareOption.id);
      if (!candidate) {
        this.wizard.fail(
          t("modelSetup.prepare.providerNotReady", { provider: prepareOption.label }),
        );
        return;
      }
      this.wizard.close();
      void this.activate(
        { kind: candidate.kind, modelRef: candidate.modelRef, ...nativeSessionCatalogPreference },
        activationTargetId(candidate.kind, candidate.modelRef),
      );
      return;
    }
    this.wizard.close();
  }

  private closeWizard(): void {
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    this.pendingPrepareOption = null;
    this.activationState = { phase: "idle" };
    this.wizard.close();
  }

  private async runWizardMutation(
    task: () => Promise<ModelSetupWizardCompletion | null>,
  ): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (
      this.wizardMutationActive ||
      !this.canUseSetup(client) ||
      (this.wizard.state.phase === "idle" && this.firstRun.unresolved)
    ) {
      return;
    }
    if (this.wizard.state.phase === "idle") {
      // Disabling the initiating control can blur it before the modal opens.
      const active = this.ownerDocument.activeElement;
      this.wizardReturnFocus =
        active instanceof HTMLElement && this.contains(active) ? active : null;
    }
    const generation = ++this.wizardMutationGeneration;
    this.wizardMutationActive = true;
    this.requestUpdate();
    try {
      const mutation = await this.context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error("Connection changed before model setup continued.");
          }
          return await task();
        },
        {
          canDispatch: () =>
            generation === this.wizardMutationGeneration &&
            this.context.gateway.snapshot.client === client &&
            this.canUseSetup(client),
          dispatchError: t("modelSetup.errors.requestFailed"),
        },
      );
      if (generation !== this.wizardMutationGeneration) {
        if (mutation.ok && !mutation.refresh.ok && this.isConnected) {
          this.setupRefreshWarning = mutation.refresh.error;
        }
        if (this.isConnected && this.canUseSetup(this.context.gateway.snapshot.client)) {
          void this.detect();
        }
        return;
      }
      if (!mutation.ok) {
        this.wizard.fail(mutation.error);
        return;
      }
      this.setupRefreshWarning = mutation.refresh.ok ? null : mutation.refresh.error;
      const completion = mutation.value;
      if (completion) {
        // The coordinated wizard action has settled; follow-up activation owns
        // its own mutation lane and must not be blocked by the prior busy flag.
        this.wizardMutationActive = false;
        await this.handleWizardDone(completion);
      } else if (this.wizardState.phase === "step" && this.wizardState.busy) {
        this.wizardState = { ...this.wizardState, busy: false };
      }
    } catch (error) {
      if (generation === this.wizardMutationGeneration) {
        this.wizard.fail(formatModelSetupError(error));
      }
    } finally {
      if (generation === this.wizardMutationGeneration) {
        this.wizardMutationActive = false;
        this.requestUpdate();
      }
    }
  }

  private async cancelWizard(): Promise<void> {
    const generation = this.wizardMutationGeneration;
    this.cancellationNotice = null;
    try {
      const outcome = await this.wizard.requestCancellation();
      if (generation !== this.wizardMutationGeneration) {
        return;
      }
      if (outcome === "running") {
        this.cancellationNotice = t("modelSetup.wizard.finishingStep");
        return;
      }
      if (outcome !== "cancelled") {
        return;
      }
      this.wizardMutationGeneration += 1;
      this.wizardMutationActive = false;
      this.pendingPrepareOption = null;
      this.activationState = { phase: "idle" };
    } catch (error) {
      if (
        generation === this.wizardMutationGeneration &&
        (this.wizardState.phase === "starting" || this.wizardState.phase === "step")
      ) {
        this.cancellationNotice = t("modelSetup.wizard.cancelFailed", {
          error: formatModelSetupError(error),
        });
      }
    }
  }

  private actionsDisabled(): boolean {
    return (
      this.activationState.phase === "testing" ||
      this.verifyState.phase === "checking" ||
      this.wizardMutationActive ||
      (this.wizardState.phase !== "idle" &&
        this.wizardState.phase !== "error" &&
        this.wizardState.phase !== "cancelled")
    );
  }

  override render() {
    const snapshot = this.context.gateway.snapshot;
    const canAdmin = hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    const gatewayTooOld =
      snapshot.phase === "connected" &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true;
    const canVerify =
      canAdmin &&
      !gatewayTooOld &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.verify") === true;
    return renderModelSetup({
      page: this.firstRun.visiblePageState(this.verifyState.phase === "ok"),
      activation: this.activationState,
      verify: this.verifyState,
      wizard: this.wizardState,
      wizardMode: this.wizardMode,
      wizardValue: this.wizardValue,
      canAdmin,
      canVerify,
      canPrepare:
        canAdmin &&
        !gatewayTooOld &&
        isGatewayMethodAdvertised(snapshot, "openclaw.setup.prepare.start") === true,
      modelConfigured: readSessionDefaults(snapshot)?.modelConfigured === true,
      gatewayTooOld,
      refreshWarning: this.setupRefreshWarning,
      cancellationNotice: this.cancellationNotice,
      activationUnresolved: this.firstRun.unresolved,
      onUseCurrentModel: () => void this.firstRun.useCurrentModel(),
      actionsDisabled: this.actionsDisabled(),
      manualProviderId: this.manualProviderId,
      manualApiKey: this.manualApiKey,
      manualError: this.manualError,
      moreSignInOpen: this.moreSignInOpen,
      nativeSessionCatalogsEnabled: this.nativeSessionCatalogsEnabled,
      onNativeSessionCatalogsChange: (enabled) => (this.nativeSessionCatalogsEnabled = enabled),
      firstRun: this.routeData?.firstRun === true,
      iconUrls: this.iconUrls,
      onDetect: () => {
        if (this.firstRun.retryDetection()) {
          void this.detect();
        }
      },
      onVerify: () => void this.firstRun.verify(),
      onActivateCandidate: (candidate) => this.activateCandidate(candidate),
      onStartAuth: (option) => {
        this.pendingPrepareOption = null;
        this.wizardMode = "auth";
        void this.runWizardMutation(() =>
          this.wizard.start(
            option.id,
            "openclaw.setup.auth.start",
            this.nativeSessionCatalogPreference(),
          ),
        );
      },
      onStartPrepare: (option: ModelSetupPrepareOption) => {
        this.pendingPrepareOption = option;
        this.wizardMode = "prepare";
        void this.runWizardMutation(() =>
          this.wizard.start(option.id, "openclaw.setup.prepare.start"),
        );
      },
      onManualProviderChange: (providerId) => this.selectManualProvider(providerId),
      onUseManualProvider: (providerId) => void this.useManualProvider(providerId),
      onManualApiKeyChange: (apiKey) => {
        this.manualApiKey = apiKey;
        this.manualError = null;
      },
      onManualConnect: () => this.connectManual(),
      onMoreSignInToggle: (open) => (this.moreSignInOpen = open),
      onIconError: (iconUrl) => this.iconLoader.invalidate(iconUrl),
      onOpenChat: () => this.firstRun.continueSetup(),
      onSuccessClose: () => {
        this.activationState = { phase: "idle" };
        void this.detect();
      },
      onWizardValueChange: (value) => (this.wizardValue = value),
      onWizardAnswer: (value, includeValue) =>
        void this.runWizardMutation(() => this.wizard.answer(value, includeValue)),
      onWizardCancel: () => void this.cancelWizard(),
      onWizardClose: () => this.closeWizard(),
    });
  }
}

if (!customElements.get("openclaw-model-setup-page")) {
  customElements.define("openclaw-model-setup-page", ModelSetupPage);
}
